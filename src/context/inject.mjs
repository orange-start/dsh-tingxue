// dsh-tingxue src/context/inject.mjs
//
// 把听雪上下文注入到聊天会话的 agent 作用域。
//
// 为什么不是在 section.text 里同步返回缓存：
// agent.ts 的 preStep 先 await systemPrompt.assemble()，再发 agent/pre-step。
// 而 assemble() 内部顺序是「逐个同步读 section.text → 再 await system-prompt/assemble 瀑布」
// （system-prompt/index.ts:510-532）。同步读发生在任何异步检索之前，所以
// 「异步预算 + text 同步读缓存」永远只能拿到上一轮的值 —— 首轮空白，之后错位一轮。
//
// 真机表现：人格/记忆块整块时有时无，system 提示词在 6827 与 13872 字符之间抖动，
// 其中 6827 就是「一块都没注入」（DSH 本体裸提示词的大小）。
//
// 唯一能 await 且发生在请求组装时就地的接缝是 system-prompt/assemble 瀑布，
// 且它的返回值是权威装配（同文件 532-541 行）。DSH 自己的 installModelSelection
// 也是这么用的（packages/core/agent/src/model-selection.ts）。

/** 本插件注入的 section 名；就位替换靠它与 order 定位。 */
export const SECTION_NAME = 'dsh-tingxue-context'

/** section 顺序：100（工具指引段 100–199 之外的前部）。 */
export const SECTION_ORDER = 100

/**
 * 建一个「按当前用户输入缓存」的上下文取值器。
 *
 * assemble() 每个 step 都会跑一次；多步回合（工具调用）若每步都 embed + 向量检索
 * 就白烧钱了。同一句输入只算一次：缓存键就是用户输入本身。
 *
 * @param {object} opts
 * @param {() => string} opts.getInput - 取当前用户输入（缓存键）
 * @param {() => Promise<string|null>} opts.build - 真正组装；返回 null 表示
 *   「此刻不该算」（未 ready / agent 模式），此时不落缓存，下轮重算
 * @param {(msg: string) => void} [opts.warn] - 告警
 * @returns {{ get: (force?: boolean) => Promise<string>, invalidate: () => void }}
 */
export function createContextCache(opts) {
  const { getInput, build, warn } = opts
  let cached = ''
  let cachedInput
  let inflightInput
  let inflightPromise
  // 代号：每次「新发起一次组装」或「作废」都递增。
  // 只有代号仍是最新的那次才允许落缓存——否则先发起的慢请求晚回来后，
  // 会用旧输入的检索结果覆盖新输入的结果（用户连发两条消息时就会踩到）。
  let gen = 0

  async function get(force = false) {
    const input = getInput()
    if (!force && cachedInput === input && cachedInput !== undefined) return cached
    if (!force && inflightInput === input && inflightPromise) return inflightPromise
    const myGen = ++gen
    const promise = build().then(
      (text) => {
        const usable = text !== null && text !== undefined
        if (myGen === gen) {
          if (usable) {
            cached = text
            cachedInput = input
          } else {
            // 不该算的状态：清空展示值但不落键，下轮必须重算
            cached = ''
          }
        }
        if (inflightPromise === promise) { inflightPromise = undefined; inflightInput = undefined }
        // 调用方拿到的是「这一次」的结果，即使它已过期也不该被别人的值顶替
        return usable ? text : ''
      },
      (e) => {
        if (warn) warn(`上下文组装失败: ${e?.message ?? e}`)
        if (inflightPromise === promise) { inflightPromise = undefined; inflightInput = undefined }
        return ''
      },
    )
    inflightInput = input
    inflightPromise = promise
    return promise
  }

  return {
    get,
    /**
     * 作废缓存（用户发新消息时调用）。
     * 递增代号，让已在途的旧组装回来时无法落缓存。
     */
    invalidate() {
      cachedInput = undefined
      gen++
    },
  }
}

/**
 * 已挂过注入的 agent。plugin-entry 有两个注入入口（agent/created 与启动补注入），
 * 同一个 agent 可能被走两遍；而 section() 对重名是抛错的（DSH 契约），
 * 挂两遍会白报一条告警。这里做幂等。
 */
const installed = new WeakSet()

/**
 * 给一个 agent 挂上上下文注入（section 占位 + 异步瀑布填真值）。
 *
 * 幂等：同一个 agent 重复调用只生效一次。
 *
 * @param {object} opts
 * @param {object} opts.agent - live agent（需 .ctx 与 .id）
 * @param {(agent: object) => boolean} opts.shouldInject - 是否给这个 agent 注入
 * @param {() => Promise<string>} opts.ensureText - 取当前上下文文本
 * @param {(msg: string) => void} [opts.warn]
 * @returns {boolean} 是否成功挂上（已挂过返回 true）
 */
export function installContextInjection(opts) {
  const { agent, shouldInject, ensureText, warn } = opts
  if (!shouldInject(agent)) return false
  if (!agent?.ctx || typeof agent.ctx.get !== 'function') return false
  if (installed.has(agent)) return true
  const systemPrompt = agent.ctx.get('systemPrompt')
  if (!systemPrompt || typeof systemPrompt.section !== 'function') return false

  // section 只是占位：保住块名与顺序（就位替换靠它），值由下面的瀑布覆盖。
  const section = systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: '',
  })

  const waterfall = agent.ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const assembled = await next()
    // 只认「这个 agent 自己的」装配：context.agent 由 assembleContextFor 带上，
    // scope 继承会让 root 监听器收到别人的装配，不校验就会串线。
    if (context?.agent !== agent) return assembled
    let text = ''
    try {
      text = (await ensureText()) ?? ''
    } catch (e) {
      if (warn) warn(`上下文注入失败: ${e?.message ?? e}`)
    }
    // 就位替换，不 push 到末尾——否则会掉到 order 100–199 的工具指引之后，
    // 改变 DSH 约定的块顺序。
    let replaced = false
    const sections = assembled.sections.map((s) => {
      if (s.name !== SECTION_NAME) return s
      replaced = true
      return { name: SECTION_NAME, text }
    })
    if (!replaced) sections.push({ name: SECTION_NAME, text })
    return { ...assembled, sections }
  })

  if (typeof agent.ctx.effect === 'function') {
    agent.ctx.effect(() => () => {
      installed.delete(agent)
      try { section?.() } catch { /* 已卸载 */ }
      try { waterfall?.() } catch { /* 已卸载 */ }
    })
  }
  installed.add(agent)
  return true
}
