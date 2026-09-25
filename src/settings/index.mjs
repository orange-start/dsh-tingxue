// dsh-tingxue src/settings/index.mjs
// Host 半侧：把插件配置注册成一个 DSH settings 命名空间，
// 让 Web GUI「设置 → 插件配置」标签页里出现一张 dsh-tingxue 卡片。
//
// 为什么不用 installSettingsSection / settingsNamespace：
// 上游在 dsh 0.1.2-alpha.1 删过这两个具名导出（dshmarket 的注释记录了事故：
// 缺失的具名导出是模块求值期的 SyntaxError，cordis 报成 failed entry，宿主 exit 1）。
// settings 服务本身从未变过（register/watch/get 一直在），所以这里内联同样的接线，
// 只在服务层依赖，不对可能消失的包装函数产生版本脆弱性。
//
// 单一写者：命名空间只声明插件自己要用的字段；运行期变更通过
// Object.assign 回写入口 config 对象，让「按次读取」的配置（滑动窗口、
// 预算）立即生效；启动期读取的配置（dataDir、模型、端口）标 applies:'restart'。

const NAMESPACE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** 设置命名空间；浏览器半侧的卡片以同一个键注册进 settings.plugin.item。 */
export const TINGXUE_SETTINGS_NS = 'dsh-tingxue'

if (!NAMESPACE_PATTERN.test(TINGXUE_SETTINGS_NS)) {
  throw new TypeError(`settings namespace "${TINGXUE_SETTINGS_NS}" must match ${String(NAMESPACE_PATTERN)}`)
}

/**
 * 字段表：schema、入口 base 快照、卡片渲染顺序都从这里派生，避免三处各写一份。
 * kind: 'string' | 'number' | 'boolean' | 'enum'
 */
