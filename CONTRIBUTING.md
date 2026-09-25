# 贡献指南

这是一个个人自用项目，没有正式的贡献流程。如果你基于它做二次开发，以下几条能帮你少踩坑——它们都是真机上踩出来的。

## 快速上手

```sh
git clone <repo-url>
cd dsh-tingxue
pnpm install
pnpm test          # 16 个测试文件
node scripts/selfcheck.mjs   # 运行状态自检（需要 DSH 正在运行）
```

## 四条铁律

**这四条被破坏时都是静默失效，不报错，只在真机上表现为「人格/记忆偶尔不见了」。** 改 `src/plugin-entry.mjs`、`src/context/*`、`src/commands/*` 时请逐条自查。

### 1. 会话隔离

听雪的人格与记忆**只能**注入到绑定聊天会话，绝不能漏到该 profile 下的其他 DSH 会话。

判断一个 agent 是不是聊天会话，用 `isChatAgent(agent)`（比对 `chatSessionId`）。所有会写入 `lastUserText` 的监听器都必须先过这个判断，否则**在 DSH GUI 里随便说一句话，会被当作「听雪的上一条用户消息」参与 QQ 回复的上下文组装，还可能被写进记忆库**——这是跨会话数据污染。

### 2. 注册作用域

`systemPrompt.section` 是**作用域继承**的：

- 注册在插件 root `ctx` → 对该 profile 下**所有**会话生效（全局段）
- 注册在 `agent.ctx` → 只对那个 agent 生效（会话段）

听雪要的是后者。历史上曾在 root 层注册，导致人格泄漏到所有会话。

参考 DSH 自己的写法：`packages/core/agent/src/model-selection.ts` 就是挂在 `agentCtx` 上的。

### 3. 单一向量模型

一个 LanceDB 库里**只能有一个 embedding 模型**。换模型意味着维度可能变（`gemini-embedding-2` = 3072），混用会让检索结果静默错乱甚至报错。要换模型就**重建库**。

### 4. 源码必须同步到运行时副本并重启

插件**不热重载**：

1. 改 `src/` → 同步到 `$DSH_HOME/profiles/<profile>/node_modules/dsh-tingxue/` → **重启 DSH**
2. 改 `client/client.js` → 同步 → 重启 → 浏览器**硬刷新**（`Ctrl+Shift+R`）

**忘了第 2 步就会以为修复没生效。** 跑 `node scripts/selfcheck.mjs`，第一项「运行代码是最新的」会直接告诉你进程加载的是不是改动后的代码。

## 上下文注入：不要用 `section.text` 同步读缓存

这是本项目代价最高的一个 bug，务必理解后再改。

`assemble()`（`packages/core/system-prompt/src/index.ts:510`）**同步求值**每个 `section.text`，**之后**才 await `system-prompt/assemble` 瀑布。所以「异步预计算 + `section.text` 同步返回缓存」**结构上不可能**首轮正确——不是竞态，是必然错位一轮。

正确做法：section 只留占位，真值在 `system-prompt/assemble` 瀑布里组装并**就位替换**。细节见 `src/context/inject.mjs` 与 README 的「聊天模式上下文组装」。

顺带两个已修的同族坑（改这块时别再踩）：

- **检索输入要用 `turnInput`（整轮不变），不能用 `lastUserText`（配对后清空）**。`assistant/message` 每个 step 都触发，用错变量会让同一轮 step1 起记忆块整块消失。
- **预热与瀑布要共用同一次检索**。embed + 检索实测约 790ms；不预热就会把这 790ms 摊在请求路径上。

## 模式自愈（改动 `plugin-entry.mjs` 时的必查项）

`state.json` 的 `mode` 是**持久化**的，误判会跨重启存活。判据统一为一句话：

> **agent 模式只有在 QQ 确实绑着那个隔离会话时才算数。**

三层防御：写前守卫（`commands/index.mjs`）、启动自检、运行期 `reconcileAgentMode()`。任何影响「注入与否」的判断，都要有**可观测性**（日志 + 会话日志里 `request/header` 的 system 长度）和**自愈**。

## 提交前

```sh
pnpm test                     # 全绿
node --check src/*.mjs        # 语法
node scripts/selfcheck.mjs    # 运行期自检（若影响运行行为）
```

改了 `src/settings/index.mjs` 的 `SETTINGS_FIELDS` 时，**必须同步改** `client/client.js` 的 `FIELDS`，否则会出现「Host 认这个键、界面画不出来」或反之。

## 测试约定

- 每个测试文件能**单独**用 `node test/xxx.test.mjs` 跑（`node --test` 的 spawn 在部分受限环境会 `EPERM`）。
- 修 bug 时**先写一个在旧代码上会失败的测试**，再修。例：`test/inject.test.mjs` 用假 `systemPrompt` 精确复刻真实求值顺序，所以能真正抓住那个 bug。
- 自检脚本自身的测试（`test/selfcheck.test.mjs`）用来证明它**不是橡皮图章**——一个永远返回「正常」的检查没有价值。
