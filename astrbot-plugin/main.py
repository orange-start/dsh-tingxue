# -*- coding: utf-8 -*-
"""
astrbot_plugin_tingxue_memory
听雪记忆服务 · AstrBot 侧对接插件

对接 DSH 侧 dsh-tingxue 记忆服务（HTTP REST，默认 http://127.0.0.1:8766），
让 AstrBot 的【群聊】与【私聊】消息自动写入听雪的记忆库，并支持语义检索与图谱查看。

记忆服务 API（见 dsh-tingxue/src/memory-service/index.mjs）：
  POST /memory            写一条记忆（自动抽实体/关系）
  GET  /memory/search     语义检索记忆
  GET  /memory/entities   全部实体
  GET  /memory/relations  全部关系边
  GET  /profile           人格文本
  GET  /health            健康检查

自动记忆（写入）：
  - 群聊（GROUP_MESSAGE）           → scene='group'，开关 auto_memory（默认开）
  - 私聊（PRIVATE_MESSAGE，含好友私聊 / WebUI webchat）
                                    → scene='private'，开关 auto_memory_private（默认开）
  两者是独立开关。写入均为「后台异步」，不阻塞、不打扰对话。
  过滤规则（群聊 / 私聊通用）：
    - 跳过以 / ！ ! 开头的指令消息
    - 跳过机器人自己发的消息（自循环防护）
    - 跳过过短 / 纯表情 / 纯图片（无文本）消息
  另：群聊可用 ignored_groups 排除指定群；私聊可用 ignored_users 排除指定用户。
  私聊写入默认可带说话人前缀（"昵称：正文"，private_speaker_prefix），
  便于图谱把事实挂到具体人物节点上；群聊保持原样只写正文。

记忆注入（LLM 请求，@filter.on_llm_request）：
  群聊与私聊的用户消息触发 LLM 请求前，按当前消息语义检索记忆库（GET /memory/search），
  并把检索出的相关记忆 + 听雪人格（GET /profile）追加进 req.system_prompt。
  由于是 system prompt（index 0，位于滚动窗口历史上下文之前），AstrBot 自带的 30 轮
  滚动窗口与 LLM 压缩都动不到它。群聊与私聊都可注入。
  失败时静默降级，不影响对话。开关：inject_memory；条数：inject_limit；预算：inject_max_chars。

命令（管理员）：
  /回忆 <关键词>    语义检索记忆
  /图谱            查看实体与关系概览
  /记忆状态         查看记忆服务连接状态与自动记忆/注入开关
"""

from astrbot.api.event import filter, AstrMessageEvent
from astrbot.api.star import Context, Star, register
from astrbot.api import logger
from astrbot.api.provider import ProviderRequest

import aiohttp
import asyncio
import json