export const SETTINGS_FIELDS = [
  // —— 人格与记忆 ——
  { key: 'profilePath', kind: 'string', group: '人格与记忆', label: '听雪档案路径', desc: '人格提示词 txt 的绝对路径', default: '' },
  { key: 'dataDir', kind: 'string', group: '人格与记忆', label: '记忆库目录', desc: 'LanceDB 本地文件即库的数据目录', default: '' },
  { key: 'recentRounds', kind: 'number', group: '人格与记忆', label: '最近 N 轮滑动窗口', desc: '注入上下文保留的最近对话轮数（仅打开「重复注入最近对话」时生效）', default: 10, min: 1, max: 200, step: 1 },
  { key: 'injectRecentRounds', kind: 'boolean', group: '人格与记忆', label: '重复注入最近对话', desc: '默认关。DSH 会话历史本身已含最近对话，再注入一遍等于同一段话付两次 token（实测约 1.5K/轮）。只有换绑到新会话、历史不可用时才需要打开', default: false },
  { key: 'memoryBudgetTokens', kind: 'number', group: '人格与记忆', label: '记忆块预算', desc: '向量记忆检索块 token 上限', default: 1600, min: 0, max: 20000, step: 100 },
  { key: 'latestInfoBudgetTokens', kind: 'number', group: '人格与记忆', label: '最新信息块预算', desc: '最新信息块 token 上限', default: 1000, min: 0, max: 20000, step: 100 },

  // —— 模型 ——
  { key: 'modelBackend', kind: 'enum', group: '模型', label: '模型后端', desc: 'sta1n 云端 / local 本地 OpenAI 兼容端点 / custom 自定义', values: ['sta1n', 'local', 'custom'], default: 'sta1n' },
  { key: 'embeddingModel', kind: 'string', group: '模型', label: '向量模型', desc: '同库单一模型铁律：换模型须全量重嵌入', default: 'gemini-embedding-2' },
  { key: 'embeddingDimensions', kind: 'number', group: '模型', label: '向量维度', desc: '须与向量模型实际输出一致', default: 3072, min: 1, max: 20000, step: 1 },
  { key: 'llmModel', kind: 'string', group: '模型', label: '语义推理小 LLM', desc: '实体抽取/摘要用的小模型（设置页可点「选择模型」从端点列表里挑）', default: 'gemini-3.1-flash-lite' },
  { key: 'baseURL', kind: 'string', group: '模型', label: '自定义端点', desc: 'modelBackend=local/custom 时的 OpenAI 兼容 base URL', default: '' },
  { key: 'apiKey', kind: 'string', group: '模型', label: 'API Key', desc: '留空则回落到 DSH 凭据服务里的 STA1N_API_KEY', default: '' },

  // —— 双模式命令 ——
  { key: 'agentStartKeyword', kind: 'string', group: '双模式命令', label: '进入 agent 模式关键词', desc: 'QQ 聊天中触发隔离会话', default: '/agentstart' },
  { key: 'agentStopKeyword', kind: 'string', group: '双模式命令', label: '退出 agent 模式关键词', desc: '归档并销毁隔离会话', default: '/agentstop' },
  { key: 'fileDeleteScope', kind: 'enum', group: '双模式命令', label: '文件删除范围', desc: 'workcopy 只删工作副本保留原始 / keep 一律保留', values: ['workcopy', 'keep'], default: 'workcopy' },

  // —— 绑定与推送 ——
  { key: 'channel', kind: 'string', group: '绑定与推送', label: '绑定通道', desc: 'dsh-notifier 的 channel', default: 'qq' },
  { key: 'userId', kind: 'string', group: '绑定与推送', label: '绑定用户', desc: 'dsh-notifier 的 userId', default: '' },
  { key: 'chatSessionId', kind: 'string', group: '绑定与推送', label: '聊天会话 id', desc: '自愈回绑用的可信聊天会话 id', default: '' },
  { key: 'notifierStateFile', kind: 'string', group: '绑定与推送', label: 'notifier state 路径', desc: '留空用默认的 dsh-notifier state.json', default: '' },
  { key: 'routeWorkspace', kind: 'string', group: '绑定与推送', label: '出站分流 workspace', desc: '被静音的默认 workspace', default: 'dsh' },
  { key: 'quietOtherWorkspace', kind: 'boolean', group: '绑定与推送', label: '静音其他会话推送', desc: '只让听雪自己的消息送达 QQ', default: true },
  { key: 'qqStatusNotice', kind: 'boolean', group: '绑定与推送', label: 'QQ 显示任务状态提示', desc: '关掉后不再发「🚀 任务开始 / ✅ 任务完成 / ⏹ 任务已中止 / ⏱ 心跳 / ⚠️ 疑似卡住」这类状态行；听雪的回复正文照常送达（出错通知仍保留）', default: true },
  { key: 'approvalAllowlistOnly', kind: 'boolean', group: '绑定与推送', label: '审批只推 QQ 对话会话', desc: '打开后只有被显式放行的会话（听雪聊天会话 / agent 隔离会话）的批准询问才发到 QQ，其他 DSH 会话的审批只在桌面弹', default: true },

  // —— 面板与服务 ——
  { key: 'graphDashboardEnable', kind: 'boolean', group: '面板与服务', label: '启用关系图谱面板', desc: '本机可交互蜘蛛网 UI', default: true },
  { key: 'graphDashboardHost', kind: 'string', group: '面板与服务', label: '图谱面板监听地址', desc: '默认仅本机 loopback', default: '127.0.0.1' },
  { key: 'graphDashboardPort', kind: 'number', group: '面板与服务', label: '图谱面板端口', desc: '', default: 8765, min: 1, max: 65535, step: 1 },
  { key: 'memoryServiceEnable', kind: 'boolean', group: '面板与服务', label: '启用记忆服务', desc: 'DSH 唯一写者，AstrBot 经 HTTP 对接', default: true },
  { key: 'memoryServiceHost', kind: 'string', group: '面板与服务', label: '记忆服务监听地址', desc: '默认仅本机 loopback', default: '127.0.0.1' },
  { key: 'memoryServicePort', kind: 'number', group: '面板与服务', label: '记忆服务端口', desc: '', default: 8766, min: 1, max: 65535, step: 1 },
]

