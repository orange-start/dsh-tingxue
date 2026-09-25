# AstrBot 插件工程副本 · 同步说明

本目录是 `astrbot_plugin_tingxue_memory`（AstrBot 侧听雪记忆对接插件）的**工程副本 / 备份 / 离线自检**，
不是插件运行位置。

| 位置 | 作用 |
|---|---|
| `<AstrBot 数据目录>/plugins/astrbot_plugin_tingxue_memory/` | **AstrBot 实际加载的位置**（唯一权威） |
| `dsh-tingxue/astrbot-plugin/`（本目录） | 工程副本（可编辑、可对比、可离线自检） |

## 同步铁律（与 dsh-tingxue → node_modules 副本同一套路）

1. 改 `main.py` / `_conf_schema.json` / `README.md` / `metadata.yaml` 后，**必须复制到 AstrBot 插件目录**；
2. **AstrBot 插件不热重载**，改完要在 AstrBot WebUI 重载插件或重启 AstrBot 进程才生效；
3. 复制前先备份目标文件（命名 `*.bak-<日期>`）；
4. 复制后核对 SHA256 一致。

**当前状态（2026-09-25 核对）**：`main.py` / `_conf_schema.json` / `metadata.yaml` **3/3 SHA256 与 AstrBot 目录一致**，版本 `v1.3.0`。

## 离线自检（不联网、不写记忆库）

```
python test_private_handler.py
```

用 `_stub/` 里的最小 `astrbot.api` / `aiohttp` 桩导入 `main.py`，验证私聊/群聊自动记忆的
过滤、scene、说话人前缀、开关，以及记忆注入块标签与**人格注入独立开关**。
**26 项全部通过**方可同步到 AstrBot 目录。

> 注意：`_stub/` 与 `test_private_handler.py` 只服务于本目录的自检，**不要复制进 AstrBot 插件目录**
> （AstrBot 会扫描插件目录，多余文件有干扰风险）。
>
> `__pycache__/` 同理，属于本目录自检产物。