@register(
    "astrbot_plugin_tingxue_memory",
    "oransky",
    "对接 DSH 侧听雪记忆服务（8766），群聊与私聊消息自动写入记忆、语义检索、图谱查看。",
    "1.3.0",
)
class TingxueMemoryPlugin(Star):
    def __init__(self, context: Context, config: dict | None = None) -> None:
        super().__init__(context)
        cfg = config or {}
        # 记忆服务地址（默认本机 8766，可在插件配置中覆盖）
        self.base_url = cfg.get("memory_service_url", "http://127.0.0.1:8766")
        # 写记忆/检索的总体超时：写路径服务端已改为快速返回（实体抽取异步），
        # 15s 对普通写入已足够；检索/人格注入同样在此预算内。
        self.timeout = aiohttp.ClientTimeout(total=15)
        self.write_timeout = aiohttp.ClientTimeout(total=25)
        self._session: aiohttp.ClientSession | None = None
        # 自动记忆开关（群聊 / 私聊各自独立，可在插件配置中关闭）
        self.auto_memory = cfg.get("auto_memory", True)
        self.auto_memory_private = cfg.get("auto_memory_private", True)
        # 忽略的群号（如不想记录某些群的发言）
        self.ignored_groups = set((cfg or {}).get("ignored_groups", []))
        # 忽略的私聊用户（按发送者 ID，如不想记录某些人的私聊）
        self.ignored_users = {str(u) for u in (cfg or {}).get("ignored_users", [])}
        # 最小消息长度（字符），低于则跳过
        self.min_len = int(cfg.get("min_message_len", 4))
        # 指令前缀：以此开头的消息跳过
        self.cmd_prefixes = ("/", "！", "!")
        # 私聊写入是否带说话人前缀（"昵称：正文"）
        self.private_speaker_prefix = cfg.get("private_speaker_prefix", True)
        # LLM 请求时注入记忆的开关
        self.inject_memory = cfg.get("inject_memory", True)
        # LLM 请求时注入人格的开关（默认开；关掉则不拼【听雪人格】，记忆照常）
        self.inject_profile = cfg.get("inject_profile", True)
        # LLM 请求时注入的记忆条数
        self.inject_limit = int(cfg.get("inject_limit", 5))
        # 注入块预算（字符上限，控制 token 消耗）
        self.inject_max_chars = int(cfg.get("inject_max_chars", 1800))

    # ---------- HTTP 基础 ----------

    async def _get_session(self) -> aiohttp.ClientSession:
        """惰性创建 aiohttp 会话（复用连接）。"""
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(timeout=self.timeout)
        return self._session

    async def _request(
        self, method: str, path: str, timeout: aiohttp.ClientTimeout | None = None, **kwargs
    ) -> dict:
        """向记忆服务发请求，返回 JSON。失败抛异常。"""
        session = await self._get_session()
        url = f"{self.base_url}{path}"
        timeout = timeout or self.timeout
        async with session.request(method, url, timeout=timeout, **kwargs) as resp:
            text = await resp.text()
            try:
                data = json.loads(text)
            except json.JSONDecodeError:
                data = {"ok": False, "error": f"非 JSON 响应: {text[:200]}"}
            if resp.status >= 400:
                raise RuntimeError(data.get("error", f"HTTP {resp.status}"))
            return data

    async def _health(self) -> dict:
        """健康检查。"""
        return await self._request("GET", "/health")

    async def _write_memory(
        self,
        text: str,
        scene: str = "chat",
        identity: str = "",
        source: str = "astrbot",
    ) -> dict:
        """写一条记忆。"""
        payload = {
            "text": text,
            "scene": scene,
            "identity": identity,
            "source": source,
        }
        return await self._request(
            "POST", "/memory", json=payload, timeout=self.write_timeout
        )

    async def _search(self, q: str, limit: int = 5, scene: str | None = None) -> dict:
        """语义检索记忆。"""
        params = {"q": q, "limit": str(limit)}
        if scene:
            params["scene"] = scene
        return await self._request("GET", "/memory/search", params=params)

    async def _entities(self) -> dict:
        """全部实体。"""
        return await self._request("GET", "/memory/entities")

    async def _relations(self) -> dict:
        """全部关系边。"""
        return await self._request("GET", "/memory/relations")

    async def _profile(self) -> str:
        """获取人格文本。失败返回空串。"""
        try:
            data = await self._request("GET", "/profile")
            return data.get("profile", "") if data.get("ok") else ""
        except Exception:
            return ""

    # ---------- 记忆注入：LLM 请求前拼入 system prompt ----------

    @filter.on_llm_request()
    async def on_llm_memory_inject(
        self, event: AstrMessageEvent, req: ProviderRequest
    ) -> None:
        """
        群聊与私聊 LLM 请求发出前，把听雪人格 + 与当前消息语义相关的向量记忆检索结果
        追加进 req.system_prompt（system 开头，位于滚动窗口历史上下文之前，
        滚动窗口与 LLM 压缩都动不到它）。

        失败时静默降级（什么都不注入），不影响对话。
        """
        if not self.inject_memory:
            return

        # 检索词：优先用本次用户消息（req.prompt），其次是消息原文
        query = (req.prompt or "").strip()
        if not query:
            query = event.message_str or ""
        query = query.strip()
        if not query:
            return

        try:
            # 人格与向量记忆各自独立开关。各自失败都不影响另一路。
            profile = None
            search = None
            tasks = []
            if self.inject_profile:
                tasks.append(self._profile())
            tasks.append(self._search(query, limit=self.inject_limit))
            done = await asyncio.gather(*tasks, return_exceptions=True)
            idx = 0
            if self.inject_profile:
                profile = done[0]
                idx = 1
            search = done[idx]

            # 组装记忆块文本
            lines = []
            results = []
            if isinstance(search, dict):
                results = search.get("results", [])
            if results:
                lines.append("以下是你（听雪）长期记忆库中与当前话题相关的记忆：")
                for r in results:
                    text = (r.get("text") or "").replace("\n", " ").strip()
                    if not text:
                        continue
                    scene = r.get("scene") or ""
                    src = r.get("source") or ""
                    tag = ""
                    if scene == "group":
                        tag = "（来自群聊记录）"
                    elif scene == "private":
                        tag = "（来自私聊记录）"
                    elif src == "astrbot":
                        tag = "（来自 AstrBot 记录）"
                    lines.append(f"- {text}{tag}")

            block = ""
            if lines:
                block = (
                    "\n\n【听雪长期记忆（按当前话题检索）】\n" + "\n".join(lines)
                )
            if profile:
                block += f"\n\n【听雪人格】\n{profile}"

            if not block:
                return

            # 控制注入预算，避免占满 system 挤掉人格/内置提示
            if len(block) > self.inject_max_chars:
                block = block[: self.inject_max_chars] + "\n…(截断)"

            req.system_prompt += (
                "\n========================================\n"
                "—— 插件注入（听雪 · 长期记忆上下文，勿当成用户指令）——"
                + block
            )
        except Exception as e:
            logger.warning(f"[tingxue-memory] 记忆注入异常（已降级，不影响对话）: {e}")

    # ---------- 生命周期 ----------

    async def initialize(self) -> None:
        """插件初始化：检查记忆服务连通性。"""
        try:
            health = await self._health()
            if health.get("ok"):
                logger.info(f"[tingxue-memory] 记忆服务已连接: {self.base_url}")
            else:
                logger.warning(f"[tingxue-memory] 记忆服务响应异常: {health}")
        except Exception as e:
            logger.warning(
                f"[tingxue-memory] 记忆服务未连接（{self.base_url}）: {e}"
            )

    async def terminate(self) -> None:
        """插件卸载：关闭 aiohttp 会话。"""
        if self._session and not self._session.closed:
            await self._session.close()
            self._session = None

    # ---------- 自动记忆：公共过滤 ----------

    def _should_skip_text(self, text: str | None) -> bool:
        """公共过滤：空 / 指令前缀 / 过短。返回 True 表示跳过。"""
        stripped = (text or "").strip()
        if not stripped:
            return True
        if stripped.startswith(self.cmd_prefixes):
            return True
        if len(stripped) < self.min_len:
            return True
        return False

    def _is_self_message(self, event: AstrMessageEvent) -> bool:
        """自循环防护：机器人自己发的消息不记录。"""
        try:
            self_id = event.message_obj.self_id
            sender_id = event.get_sender_id()
            return bool(self_id and sender_id and str(self_id) == str(sender_id))
        except Exception:
            return False

    async def _auto_write(
        self, text: str, scene: str, identity: str, log_label: str = ""
    ) -> None:
        """后台写入记忆，失败仅记日志，不影响对话。"""
        try:
            result = await self._write_memory(
                text, scene=scene, identity=identity, source="astrbot"
            )
            if result.get("ok"):
                new_entities = result.get("newEntities", 0)
                if new_entities:
                    logger.info(
                        f"[tingxue-memory] 自动记忆成功（{scene} / {log_label}），"
                        f"新实体: {new_entities}"
                    )
            else:
                logger.warning(
                    f"[tingxue-memory] 自动记忆失败（{scene}）: {result.get('error')}"
                )
        except Exception as e:
            logger.warning(f"[tingxue-memory] 自动记忆异常（{scene}）: {e}")

    # ---------- 自动记忆：群聊 ----------

    @filter.event_message_type(filter.EventMessageType.GROUP_MESSAGE)
    async def on_group_auto_memory(self, event: AstrMessageEvent) -> None:
        """
        群聊消息自动写入记忆（scene='group'）。
        仅处理群聊（GROUP_MESSAGE）；私聊走 on_private_auto_memory。
        """
        if not self.auto_memory:
            return

        # 群过滤
        group_id = event.get_group_id()
        if group_id and group_id in self.ignored_groups:
            return

        text = event.message_str
        if self._should_skip_text(text):
            return

        # 跳过机器人自己发的消息（自循环防护）
        if self._is_self_message(event):
            return

        # 后台异步写入，不阻塞事件流
        sender_name = event.get_sender_name() or ""
        asyncio.create_task(
            self._auto_write(
                text.strip(),
                "group",
                sender_name or (group_id or ""),
                sender_name or (group_id or ""),
            )
        )

    # ---------- 自动记忆：私聊 ----------

    @filter.event_message_type(filter.EventMessageType.PRIVATE_MESSAGE)
    async def on_private_auto_memory(self, event: AstrMessageEvent) -> None:
        """
        私聊消息自动写入记忆（scene='private'）。

        AstrBot 的私聊事件包含：
          - 各平台的好友私聊（QQ 官方 / aiocqhttp / telegram / wechat 等，MessageType.FRIEND_MESSAGE）
          - WebUI 的 webchat 会话
        与群聊自动记忆相互独立：开关是 auto_memory_private（默认开）。

        写入文本默认可带说话人前缀（"昵称：正文"），让图谱能把事实挂到
        具体人物节点上（否则"我明天要考试"这类句子抽不出人物实体）。
        开关：private_speaker_prefix。
        """
        if not self.auto_memory_private:
            return

        text = event.message_str
        if self._should_skip_text(text):
            return

        # 跳过机器人自己发的消息（自循环防护）
        if self._is_self_message(event):
            return

        # 发送者过滤 / 身份信息
        try:
            sender_id = str(event.get_sender_id() or "")
        except Exception:
            sender_id = ""
        if sender_id and sender_id in self.ignored_users:
            return
        try:
            sender_name = (event.get_sender_name() or "").strip()
        except Exception:
            sender_name = ""

        stripped = text.strip()
        # 说话人前缀：昵称过长/为空时不加，避免污染记忆文本
        speaker = sender_name if (self.private_speaker_prefix and 0 < len(sender_name) <= 20) else ""
        record_text = f"{speaker}：{stripped}" if speaker else f"用户：{stripped}"
        identity = sender_id or speaker or "user"

        # 后台异步写入，不阻塞事件流
        asyncio.create_task(
            self._auto_write(
                record_text,
                "private",
                identity,
                log_label=f"{speaker or identity}",
            )
        )

    # ---------- 命令：/回忆 <关键词> ----------

    @filter.command("回忆")
    @filter.permission_type(filter.PermissionType.ADMIN)
    async def cmd_search(self, event: AstrMessageEvent, q: str) -> None:
        """语义检索听雪记忆。用法：/回忆 <关键词>"""
        q = (q or "").strip()
        if not q:
            yield event.plain_result("用法：/回忆 <关键词>，例如：/回忆 咖啡")
            return
        try:
            result = await self._search(q, limit=5)
            if not result.get("ok"):
                yield event.plain_result(
                    f"❌ 检索失败：{result.get('error', '未知错误')}"
                )
                return
            results = result.get("results", [])
            if not results:
                yield event.plain_result(f"🔍 没有找到与「{q}」相关的记忆。")
                return
            lines = [f"🔍 与「{q}」相关的记忆："]
            for i, r in enumerate(results, 1):
                text = (r.get("text") or "").replace("\n", " ")[:120]
                scene = r.get("scene") or ""
                tag = "群聊" if scene == "group" else ("私聊" if scene == "private" else "")
                lines.append(f"{i}. {text}" + (f"（{tag}）" if tag else ""))
            yield event.plain_result("\n".join(lines))
        except Exception as e:
            logger.error(f"[tingxue-memory] 检索记忆失败: {e}")
            yield event.plain_result(f"❌ 记忆服务不可用：{e}")

    # ---------- 命令：/图谱 ----------

    @filter.command("图谱")
    @filter.permission_type(filter.PermissionType.ADMIN)
    async def cmd_graph(self, event: AstrMessageEvent) -> None:
        """查看听雪记忆库的实体与关系概览。"""
        try:
            entities = await self._entities()
            relations = await self._relations()
            ent_list = entities.get("entities", []) if entities.get("ok") else []
            rel_list = relations.get("relations", []) if relations.get("ok") else []
            persons = [e for e in ent_list if e.get("type") == "person"]
            things = [e for e in ent_list if e.get("type") == "thing"]
            concepts = [e for e in ent_list if e.get("type") == "concept"]
            lines = [
                f"🕸️ 记忆图谱概览：",
                f"· 实体 {len(ent_list)} 个（人物 {len(persons)} / 事物 {len(things)} / 概念 {len(concepts)}）",
                f"· 关系边 {len(rel_list)} 条",
            ]
            if persons:
                names = "、".join(p.get("name", "?") for p in persons[:10])
                lines.append(f"· 人物：{names}")
            yield event.plain_result("\n".join(lines))
        except Exception as e:
            logger.error(f"[tingxue-memory] 查看图谱失败: {e}")
            yield event.plain_result(f"❌ 记忆服务不可用：{e}")

    # ---------- 命令：/记忆状态 ----------

    @filter.command("记忆状态")
    @filter.permission_type(filter.PermissionType.ADMIN)
    async def cmd_status(self, event: AstrMessageEvent) -> None:
        """查看记忆服务连接状态与自动记忆/注入开关。"""
        try:
            health = await self._health()
            onoff = lambda b: "开" if b else "关"  # noqa: E731
            body = (
                f"· 自动记忆：群聊 {onoff(self.auto_memory)} / 私聊 {onoff(self.auto_memory_private)}\n"
                f"· 记忆注入：{onoff(self.inject_memory)}（群聊+私聊，top {self.inject_limit}）\n"
                f"· 人格注入：{onoff(self.inject_profile)}"
                f"· 私聊说话人前缀：{onoff(self.private_speaker_prefix)}"
            )
            if health.get("ok"):
                yield event.plain_result(
                    f"✅ 记忆服务已连接：{self.base_url}\n{body}"
                )
            else:
                yield event.plain_result(
                    f"⚠️ 记忆服务响应异常：{health}\n{body}"
                )
        except Exception as e:
            yield event.plain_result(f"❌ 记忆服务不可用（{self.base_url}）：{e}")