/** 把字段表编成 schemastery schema。 */
export function buildSettingsSchema(z) {
  const dict = {}
  for (const f of SETTINGS_FIELDS) {
    let s
    if (f.kind === 'number') {
      s = z.number()
      if (f.min !== undefined) s = s.min(f.min)
      if (f.max !== undefined) s = s.max(f.max)
      if (f.step !== undefined) s = s.step(f.step)
    } else if (f.kind === 'boolean') {
      s = z.boolean()
    } else if (f.kind === 'enum') {
      s = z.union(f.values.map((v) => z.const(v)))
    } else {
      s = z.string()
    }
    if (f.default !== undefined) s = s.default(f.default)
    if (f.desc) s = s.description(f.desc)
    dict[f.key] = s
  }
  return z.object(dict)
}

/** 从入口 config 里取出本命名空间声明的字段（JSON 安全快照）。 */
export function entrySnapshot(config) {
  const entry = {}
  for (const f of SETTINGS_FIELDS) {
    const v = config?.[f.key]
    if (v === undefined || v === null) continue
    entry[f.key] = typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v
  }
  return entry
}

/**
 * 注册 settings 命名空间。
 *
 * 无 settings 服务时（老宿主）`ctx.inject` 的回调不执行，插件照常按
 * cordis.patch.yml 的配置运行——优雅降级，不需要版本判断。
 *
 * @param ctx - 插件 context
 * @param config - 入口 config 对象（会被就地回写）
 * @param deps - { warn, onApply }
 *   onApply(config) 在每次「配置已回写」后被调用（注册当下与每次变更各一次），
 *   用于把不属于本插件运行时的字段物化到外部（如 dsh-notifier 的通知偏好）。
 */
export async function installTingxueSettings(ctx, config, deps = {}) {
  const warn = deps.warn ?? (() => {})
  let z
  try {
    const mod = await import('@deepseek-ai/schemastery')
    z = mod.default ?? mod
  } catch (e) {
    warn(`settings: schemastery 不可用，跳过设置卡片注册（配置仍按 cordis.patch.yml 生效）: ${e.message}`)
    return false
  }
  if (!z || typeof z.object !== 'function') {
    warn('settings: schemastery 形状不符合预期，跳过设置卡片注册')
    return false
  }

  let Config
  try {
    Config = buildSettingsSchema(z)
  } catch (e) {
    warn(`settings: schema 构建失败，跳过设置卡片注册: ${e.message}`)
    return false
  }

  const entry = entrySnapshot(config)
  let registered = false

  const register = (provider) => {
    const scope = provider.register(TINGXUE_SETTINGS_NS, Config, {
      base: entry,
      // dataDir / 模型 / 端口都是启动期读取的，如实告诉配置界面：下次启动生效
      applies: 'restart',
    })
    // 就地回写入口 config：按次读取的字段（recentRounds / 预算）立即生效
    const apply = () => {
      try {
        Object.assign(config, scope.get())
      } catch (e) { warn(`settings: 回写配置失败: ${e.message}`) }
      // 有些字段不归本插件运行时所有（例如要写给 dsh-notifier 的通知偏好），
      // 由入口注入的 onApply 把它物化到该去的地方。
      try { deps.onApply?.(config) } catch (e) { warn(`settings: onApply 失败: ${e.message}`) }
    }
    apply()
    scope.watch(apply)
    return scope
  }

  // 立即路径：settings 服务已挂载时同步注册，让 init() 能马上读到用户层配置。
  try {
    const settings = ctx.get?.('settings')
    if (settings && typeof settings.register === 'function') {
      register(settings)
      registered = true
    }
  } catch (e) {
    warn(`settings: 直接获取 settings 服务失败: ${e.message}`)
  }

  // 兜底路径：服务可能在插件之后才挂载。回调永不执行 = 老宿主，
  // 插件按 cordis.patch.yml 的配置照常运行（优雅降级，不需要版本判断）。
  if (!registered) {
    try {
      ctx.inject(['settings'], (sctx) => {
        if (registered) return
        try {
          register(sctx.settings)
          registered = true
        } catch (e) {
          warn(`settings: 注册命名空间失败: ${e.message}`)
        }
      })
    } catch (e) {
      warn(`settings: inject 失败，跳过设置卡片注册: ${e.message}`)
    }
  }
  return registered
}
