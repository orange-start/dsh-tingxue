# -*- coding: utf-8 -*-
"""
astrbot_plugin_tingxue_memory 离线逻辑自检（不联网、不写记忆库）

用最小 astrbot/api 桩（_stub/）导入插件，验证：
  1. 私聊自动记忆：scene='private'、说话人前缀、identity
  2. 私聊过滤：过短 / 指令 / 机器人自己 / ignored_users / 开关关闭
  3. 群聊自动记忆：行为保持原样（scene='group'、不加前缀）
  4. 记忆注入块：群聊/私聊标签正确

运行：python test_private_handler.py
"""

import asyncio
import pathlib
import sys

try:  # Windows 控制台默认 GBK，强制 UTF-8 输出
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "_stub"))  # astrbot.* / aiohttp 桩
sys.path.insert(0, str(HERE))            # main.py

import main  # noqa: E402

PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"{'[PASS]' if cond else '[FAIL]'} {name}" + (f"  -> {detail}" if detail and not cond else ""))


# ---------- 假事件 ----------

class _Sender:
    def __init__(self, user_id, nickname):
        self.user_id = user_id
        self.nickname = nickname


class _MsgObj:
    def __init__(self, self_id, sender, group_id=""):
        self.self_id = self_id
        self.sender = sender
        self.group_id = group_id


class FakeEvent:
    def __init__(self, text, *, sender_id="123456", nickname="远山",
                 self_id="1905533228", group_id=""):
        self.message_str = text
        self.message_obj = _MsgObj(self_id, _Sender(sender_id, nickname), group_id)
        self._sender_id = sender_id

    def get_sender_id(self):
        return self._sender_id

    def get_sender_name(self):
        return self.message_obj.sender.nickname

    def get_group_id(self):
        return self.message_obj.group_id


class Capture:
    """捕获插件实际发给记忆服务的 payload。"""

    def __init__(self, plugin):
        self.payloads = []
        plugin._write_memory = self._write

    async def _write(self, text, scene="chat", identity="", source="astrbot"):
        self.payloads.append({"text": text, "scene": scene,
                              "identity": identity, "source": source})
        return {"ok": True, "newEntities": 0}


async def run(plugin, event, handler):
    await getattr(plugin, handler)(event)
    await asyncio.sleep(0)
    await asyncio.sleep(0)


