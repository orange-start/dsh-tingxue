# dsh-tingxue · 听雪

> DeepSeek Harness 的**双模式虚拟生命**插件：一个有人格、有长期记忆的 QQ 聊天对象，外加一个用完即焚的隔离文件处理会话。

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![DSH Plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-6E56CF.svg)](https://github.com/deepseek-ai)
[![Client](https://img.shields.io/badge/client-web%20%2B%20host-informational.svg)](#架构)

听雪是一个跑在 [DeepSeek Harness](https://github.com/deepseek-ai) 上的自建插件。它的记忆不依赖任何托管服务——LanceDB 本地文件即库，关系图谱自己实现，语义推理走可插拔的小 LLM。

---

## 目录

- [特性](#特性)
- [前置要求](#前置要求)
- [安装](#安装)
- [快速开始](#快速开始)
- [配置](#配置)
- [架构](#架构)
- [会话隔离与模式自愈](#会话隔离与模式自愈)
- [记忆服务（HTTP API）](#记忆服务http-api)
- [AstrBot 群聊对接](#astrbot-群聊对接)
- [开发](#开发)
- [路线图](#路线图)
- [文档索引](#文档索引)
- [贡献](#贡献)
- [许可证](#许可证)

---

## 特性

| | |
|---|---|
| **双模式** | **聊天模式**（日常对话，人格 + 长期记忆，上下文结构对缓存友好）与 **agent 模式**（隔离的纯文件处理会话，用完即焚，归档进记忆） |
| **全自动切换** | 全程只有 `/agentstart` 和 `/agentstop` 两条指令，自动建会话、自动绑定、自动回绑，不需要手动 `/bind` |
| **自建记忆库** | LanceDB 嵌入式向量库，本地文件即库、零服务器；4 张表（记忆条目 / 实体 / 关系 / 最新信息） |
| **自建关系图谱** | 实体抽取 → 实体链接 → 三元组关系（带时间窗口与溯源）→ 图遍历增强检索；参考 Graphiti / Mem0 实践 |
| **可交互图谱 UI** | 零依赖 canvas 力导向蜘蛛网：节点聚类、邻居高亮、标签碰撞避免、小地图导航，离线可用 |
| **可插拔模型层** | embedding 与语义推理抽象成统一接口，换模型只改配置，插件逻辑零改动 |
| **图形化配置** | 29 个配置项做成图形界面，设置侧边栏独立成页 + 插件配置标签页两个入口，含覆盖标记与单点重置 |
| **推送隔离** | 通过 dsh-notifier 的 `route:agents` 精确分流，其他 DSH 会话的通知与审批不会打扰 QQ |
| **模式自愈** | 启动自检 + 运行期 reconcile：mode 与 QQ 真实绑定不一致时自动退回聊天模式，不会静默丢掉人格与记忆 |

---

## 前置要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| **Node.js** | `>= 22.19` | 见 `package.json` 的 `engines` |
| **DeepSeek Harness** | `0.1.1-rc.2` 或更高 | 插件运行宿主 |
| **dsh-notifier** | **`0.9.0` + 补丁** | QQ 通道。⚠️ **必须钉死 `0.9.0` 并打补丁**，不是普通的 `^0.9.0`（见 [安装](#安装) 与 `发布形态与安装流程.md` §4） |
| **pnpm** | 任意近期版本 | 安装 `@lancedb/lancedb` 时需要解析原生依赖 |
| **一个 LLM / embedding 端点** | — | 默认走 sta1n 供应商，也可切换本地 OpenAI 兼容端点 |

外部依赖仅两个运行时包：`@lancedb/lancedb` 与 `apache-arrow`（版本锁 `18.1.0`）。

---

## 安装

> [!IMPORTANT]
> **先装 `dsh-notifier`，并把它钉在 `0.9.0` + 打上补丁**（见下方第 2 步）。这不是可选项——不打补丁，**QQ 收文件功能整个不存在**（DSH 侧靠补丁拼出的 `[文件] 名称\n下载地址: url` 标记来下载文件），且超 2000 字会被硬切半句。原因与替代方案见 `发布形态与安装流程.md` §4。

```sh
# 1) 在 DSH profile 目录安装本插件
#    Windows 默认路径：%USERPROFILE%\.dsh\profiles\web
cd ~/.dsh/profiles/web
pnpm add file:/absolute/path/to/dsh-tingxue

# 2) 把 dsh-tingxue 加入 profile 的 package.json
#    "dsh": { "profile": { "bundles": [ ..., "dsh-tingxue" ] } }
#    —— 漏这一步会得到「已安装，未生效：未声明 dsh.bundle，已作为普通依赖安装」

# 3) 重启 DSH 让插件挂载
```

**前置的 `dsh-notifier`（必须先做）**：

```sh
cd ~/.dsh/profiles/web
pnpm add dsh-notifier@0.9.0          # 必须钉 0.9.0，补丁的行号基于此版本

# 把补丁放进 profiles/web/patches/，然后在 pnpm-workspace.yaml 里接线：
#   patchedDependencies:
#     dsh-notifier: patches/dsh-notifier.patch
pnpm install                          # 让补丁生效
```

补丁生效的验证：`node_modules/dsh-notifier/src/inbound/_qq-segment.mjs` 存在，且 `src/inbound/message.mjs` 里能搜到 `parseQQFileAttachments`。

> [!IMPORTANT]
> DSH 插件的源码是**进程启动时加载、不热重载**的。改完源码必须两步走：**① 同步到 profile 的 `node_modules` 副本 → ② 重启 DSH**。
> `cordis.patch.yml` 的配置改动会热重载，但 `.mjs` / `client.js` 源码不会。
> 浏览器端同理：`__DSH_BOOT__` 是加载 HTML 那一刻注入的，**重启 DSH 后还需要硬刷新页面**（`Ctrl + Shift + R`）。

---

## 快速开始

装好并重启后，在 QQ 里直接说话即可进入**聊天模式**。

```text
（直接发消息）          → 聊天模式：有人格、有记忆、四块上下文组装
/agentstart           → 进入 agent 模式：新建隔离会话并自动绑定
（发文件、多轮讨论）      → 文件作为上下文持续处理
/agentstop            → 归档对话到记忆库、删除工作副本、销毁隔离会话、自动回绑聊天会话
```

**两条指令之外没有任何手动步骤**——不用 `/bind`，也不用 `/unbind`。

**发文件**：QQ 附件经 `[文件]` 标记由 pre-step 下载到 `dataDir/workcopy/` 并注入上下文。文本文件直接进上下文（单文件上限 5 MB、正文截取 8000 字符）；二进制文件只给文件名与大小元信息。聊天模式与 agent 模式都支持。

**图谱面板**：默认监听 `http://127.0.0.1:8765`，浏览器打开即可看到实时的实体关系蜘蛛网。

---

## 配置

### 配置方式

有两种，优先级从高到低：

1. **图形界面（推荐）**——DSH Web GUI 的「设置」：
   - **设置侧边栏 →「听雪」**（主入口，独占一页）
   - **设置 → 插件 → 插件配置**（次入口，卡片形态）
   - 两处入口共用同一个 settings scope，内容永远同步；写入 settings 用户层（`$DSH_HOME/settings.yaml`）
2. **配置文件**——profile 的 `cordis.patch.yml`，作为 settings 的 base 层保留

界面里标「已覆盖」的字段表示它覆盖了部署配置，可单点**重置**回落到部署层。写入用 revision 设栅，表单漂移会被拒绝而不是覆盖并发修改。

Host 与浏览器两个半侧各有一份同构的字段表（`src/settings/index.mjs` 的 `SETTINGS_FIELDS` 与 `client/client.js` 的 `FIELDS`），**当前各 29 项**，分组与键一一对应。

### 配置项

| 配置项 | 默认 | 说明 |
|---|---|---|
| **人格与记忆** | | |
| `profilePath` | `''` | 听雪档案 txt 路径（人格提示词，由用户自写） |
| `dataDir` | `cwd/.dsh-tingxue` | 记忆库数据目录（LanceDB 本地文件即库，state.json 也在这里） |
| `recentRounds` | `10` | 最近 N 轮滑动窗口（仅在打开「重复注入最近对话」时生效） |
| `injectRecentRounds` | `false` | **重复注入最近对话**。默认关：DSH 会话历史本身已含最近对话，再注入一遍等于同一段话付两次 token（实测约 1.5K/轮） |
| `memoryBudgetTokens` | `1600` | 向量记忆检索块 token 上限 |
| `latestInfoBudgetTokens` | `1000` | 最新信息块 token 上限 |
| **模型** | | |
| `modelBackend` | `sta1n` | 模型后端：`sta1n` / `local` / `custom` |
| `embeddingModel` | `gemini-embedding-2` | 向量模型（同库单一模型铁律）。设置页可点「选择模型」从端点列表里挑 |
| `embeddingDimensions` | `3072` | 向量维度，须与模型实际输出一致 |
| `llmModel` | `gemini-3.1-flash-lite` | 语义推理小 LLM（实体抽取 / 摘要）。设置页可点「选择模型」从端点列表里挑 |
| `baseURL` | `''` | `local` / `custom` 时的 OpenAI 兼容 base URL |
| `apiKey` | `''` | 留空则回落到 DSH 凭据服务里的 `STA1N_API_KEY` |
| **双模式命令** | | |
| `agentStartKeyword` | `/agentstart` | 进入 agent 模式的关键词 |
| `agentStopKeyword` | `/agentstop` | 退出 agent 模式的关键词 |
| `fileDeleteScope` | `workcopy` | 文件删除范围：`workcopy` 只删工作副本 / `keep` 一律保留 |
| **绑定与推送** | | |
| `channel` | `qq` | 绑定通道（dsh-notifier 的 channel） |
| `userId` | `''` | 绑定用户（dsh-notifier 的 userId） |
| `chatSessionId` | `''` | 自愈回绑用的可信聊天会话 id |
| `notifierStateFile` | `''` | 留空用默认的 dsh-notifier `state.json` |
| `routeWorkspace` | `dsh` | 被静音的默认 workspace |
| `quietOtherWorkspace` | `true` | 只让听雪自己的消息送达 QQ |
| `qqStatusNotice` | `true` | QQ 是否显示任务状态提示（🚀 任务开始 / ✅ 任务完成 / ⏹ 任务已中止 / ⏱ 心跳 / ⚠️ 疑似卡住）。关掉后这些状态行不发，**回复正文照常送达**（回复本体走 `turn/end` 通知的正文，见 `交接文档.md` §16.2）；❌ 出错通知保留 |
| `approvalAllowlistOnly` | `true` | 审批是否只推 QQ 对话会话。打开后只有被显式放行出站的会话（听雪聊天会话 / `tingxue-agent-*` 隔离会话）的批准询问发到 QQ，其他 DSH 会话的审批只在桌面弹（需配套的 dsh-notifier 补丁，见 `交接文档.md` §16.3） |
| **面板与服务** | | |
| `graphDashboardEnable` | `true` | 是否启用关系图谱面板 |
| `graphDashboardHost` | `127.0.0.1` | 图谱面板监听地址（默认仅本机 loopback） |
| `graphDashboardPort` | `8765` | 图谱面板端口 |
| `memoryServiceEnable` | `true` | 是否启用记忆服务（管家） |
| `memoryServiceHost` | `127.0.0.1` | 记忆服务监听地址 |
| `memoryServicePort` | `8766` | 记忆服务端口 |

还有若干只在配置文件中生效的字段（`routeWorkspaceChannels`、`provider`、`model`、`cwd` 等），不暴露在界面上。

### 生效时机

- 标了 `applies: 'restart'` 的命名空间：`dataDir`、模型、端口这类**启动期读取**的字段，改动**需重启 DSH**。
- `recentRounds`、`injectRecentRounds`、记忆 / 最新信息预算这类**按次读取**的字段，保存后立即生效。
- `qqStatusNotice` / `approvalAllowlistOnly` 保存后**立即生效**：它们被写成 dsh-notifier 的 `prefs:tingxue` 状态键，由 dsh-notifier 补丁在每次推送 / 审批时实时读取（500ms 读收敛）。
- `graphDashboardEnable` / `memoryServiceEnable` 等开关由插件启动期读取，**需重启 DSH**。

---

## 架构

### 项目结构

```text
dsh-tingxue/
├── src/                          # Host 半侧
│   ├── plugin-entry.mjs          # 插件入口：组装各层、接入 DSH 事件管线、注入与推送隔离
│   ├── models/index.mjs          # 模型适配层（embedding + 小 LLM + 模型列表，可插拔）
│   ├── memory/store.mjs          # LanceDB 记忆存储（4 张表）
│   ├── graph/index.mjs           # 关系图谱（抽取 / 链接 / 关系 / 图遍历）
│   ├── graph-dashboard/index.mjs # 关系图谱面板（零依赖 canvas 力导向蜘蛛网）
│   ├── memory-service/index.mjs  # 记忆服务（管家）：DSH 唯一写者，HTTP API 供 AstrBot 对接
│   ├── model-catalog/index.mjs   # 模型目录路由：设置页模型选择器问端点有哪些模型
│   ├── context/assemble.mjs      # 聊天模式四块上下文组装
│   ├── context/inject.mjs        # 注入接线：异步瀑布取真值（避开 section.text 同步求值）
│   ├── http/index.mjs            # 共享 HTTP 工具（端口探测 / JSON 读写响应）
│   ├── state/index.mjs           # 双模式状态机（持久化 + 滑动窗口裁剪）
│   ├── commands/index.mjs        # 关键词命令处理（含绑定失败回滚）
│   ├── bind/index.mjs            # dsh-notifier 绑定读写 + 推送隔离 + 通知偏好
│   ├── settings/index.mjs        # Host 半侧：注册 settings 命名空间
│   ├── segment.mjs               # QQ 长消息句子完整分段器
│   └── agent/index.mjs           # agent 模式（文件生命周期、归档）
├── client/client.js              # 浏览器半侧：手写 lazy-CJS bundle（设置界面）
├── test/                         # 单元测试（含 test/patches/ 补丁验证，不随主测试集）
├── astrbot-plugin/               # AstrBot 群聊对接插件（Python）
├── research/                     # 第三方参考材料（不进公开仓库）
├── cordis.patch.yml              # bundle patch（插件行声明）
└── package.json
```

### 记忆库表结构（LanceDB）

| 表 | 用途 | 关键字段 |
|---|---|---|
| `memories` | 记忆条目（向量检索主表） | `text` `vector` `scene` `identity` `source` `createdAt` `entityIds` |
| `entities` | 实体节点 | `name` `type` `summary` `vector` |
| `relations` | 关系边（三元组） | `sourceId` `targetId` `relation` `validFrom` `validTo` |
| `latest` | 最新信息（文件摘要 / 待办） | `kind` `text` `createdAt` |

### 聊天模式上下文组装

顺序固定，前缀稳定以命中缓存：

```text
[1] 听雪档案        —— 从 profilePath 读取，固定不变（稳定缓存前缀）
[2] 向量记忆检索     —— 按当前输入语义检索，有界（默认 1600 token），命中才插入
[3] 最近 N 轮对话    —— 默认关闭（见下方说明）
[4] 最新信息        —— 最近文件摘要 / 待办，有界（默认 1000 token）
```

**关于 `[3]`**：DSH 会话本身就是「全部交互历史的仅追加真源，LLM 消息历史由它派生」（`packages/core/session/README.md`）。最近对话本来就在会话历史里，插件再塞进 system 一遍 = 同一段话在模型眼里出现两次，实测每轮白付约 1.5K token。因此 `[3]` 由 `injectRecentRounds` 守卫，**默认不注入**；只有换绑到新会话、会话历史不可用时才需要打开。

**关于 `[4]`**：组装逻辑（`src/context/assemble.mjs`）具备该块，但 `pushLatest()` 目前在插件里没有调用点，实测 71 条请求命中 0 次——属死代码，不是故障。要用需先接上写入侧。

#### 注入走异步瀑布，不走 `section.text`（重要）

DSH 的 `SystemPrompt.section()` 要求 `text` 是**同步**函数返回 string。但 `assemble()` 的内部顺序是：

```text
packages/core/system-prompt/src/index.ts:510   同步求值每个 section.text   ← 缓存在这里被读走
packages/core/system-prompt/src/index.ts:532   await system-prompt/assemble 瀑布
packages/core/agent-loop/src/agent.ts:230      preStep 先 await assemble()，再发 agent/pre-step
```

同步求值**结构上必然早于**任何异步检索。所以「异步预算写入缓存 + `text()` 同步读缓存」的做法不是偶发竞态，而是**首轮必空、之后恒错位一轮**——实测表现就是 system 提示词在 6827（DSH 本体裸大小，一块都没注入）与 13872 之间抖动，人格块命中率只有 42%。

正确做法是 `system-prompt/assemble` 瀑布（`src/context/inject.mjs`）：它**能 await**，且返回值是权威装配。section 只注册一个空占位块保住名字与顺序，真值在瀑布里就地组装后**就位替换**。DSH 自己的 `installModelSelection`（`packages/core/agent/src/model-selection.ts:40`）也是这么用的。

实现要点：

| 点 | 原因 |
|---|---|
| 就位替换，不 push 到末尾 | 块声明 `order: 100`，push 会掉到 100–199 的工具指引之后，破坏块顺序 |
| 校验 `context.agent === agent` | 瀑布是 scope 继承的，不校验会收到别的会话的装配 → 跨会话串线 |
| 按用户输入串缓存 | `assemble()` 每个 step 都跑一次；多步回合（工具调用）不缓存就每步都 embed + 向量检索 |
| 未 ready / agent 模式返回 `null` 且**不落缓存键** | 否则 mode 切回聊天后会一直读到空串 |
| `installContextInjection` 幂等 | 有 `agent/created` 与启动补注入两个入口，重复 `section()` 会因重名抛错 |
| **预热 + 瀑布共用同一次检索** | embed + 检索实测约 790ms。在写 `lastUserText` 的监听器里**不 await** 地预热，瀑布 await 同一个 in-flight promise——既把延迟藏起来，又不重复检索 |
| 缓存带**代号**，只有最新那次能落缓存 | 用户连发两条时，先发起的慢检索晚回来会用旧结果覆盖新结果 |
| `refreshDisposer` 不碰缓存 | 它注册得比写 `lastUserText` 的监听器早；在那里 `invalidate` 会把刚预热好的结果丢掉，白白多检索一次 |
| **检索输入与缓存键用 `turnInput`，不用 `lastUserText`** | `assistant/message` **每个 step 都触发**，step0 结束会把 `lastUserText` 清空（配对写滑动窗口 + 记忆）。若检索用它，step1 起 `currentInput` 变空 → 记忆块在同一轮里整块消失。**这两个变量不能合并**：`lastUserText` 是「待配对输入」（配对后清空），`turnInput` 是「本轮输入」（整轮不变） |

回归测试见 `test/inject.test.mjs`：它用假 `systemPrompt` 精确复刻「先同步读 text → 再 await 瀑布」的顺序，因此能真正抓住这个 bug（在旧设计下会失败）。另有并发与多 step 回归：预热与瀑布共用同一次检索、慢检索晚回来不覆盖新结果、同一轮 step1 起记忆块不消失（同轮 system 必须完全一致）。

### 关系图谱

- **实体抽取**：小 LLM 从文本抽取实体（`person` / `place` / `thing` / `concept`）
- **实体链接**：实体名归一化 + 向量相似，把新实体关联到已有实体
- **关系建立**：抽取实体间三元组关系，带时间窗口与溯源
- **图遍历**：从种子实体沿关系扩展，用于增强记忆检索（`assembleContext` 里从命中记忆的 `entityIds` 扩展 depth=1、limit=5）
- **交互 UI**：`graph-dashboard` 自绘 canvas 力导向蜘蛛网，零外部依赖、离线可用

图谱面板的工程细节：

- **性能**：拖动节点 / 空白平移时暂停每帧 O(n²) 全对斥力计算（`animOn=false` 仅静态重绘），松手后短暂恢复模拟让邻域收敛；鼠标与触屏双 handler 均已处理。
- **视觉**：① 按类型聚类（`clusterCenters`）② hover 邻居高亮 + 非邻居淡出（`focusSet`）③ 标签碰撞避免（`labelRects` 包围盒跳过重叠）④ 右下角小地图（标准缩略图模式，点击跳转视口）⑤ 背景网格固定视口，不随缩放平移移动。
- **两个坑**：HTML 模板字符串里的内联 `onclick` 绝不能用 `\'` 转义单引号（要用 HTML 实体 `&#39;`）；canvas 顶部有 56px 标题栏，所有事件坐标必须经 `canvasOffset()` + `evtPos()` 转成画布相对坐标。

### 双模式与会话隔离

**聊天模式（默认）**
QQ 一进来就是聊天会话，四块上下文组装，有人格与长期记忆。

**agent 模式（隔离会话，用完即焚）**

- **进入**：`/agentstart` → 用 `ctx.agents.create()` 新建隔离会话（只注入听雪档案，不含聊天记忆与历史）→ 自动绑定。
- **处理**：文件作为上下文持续处理，可多轮。
- **退出**：`/agentstop` → 归档对话与文件摘要到记忆库 → 删除工作副本 → `dispose()` 销毁隔离会话 → 自动回绑聊天会话。

**会话隔离铁律**

`session/event` 与 `agent/inbox/inserted` 监听器对所有会话生效，因此**必须按 `session.id` 过滤**：聊天模式只在 `sessionId === chatSessionId` 时写记忆；agent 模式只在 `isAgentSession(session)` 时补全待归档轮次。两种会话的记忆与上下文完全隔离。

**`dsh-tingxue-context` 段的注册位置**

`systemPrompt.section` 是**作用域继承**的：注册在插件 root ctx 会对该 profile 下**所有**会话生效（人格/记忆泄漏到无关会话 = 上下文串线）。因此本插件把它注册在**聊天会话自己的 agent 作用域**（`agent.ctx.get('systemPrompt').section()` + `agent.ctx.effect`），只对聊天会话可见，并随该 agent dispose 自动卸载。

### 推送隔离

通过 dsh-notifier 的 `route:agents` 做出口分流：静默默认 workspace（`channels: []`），再精确放行听雪的聊天会话。插件 init 时写一次，`/agentstart` / `/agentstop` 期间动态维护。结果是其他 DSH 会话的 turn/end、审批与错误通知不再广播到 QQ。

> 审批与远程提问是**另一条**更容易漏的出口：`approval/router.mjs` 的 `resolveApprovalChannels()` 只取 `channelTypes`、忽略 `quiet`，而空集还会回落全局广播。配套补丁把判据换成「只推 `route:agents` 里被显式放行的会话」，见 `交接文档.md` §16.3 / §16.8。

### 模型适配层（可插拔）

`src/models/index.mjs` 把两种能力抽象成统一接口：

```js
embed(texts)        // 文本 → 向量
complete(prompt)    // 小 LLM 语义推理
```

| 后端 | 说明 |
|---|---|
| `sta1n`（默认） | 走 sta1n 供应商的 OpenAI 兼容端点，零部署 |
| `local` | 走本地 OpenAI 兼容端点（ollama / llama.cpp） |
| `custom` | 完全自定义 |

接口有三个方法：`embed(texts)` 文本 → 向量、`complete(prompt)` 小 LLM 语义推理、`listModels()` 列出端点当前提供的模型（供设置页的选择器用，见下节）。

**换模型只需改配置，插件逻辑零改动。** 注意记忆库的**单一向量模型铁律**：同库内必须模型与维度一致，换 embedding 模型需要全量重嵌入。

### 设置页的模型选择器

「向量模型」和「语义推理小 LLM」两个字段旁边有一个**选择模型**按钮：点开询问当前端点提供哪些模型，从真实列表里挑一个填进去（带搜索框，sta1n 的列表有 102 项，靠眼睛翻不现实），不用手敲模型 id。输入框照旧可以直接手填。

数据通路：

| 环节 | 位置 | 说明 |
|---|---|---|
| 客户端弹窗 | `client/client.js` 的 `ModelPicker` | 结构照 DSH「设置 → 模型」的 `ModelListEditor`：询问端点 → 从候选里挑 |
| HTTP 路由 | `src/model-catalog/index.mjs` | `POST /dsh-tingxue/models` |
| 适配层 | `src/models/index.mjs` 的 `listModels()` | 打 `GET <base>/v1/models` |

两个实现选择值得记下来：

- **走宿主自己的 `webServer`**（与 GUI 同一个端口），不另开监听端口。因此不存在跨源问题，也不需要额外的鉴权层——和 GUI 同源。DSH 把 `llm.discoverModels` 钉在 loopback 上，这里用同样的判据（同源 + 回环兜底），因为它同样会拿着一把可能明文的 key 去问端点。
- **不用 DSH 的 `llm.discoverModels` seam**：那个由 `llm-pi-ai` 适配器回答，只认它命名空间里声明过的 provider profile；听雪的模型后端是插件自己的配置（`modelBackend` / `baseURL` / `apiKey`），问它只会得到「未知 provider」。这里用听雪自己的适配层问同一条协议，**端点、协议、key 的解析方式与真正发请求时完全一致**——选择器看到的就是实际会用的那份列表。

请求体是「表单当前显示的值」而非已保存的配置：刚填进去、还没保存的端点或 key 也能立刻试。服务端**只读**，不写任何配置，`apiKey` 只用于这一次询问、不存储也不回显。

宿主没有 `webServer` 服务时路由静默跳过，选择器退化成手填模型 id，不影响其他功能。

API Key 的解析走 DSH credentials 服务，**每次 resolve 时重新 `ctx.get('credentials')`**，不能在 init 时同步捕获闭包——init 早于 credentials 挂载时闭包会固定为 `undefined`，之后每次取 key 都 401。模型适配层与模型目录路由共用 `plugin-entry.mjs` 里的同一份 `resolveApiKey`，保证两条路径取到同一把 key。

**换 key 只改一处**：`$DSH_HOME/.credentials.yaml` 里的 `STA1N_API_KEY`（`sta1n` 后端的 `apiKeyEnv`）。插件、运行时副本、AstrBot 插件都不需要改——插件经凭据服务取 key，AstrBot 经 HTTP 服务间接使用。改完**重启 DSH** 生效。

`settings.yaml` 里 `llm-pi-ai.providers.sta1n.models` 是**模型下拉列表**，必须与实际线上列表一致，否则选到已下线的模型会直接 400/404。核对方式：

```pwsh
# 拉线上列表（需要有效 key），与 settings.yaml 的 - id: 条目对比
node -e "fetch('https://cdn.sta1n.cn/v1/models',{headers:{Authorization:'Bearer '+process.env.K}}).then(r=>r.json()).then(j=>console.log(j.data.map(m=>m.id).sort().join('\n')))"
```

---

## 会话隔离与模式自愈

这是本项目历史上踩得最贵的两个坑，均已修复并固化。

### 症状

`state.json` 的 `mode` 残留在 `agent`，但 dsh-notifier 的 `bind:qq:<userId>` 实际还指向**聊天会话**。此时：

- QQ 消息仍然投递到聊天会话（绑定没变）；
- 但上下文注入在 agent 模式下直接返回空（旧实现是 `refreshContext()` 置空 `cachedContextText`，现在等价于 `buildContextText()` 在 `state.isAgentMode()` 时返回 `null`）；
- 结果：**人格、记忆、最近对话三块全部静默消失**，而"隔离"根本没发生——静默失忆的最坏组合。

真机实测：system 提示词从 11,682 字符掉到 6,827 字符，听雪的块全部消失，QQ 那头毫无提示。

### 根因

1. `POST /agentstart` 路径里，`createIsolatedAgent()` 无论 `setBinding()` 成功与否都返回 `{ ok: true }`，调用方只检查 `result.ok` → 绑定没切成也照样 `state.enterAgent()`。
2. 「agent 模式就置空注入」是唯一一处"置空"逻辑（旧实现是 `refreshContext()` 的第二行，现在等价于 `buildContextText()` 里的 `state.isAgentMode()` 早退），agent 模式一旦误判就全线失守。
3. `mode` 是持久化的，误判会跨重启存活。

### 三层防御（已实现）

| 层 | 位置 | 行为 |
|---|---|---|
| **写前守卫** | `commands/index.mjs` | `createIsolatedAgent()` 回传 `bound`；`/agentstart` 在 `!result.bound` 时调用 `rollbackIsolatedAgent()`（dispose 会话 + 清精确放行路由）并保持聊天模式，直接回复失败原因 |
| **启动自检** | `plugin-entry.mjs` §5.1.3 | 启动时若 `state.isAgentMode()` 且 `bind` 未指向 `state.agentSessionId`，立即 `exitAgent()` 并告警 |
| **运行期 reconcile** | `plugin-entry.mjs` | `agent/inbox/inserted` 命中聊天会话且处于 agent 模式时调用 `reconcileAgentMode()`（`reconciling` 标志防重入），比对真实绑定；漂移则 `exitAgent()` + `ensureContextText(true)` 强制重组装恢复注入 |

**判据统一为一句话**：agent 模式只有在 QQ 确实绑着那个隔离会话时才算数。

> 副作用记录：`/agentstart` 曾经在失败路径留下 295 字节的空壳隔离会话（`tingxue-agent-*`）。`rollbackIsolatedAgent()` 就是为了不留残留而加的。

---

## 记忆服务（HTTP API）

`src/memory-service/index.mjs` 是记忆的**唯一写者**，默认监听 `http://127.0.0.1:8766`（仅 loopback）。它把所有写操作经内部先进先出队列串行化，保证 LanceDB 永远只有一个写者，规避多进程并发写冲突。

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/memory` | 写入一条记忆（服务端负责 embedding）。**快速返回**：只同步落库正文与向量，实体抽取挪到响应之后异步做 |
| `GET` | `/memory/search` | 按语义检索记忆（`q` / `limit` / `scene`） |
| `GET` | `/memory/entities` | 列出实体（上限 1500） |
| `GET` | `/memory/relations` | 列出关系（上限 6000） |
| `GET` | `/memory/expand` | 从种子实体沿关系扩展（`entityId` / `depth`） |
| `GET` | `/profile` | 返回人格文本（供多端共用同一份人格） |
| `GET` | `/health` | 健康检查 |

**为什么 `/memory` 是快速返回**：实体抽取是一次慢的小 LLM 调用。早期实现把它放在响应路径里，AstrBot 客户端 15 s 超时先到，日志只留一句空异常的 `asyncio.TimeoutError`，服务端其实已经写成功 → 客户端重试就写出**重复记忆**。现在响应体带 `async: true`，抽取在 `writeChain` 之后跑，失败只记日志。

---

## AstrBot 群聊对接

目标是让 **DSH（私人）** 与 **AstrBot（群聊）** 互相独立、共享同一份记忆与人格：

```text
DSH（唯一写者）──写──► 记忆库(LanceDB) ◄──HTTP── AstrBot
        │                        ▲
        └── 暴露 HTTP 记忆服务 ───┘
```

- **DSH 是唯一写者**：AstrBot 只通过 HTTP 记忆服务读写，不直接碰 LanceDB 文件。
- **embedding 一致性**：embedding 统一由 DSH 生成，AstrBot 只传文本。
- **人格通用**：两边各自加载同一份人格 txt，DSH 通过 `GET /profile` 提供。
- **记忆储存策略（仿人脑）**：不按群组织，每个人物是独立实体节点，人物之间有关系边，记忆挂到相关人物上。

对接插件在 `astrbot-plugin/`（当前 **v1.3.0**），提供群聊 + 私聊自动记忆与 `/回忆` `/图谱` `/记忆状态` 命令，并严格隔离私聊。它通过 `@filter.on_llm_request()` 在 LLM 请求发出前检索记忆与人格，追加进 `system_prompt`（位于滚动窗口历史之前，滚动窗口与压缩都动不到）。

记忆注入与人格注入是**两个独立开关**（`inject_memory` / `inject_profile`），各自失败都不影响另一路。

> [!NOTE]
> AstrBot 侧 LLM 建议使用 **DeepSeek 官方**端点：sta1n 对 openai SDK 的 `x-stainless-*` 请求头一律返回 403。

---

## 开发

### 环境准备

```sh
git clone <repo-url>
cd dsh-tingxue
pnpm install
```

### 运行测试

```sh
# 方式一：一次性跑全部
pnpm test

# 方式二：逐个运行（推荐在受限沙箱下使用）
# node --test 在部分沙箱环境会因 spawn EPERM 失败，直接运行测试文件即可
node "test/store.test.mjs"
node "test/context.test.mjs"
node "test/graph.test.mjs"
node "test/bind.test.mjs"
node "test/dashboard.test.mjs"
node "test/memory-service.test.mjs"
node "test/segment.test.mjs"
node "test/settings.test.mjs"      # Host 半侧：settings 命名空间注册
node "test/client-card.test.mjs"   # 浏览器半侧：设置界面 bundle
node "test/state.test.mjs"         # 双模式状态机 + 滑动窗口裁剪
node "test/inject.test.mjs"        # 注入时序（异步瀑布取真值）
node "test/selfcheck.test.mjs"     # 自检脚本自身（证明它会红，不是橡皮图章）
node "test/notifier-suppress.test.mjs"     # 命令消费不该被报成「任务被阻塞」
node "test/bigint.test.mjs"        # LanceDB Int64 是 BigInt（含真机契约：expand 不得挂死）
node "test/agent-mode-e2e.test.mjs"        # /agentstart → /agentstop 真机全流程（34 项）
node "test/patches/_qq-segment.test.mjs"   # 历史 QQ 分段补丁（不随主测试集）
```

### 运行状态自检

一条命令看清「重启后有没有退回旧毛病」——修完代码最容易踩的坑就是**忘了重启，跑的还是旧代码**：

```sh
node scripts/selfcheck.mjs          # 人类可读；有问题 exit 1，全绿 exit 0
node scripts/selfcheck.mjs --json   # 机器可读
node scripts/selfcheck.mjs --full   # 解全部日志帧（默认只解尾部 2000 帧，快）
```

输出示例：

```text
  ✓ 运行代码是最新的
      DSH 启动 2026/9/25 15:58:38 ≥ 源码改动 2026/9/25 15:56:37
  ✓ 滑动窗口
      13 轮 / 1426 字符；latestInfo 0 条；mode=chat
  ✓ 注入轮内恒定
      本次启动(15:58:38)之后 2 轮均无轮内变动；system 长度 14193 / 14016
  ✓ 无重复/累赘上下文
      14016 字符 · 54 工具 · 人格块在 · 身份行 1 次
```

**零成本**：只读本地文件 + 打 `/health`、`/profile` 这类纯本地端点，**绝不**调用 `/memory/search` 之类会触发 embedding 的接口（那是要花钱的）。**只读**：不写记忆库、不改任何配置。

检查项见 `test/selfcheck.test.mjs` 与 [交接文档.md](./交接文档.md) §17.16。核心判据是「同一轮内 system 长度必须唯一」——**新回合首条 header 天然带 `change` 是正常行为**，不是漂移；真正的 bug 特征是长度在一轮内出现多个值（记忆块中途消失）。

AstrBot 侧离线自检（不联网、不写记忆库）：

```sh
cd astrbot-plugin
python test_private_handler.py
```

### 开发注意事项

1. **不热重载**——源码改动必须同步到 profile 的 `node_modules` 副本并重启 DSH，浏览器端还要硬刷新页面。同步后请核对 SHA256。
2. **settings 命名空间注册**要内联 `ctx.get('settings')` + `settings.register()`，**不要**导入 `installSettingsSection` / `settingsNamespace` 这两个具名导出：上游删除过它们，而缺失的具名导出是模块求值期的 `SyntaxError`，会让宿主启动失败。没有 settings 服务的旧宿主下应优雅降级。
3. **两半侧字段表必须同步改**——`src/settings/index.mjs` 的 `SETTINGS_FIELDS` 与 `client/client.js` 的 `FIELDS`，漏一边会出现「Host 认这个键、界面画不出来」或反之。
4. **异步上下文不要靠 `section.text` 同步缓存**——`assemble()` 同步求值 `text` 之后才跑瀑布，所以同步缓存首轮必空、之后恒错位一轮。要用 `system-prompt/assemble` 瀑布（见 [上下文组装](#聊天模式上下文组装) 与 `src/context/inject.mjs`）。
5. **注册作用域决定可见范围**——要只对聊天会话生效，就必须注册在 agent 作用域，不能注册在插件 root ctx。
6. **跨插件不要做值导入**——client bundle 的纯净度门禁拒绝跨插件的值导入，协作走 cordis 服务。

---

## 路线图

- [x] 聊天模式 + 长期记忆
- [x] agent 模式隔离会话（全自动双会话）
- [x] 关系图谱 + 可交互蜘蛛网 UI
- [x] 记忆服务（HTTP）与 AstrBot 群聊对接
- [x] 图形化配置（设置侧边栏独立入口）
- [x] 模式自愈（启动自检 + 运行期 reconcile）
- [x] 记忆写入去重（`/memory` 快速返回 + 异步实体抽取）
- [x] 注入时序收敛（改走 `system-prompt/assemble` 异步瀑布取真值；`section.text` 同步求值**结构上**不可能赶上检索）
- [x] 运行状态自检（`scripts/selfcheck.mjs`，九项，零成本只读）
- [ ] 图谱面板「鹰眼模式」小地图（内容随主视图缩放，作为标准缩略图模式的可选增强）
- [ ] 记忆库主干架构的多端一致性加固

---

## 文档索引

| 文档 | 内容 |
|---|---|
| [`README.md`](./README.md) | 本文件：安装、配置、架构、开发、排障 |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | 贡献指南：四条铁律、上下文注入约束、测试约定 |
| [`CHANGELOG.md`](./CHANGELOG.md) | 版本变更记录 |
| [`SECURITY.md`](./SECURITY.md) | 安全策略与敏感面说明 |
| [`astrbot-plugin/README.md`](./astrbot-plugin/README.md) | AstrBot 插件说明 |
| [`astrbot-plugin/SYNC.md`](./astrbot-plugin/SYNC.md) | AstrBot 插件同步铁律 |

> **内部文档不随仓库发布。** 设计文档（`需求规格.md`、`交接文档.md`、`记忆库主干架构*.md`、`astrbot接入方案.md`、`调研报告-*.md`、`发布注意事项.md`）已由 `.gitignore` 挡在仓库外——它们含本机路径、会话 ID 等隐私信息。克隆本仓库看不到这些文件是正常的。

---

## 贡献

这是一个个人自用项目，没有正式的贡献流程。如果你基于它做二次开发：

1. 先确认改动落在正确的半侧——Host（`src/`）还是浏览器（`client/`）。
2. 新功能请补对应测试，并保持 `node test/*.test.mjs` 全绿。
3. 提交前检查四条铁律没有被破坏：**会话隔离**、**注册作用域**、**单一向量模型**、**源码必须同步到 node_modules 并重启**。

---

## 许可证

[MIT](./LICENSE)
