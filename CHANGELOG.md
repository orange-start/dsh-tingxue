# 更新日志

本项目的所有重要变更记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- 运行状态自检脚本 `scripts/selfcheck.mjs`：九项零成本只读检查，一条命令看清「重启后有没有退回旧毛病」。头一项即「运行代码是否最新」，专治「修完忘重启」。有问题 `exit 1`，可 `--json` 接自动化。
- 自检脚本自身的回归测试 `test/selfcheck.test.mjs`，证明它在旧毛病上真的会红，不是橡皮图章。
- GitHub CI（`.github/workflows/ci.yml`）：Node 22.19 / 24 双版本跑测试 + 语法检查 + 插件加载 + AstrBot 侧离线自检。
- issue / PR 模板；`CONTRIBUTING.md`（含四条铁律与上下文注入约束）；`SECURITY.md`。
- AstrBot 侧独立开关：人格注入与记忆注入可分别关闭。

### 修复

- **上下文注入时序**（本项目代价最高的 bug）：改走 `system-prompt/assemble` 异步瀑布取真值。原设计「异步预计算 + `section.text` 同步返回缓存」在 `assemble()` 的求值顺序下**结构上不可能**首轮正确——实测 71 条请求里人格块只命中 30 条（42%），system 长度在 6827（一块都没注入）与 13872 之间抖动。
- **同一轮多 step 时记忆块消失**：`assistant/message` 每个 step 都触发，step0 结束会把「待配对输入」清空，而检索用的正是它 → step1 起 `currentInput` 变空、记忆块整块消失（实测同轮 15817 → 13872，掉的 1945 字符正是记忆块）。拆出整轮不变的 `turnInput` 供检索与缓存键使用。
- **预热缺失导致检索落在请求路径上**：embed + 向量检索实测约 790ms。改为在新消息监听器里不 await 地预热，瀑布 await 同一个 in-flight promise（按输入去重），延迟被藏起来且不重复检索。
- **并发覆盖**：连发两条时，先发起的慢检索晚回来会覆盖新结果 → 加缓存代号，只允许最新一次落缓存。
- `refreshDisposer` 不再作废缓存（它注册得比写 `lastUserText` 的监听器早，在那里 invalidate 会把刚预热好的结果丢掉）。
- **假「任务被阻塞」通知**：`/agentstart`、`/agentstop` 是**用 `reject` 消费**的（命令已处理完，不能再让模型回答它），而 DSH 里 `reject` 是 `blocked` 的唯一来源 → 命令明明成功了，QQ 却收到「🚫 任务被阻塞，等待你处理」，碍事又不实。改为在通知侧判据「该轮无任何 `step/start` ⇒ 命令消费 ⇒ 整条不发」；拿不到可信事件时一律 fail-open（不抑制），绝不吞掉真阻塞。本环境历史 16 次 `blocked` 全是 0 step 的命令消费。
- **「切换 QQ 绑定失败」的真因被吞掉**：`setBinding` 原来 `catch { return false }`，真因完全不可见。实测根因是 Windows 上 `rename` 覆盖**正被其他进程打开**的文件抛 `EPERM`，而 `state.json` 同时被 DSH 宿主、notifier store 与本插件读写。`writeNotifierState` 改为对可重试错误码做有界退避重试（6 次，8→128ms），并新增 `setBindingDetailed` 把真因回传给命令层写进回复文案。
- **`/memory/expand` 永久挂死**（全功能实测发现）：`store.relationsOf` 裸返回 LanceDB 原始行，`validFrom`/`validTo` 是 **BigInt**，而 `JSON.stringify(BigInt)` 抛 `TypeError`；原 `sendJson` 先 `writeHead(200)` 再序列化，抛错后 `res.end()` 永不执行、错误又被 `catch {}` 吞掉 → 客户端挂死 180s+，服务端毫无日志。实测「度数 0 的实体 46ms 返回、度数 1 就超时」，与数据量无关。修：`relationsOf` / `getEntity` / `findEntityByName` / `listLatest` 全部做 BigInt → Number 规整；并把 `sendJson` 的序列化提到写头之前，失败回明确的 500。
- **静默吞错导致故障零线索**（同源清扫）：上下文预热 `catch(() => {})`、滑动窗口写入 `catch(() => {})`、配对/补注入/待归档的空 `catch` 全部改为打 `warn`。这类吞错会让「检索挂了 → 人格记忆块整块消失」「轮次莫名不增长」变成完全无痕迹的无头案，正是本 bug 藏了这么久的原因。`searchEntities` 的 `distance` 也从裸透传改为 `Number()`。
- **`/memory/expand` 挂死的回归防线**：`test/bigint.test.mjs` 新增**真机契约测试**——直接打运行中的 8766，挑一个**度数 ≥ 1** 的实体（正是修复前会挂死的形态），断言 25s 内必须返回、且返回的每一行 `typeof !== 'bigint'`。没有服务在跑时自动 skip。

### 变更

- `[3] 最近对话` 默认不注入，由 `injectRecentRounds === true` 严格守卫。
- 滑动窗口加上限；`latestInfo` 上限 20 条。
- `/memory` 改为快速返回 + 异步实体抽取，修掉重复写入。
- 模型列表裁剪至 102 项；语义推理小 LLM 切换为 `gemini-3.1-flash-lite`（实测 999ms，为候选中最快）。
- AstrBot 对接插件升到 v1.3.0。
- `intentOfSessionEvent` 的 `turn/end` 分支补带 `turn` 号（供通知侧判据定位该轮）。

## [0.1.0]

首个版本。

### 新增

- 聊天模式 + agent 模式（隔离会话）双模式，全自动切换。
- LanceDB 自建向量记忆库：`memories` / `entities` / `relations` / `latest` 四张表，`gemini-embedding-2`（3072 维）。
- 自建实体关系图谱 + 可交互蜘蛛网 UI（`8765`）。
- 记忆服务 HTTP API（`8766`）：写入、语义检索、实体、关系、扩展、人格读取。
- 四块上下文组装：`[1] 听雪档案` → `[2] 向量记忆检索` → `[3] 最近对话` → `[4] 最新信息`。
- 图形化配置（设置侧边栏独立页面 + 插件卡片）。
- 全部交互走 QQ（依赖 `dsh-notifier`），含长文本分段。
- AstrBot 群聊 / 私聊对接插件（Python）。
- 模式自愈：写前守卫 + 启动自检 + 运行期 reconcile。判据为「agent 模式只有在 QQ 确实绑着该隔离会话时才算数」。

[Unreleased]: https://github.com/oransky/dsh-tingxue/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/oransky/dsh-tingxue/releases/tag/v0.1.0