async def main_test():
    print("== 私聊自动记忆 ==")
    plugin = main.TingxueMemoryPlugin(None, {})
    cap = Capture(plugin)

    await run(plugin, FakeEvent("我今天去跑了三公里"), "on_private_auto_memory")
    check("私聊：写入 1 条", len(cap.payloads) == 1, cap.payloads)
    if cap.payloads:
        p = cap.payloads[0]
        check("私聊：scene=private", p["scene"] == "private", p)
        check("私聊：带说话人前缀", p["text"] == "远山：我今天去跑了三公里", p)
        check("私聊：identity=发送者ID", p["identity"] == "123456", p)
        check("私聊：source=astrbot", p["source"] == "astrbot", p)

    print("== 私聊过滤 ==")
    for label, ev, kw in [
        ("过短消息跳过", FakeEvent("嗯"), {}),
        ("指令消息跳过", FakeEvent("/回忆 咖啡"), {}),
        ("感叹号指令跳过", FakeEvent("！图谱"), {}),
        ("机器人自己发的跳过", FakeEvent("你好呀朋友", sender_id="1905533228"), {}),
        ("纯空白跳过", FakeEvent("     "), {}),
    ]:
        plugin = main.TingxueMemoryPlugin(None, kw)
        cap = Capture(plugin)
        await run(plugin, ev, "on_private_auto_memory")
        check(label, len(cap.payloads) == 0, cap.payloads)

    plugin = main.TingxueMemoryPlugin(None, {"ignored_users": ["123456"]})
    cap = Capture(plugin)
    await run(plugin, FakeEvent("这条不该被记录"), "on_private_auto_memory")
    check("ignored_users 命中跳过", len(cap.payloads) == 0, cap.payloads)

    plugin = main.TingxueMemoryPlugin(None, {"auto_memory_private": False})
    cap = Capture(plugin)
    await run(plugin, FakeEvent("私聊记忆已关闭"), "on_private_auto_memory")
    check("auto_memory_private=false 时不写", len(cap.payloads) == 0, cap.payloads)

    plugin = main.TingxueMemoryPlugin(None, {"private_speaker_prefix": False,
                                             "min_message_len": 2})
    cap = Capture(plugin)
    await run(plugin, FakeEvent("今天我有点累"), "on_private_auto_memory")
    check("关闭前缀时写「用户：正文」",
          cap.payloads and cap.payloads[0]["text"] == "用户：今天我有点累", cap.payloads)

    plugin = main.TingxueMemoryPlugin(None, {"min_message_len": 2})
    cap = Capture(plugin)
    await run(plugin, FakeEvent("我有点累", nickname=""), "on_private_auto_memory")
    check("无昵称时退化为「用户：正文」",
          cap.payloads and cap.payloads[0]["text"] == "用户：我有点累", cap.payloads)

    print("== 群聊自动记忆（回归，行为不变）==")
    plugin = main.TingxueMemoryPlugin(None, {})
    cap = Capture(plugin)
    await run(plugin, FakeEvent("小明喜欢打篮球", sender_id="888", nickname="小明",
                                group_id="10001"), "on_group_auto_memory")
    check("群聊：写入 1 条", len(cap.payloads) == 1, cap.payloads)
    if cap.payloads:
        p = cap.payloads[0]
        check("群聊：scene=group", p["scene"] == "group", p)
        check("群聊：正文不加前缀", p["text"] == "小明喜欢打篮球", p)
        check("群聊：identity=昵称", p["identity"] == "小明", p)

    plugin = main.TingxueMemoryPlugin(None, {"ignored_groups": ["10001"]})
    cap = Capture(plugin)
    await run(plugin, FakeEvent("这个群不记录", group_id="10001"), "on_group_auto_memory")
    check("ignored_groups 命中跳过", len(cap.payloads) == 0, cap.payloads)

    plugin = main.TingxueMemoryPlugin(None, {"auto_memory": False})
    cap = Capture(plugin)
    await run(plugin, FakeEvent("群聊记忆已关闭", group_id="10002"), "on_group_auto_memory")
    check("auto_memory=false 时不写", len(cap.payloads) == 0, cap.payloads)

    print("== 记忆注入块 ==")
    plugin = main.TingxueMemoryPlugin(None, {})

    async def fake_search(q, limit=5, scene=None):
        return {"ok": True, "results": [
            {"text": "小明喜欢打篮球", "scene": "group", "source": "astrbot"},
            {"text": "远山：我今天去跑了三公里", "scene": "private", "source": "astrbot"},
            {"text": "用户：晚上好\n听雪：晚上好", "scene": "chat", "source": "chat"},
        ]}

    async def fake_profile():
        return "你是听雪，一只白毛猫娘。"

    plugin._search = fake_search
    plugin._profile = fake_profile
    req = main.ProviderRequest(prompt="篮球", system_prompt="BASE")
    await plugin.on_llm_memory_inject(FakeEvent("篮球"), req)
    sp = req.system_prompt
    check("注入：保留原 system 前缀", sp.startswith("BASE"), sp[:60])
    check("注入：群聊标签", "（来自群聊记录）" in sp, sp)
    check("注入：私聊标签", "（来自私聊记录）" in sp, sp)
    check("注入：包含人格", "白毛猫娘" in sp, sp)

    # 人格注入独立开关：关掉人格，记忆仍注入
    print("== 人格注入独立开关 ==")
    plugin = main.TingxueMemoryPlugin(None, {"inject_profile": False})
    plugin._search = fake_search
    plugin._profile = fake_profile
    req = main.ProviderRequest(prompt="篮球", system_prompt="BASE")
    await plugin.on_llm_memory_inject(FakeEvent("篮球"), req)
    sp = req.system_prompt
    check("人格关闭：记忆仍注入", "小明喜欢打篮球" in sp, sp)
    check("人格关闭：不含人格", "白毛猫娘" not in sp, sp)

    print()
    print(f"通过 {len(PASS)} 项，失败 {len(FAIL)} 项")
    if FAIL:
        print("失败项：" + "、".join(FAIL))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main_test()))
