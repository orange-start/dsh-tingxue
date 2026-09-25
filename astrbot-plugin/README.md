# astrbot_plugin_tingxue_memory

听雪记忆服务 · AstrBot 侧对接插件

**当前版本：v1.3.0**

对接 DSH 侧 `dsh-tingxue` 记忆服务（HTTP REST，默认 `http://127.0.0.1:8766`）。

## 核心特性

**自动记忆（群聊 + 私聊）**：收到群聊或私聊文本消息自动写入听雪记忆库（后台异步，不阻塞、不打扰对话）。
- 群聊 → `scene='group'`，开关 `auto_memory`
- 私聊（好友私聊 / WebUI 网页聊天）→ `scene='private'`，开关 `auto_memory_private`

两个开关**相互独立**。私聊写入默认可带说话人前缀（`昵称：正文`，开关 `private_speaker_prefix`），让图谱能把事实挂到具体人物节点上。

**记忆注入 + 人格注入（群聊 + 私聊 LLM 请求）**：用户消息触发模型回复前，按当前话题检索记忆库，并把相关记忆（可选）与听雪人格（可选）注入 `req.system_prompt`（system 开头，位于滚动窗口历史上下文之前，滚动窗口与 LLM 压缩都动不到它）。

- `inject_memory` —— 记忆注入开关（默认开）
- `inject_profile` —— 人格注入开关（默认开，v1.3.0 起与记忆注入**解耦**）

两路用 `asyncio.gather(..., return_exceptions=True)` 并行取，**任一路失败都不影响另一路**。这修复了「提到关键词但模型没有上下文记忆」的问题——此前插件只写记忆、从不注入，所以虽然向量库里有数据但模型看不到。群聊与私聊都注入。

**写超时分级**：检索 / 人格 / 图谱查询用 `total=15s`；写记忆用 `total=25s`。配合 DSH 侧 `/memory` 的「快速返回 + 异步实体抽取」，写入不再因慢模型调用而超时误报。

> 提示：私聊自动记忆与 DSH 侧听雪的私聊是**两条独立通道**（两个不同的 QQ 机器人）。两边写入的是同一个记忆库，因此私聊记忆天然互通。

## 依赖

- AstrBot >= 4.0（Star 插件体系）
- 记忆服务（DSH 侧 `dsh-tingxue` 插件）需已启动，监听 `127.0.0.1:8766`

## 安装

1. 将本目录放入 AstrBot 插件目录：`<AstrBot>/data/plugins/astrbot_plugin_tingxue_memory`
2. 在 AstrBot WebUI 插件管理页启用本插件
3. 确认 DSH 侧记忆服务已启动（`GET http://127.0.0.1:8766/health` 返回 200）

> AstrBot 插件**不热重载**：改完源码要重载插件或重启 AstrBot 进程才生效。同步铁律见 `SYNC.md`。

## 配置（WebUI 插件配置面板可改）

| 配置项 | 默认 | 说明 |
|---|---|---|
| `memory_service_url` | `http://127.0.0.1:8766` | 记忆服务地址 |
| `auto_memory` | `true` | **群聊**消息自动写入记忆开关 |
| `auto_memory_private` | `true` | **私聊**消息自动写入记忆开关（独立） |
| `ignored_groups` | `[]` | 忽略的群号（这些群的发言不自动记忆） |
| `ignored_users` | `[]` | 忽略的私聊用户 ID（这些人的私聊不自动记忆） |
| `min_message_len` | `4` | 自动记忆的最小消息长度（字符，群聊+私聊通用） |
| `private_speaker_prefix` | `true` | 私聊写入是否带「昵称：正文」前缀 |
| `inject_memory` | `true` | LLM 请求时注入**记忆**开关（群聊+私聊） |
| `inject_profile` | `true` | LLM 请求时注入**人格**开关（群聊+私聊，与记忆独立） |
| `inject_limit` | `5` | 每次注入的记忆条数 |
| `inject_max_chars` | `1800` | 注入块预算（字符数），超长截断 |

## 命令（管理员）

| 命令 | 说明 |
|---|---|
| `/回忆 <关键词>` | 语义检索听雪记忆（结果标注来源：群聊 / 私聊） |
| `/图谱` | 查看记忆库实体与关系概览 |
| `/记忆状态` | 查看记忆服务连接状态，以及自动记忆（群聊/私聊）、记忆注入、人格注入、说话人前缀各开关 |

## 自动记忆过滤规则

群聊与私聊消息写入记忆前都会过滤：
- 跳过以 `/`、`!`、`！` 开头的指令消息
- 跳过机器人自己发的消息（自循环防护）
- 跳过过短消息（默认 < 4 字符）
- 跳过纯表情 / 纯图片（无文本）消息
- 群聊额外可用 `ignored_groups` 排除指定群；私聊额外可用 `ignored_users` 排除指定用户

## 离线自检（不联网、不写记忆库）

```sh
python test_private_handler.py
```

用 `_stub/` 里的最小 `astrbot.api` / `aiohttp` 桩导入 `main.py`，验证私聊与群聊自动记忆的过滤、`scene`、说话人前缀、两个注入开关与记忆注入块标签。**26 项全部通过**方可同步到 AstrBot 目录。

## 记忆服务 API

见 DSH 侧 `dsh-tingxue/src/memory-service/index.mjs`：

- `POST /memory` — 写一条记忆（服务端 embedding；**快速返回**，实体抽取异步）
- `GET /memory/search?q=...` — 语义检索
- `GET /memory/entities` / `GET /memory/relations` — 图谱数据
- `GET /memory/expand?entityId=...` — 从实体沿关系扩展
- `GET /profile` — 人格文本
- `GET /health` — 健康检查

## 灵感来源

- [AstrBot](https://github.com/AstrBotDevs/AstrBot) — 插件开发规范（Star 体系）
- [helloworld](https://github.com/Soulter/helloworld) — 插件模板
