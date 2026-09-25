// dsh-tingxue src/commands/index.mjs
// 关键词命令处理：/agentstart（进入 agent 模式）、/agentstop（退出 agent 模式）。
// 全自动双会话（A 方案）：
//  - /agentstart：用 ctx.agents.create() 新建隔离会话（setup 只注入听雪档案 + 拦截 /agentstop），
//    然后自动写 dsh-notifier 的 bind 键，把 QQ 对话投到新会话。
//  - /agentstop：归档对话+文件摘要到记忆库 → 删文件 → dispose 隔离会话 → 自动 bind 回聊天会话。
// 全程只有 /agentstart /agentstop 两条指令，QQ 一进来就是聊天会话。

import { readFile } from 'node:fs/promises'
import { setBindingDetailed, getBinding, setAgentRoute, deleteAgentRoute } from '../bind/index.mjs'
import { segmentText } from '../segment.mjs'

/**
 * 写「退出 agent 模式」的绑定。优先回绑聊天会话；失败则**清掉指向隔离会话的绑定键**。
 *
 * 为什么不能像旧实现那样只 warn 一句就继续：旧实现回绑失败后仍然 `state.exitAgent()`，
 * 于是 `mode=chat` 而 `bind:qq:*` 还指着那个隔离会话——而且隔离会话随后就被 dispose 了。
 * 结果 QQ 消息投向一个**已经不存在的会话**，上下文注入却按聊天模式走。
 * 实测 20:59 那次失败就是这样留下一个 296 字节空壳会话（一个事件都没收到）。
 *
 * 三级降级：① 回绑聊天会话 → ② 清空绑定键（回落 notifier 默认投递）
 * → ③ 两样都失败时如实上报 `unresolved`，由调用方在回执里明说，绝不假装正常。
 *
 * @returns {Promise<{ok: boolean, cleared: boolean, unresolved: boolean, error?: Error, detail?: string}>}
 */
async function writeExitBinding(channel, userId, chatSessionId, stateFile, warn) {
  if (chatSessionId) {
    const r = await setBindingDetailed(channel, userId, chatSessionId, stateFile)
    if (r.ok) return { ok: true, cleared: false, unresolved: false }
    warn(
      `自动 bind 回聊天会话写盘失败（已重试 ${r.attempts} 次 / ${r.elapsedMs}ms）: ` +
      `${r.diagnosis ?? r.error?.message}；改为清空绑定键，避免 QQ 继续投隔离会话`,
    )
    const clear = await setBindingDetailed(channel, userId, '', stateFile)
    if (clear.ok) return { ok: false, cleared: true, unresolved: false, error: r.error, detail: r.diagnosis }
    warn(`清空绑定键同样失败: ${clear.diagnosis ?? clear.error?.message}`)
    return { ok: false, cleared: false, unresolved: true, error: r.error, detail: r.diagnosis }
  }
  // 没有可信聊天会话可回绑：至少别把 QQ 留在隔离会话上
  const clear = await setBindingDetailed(channel, userId, '', stateFile)
  return {
    ok: false,
    cleared: clear.ok,
    unresolved: !clear.ok,
    detail: '无可信聊天会话（chatSessionId 为空）',
  }
}

/**
 * 创建命令处理器。
 * @param {object} deps
 * @param {object} deps.state - 状态管理器
 * @param {object} deps.notifier - ctx.notifier（出站推送）
 * @param {object} deps.agents - ctx.agents（会话创建/销毁）
 * @param {object} deps.config - { agentStartKeyword, agentStopKeyword, profilePath, dataDir, notifierStateFile, channel, userId }
 * @param {object} deps.logger
 */
export function createCommandHandler(deps) {
  const { state, notifier, agents, config = {}, logger, defaultModel: depsDefaultModel } = deps
  const dm = config.defaultModel ?? depsDefaultModel ?? {}
  const startKw = config.agentStartKeyword ?? '/agentstart'
  const stopKw = config.agentStopKeyword ?? '/agentstop'
  const profilePath = config.profilePath || ''
  const stateFile = config.notifierStateFile
  const channel = config.channel ?? 'qq'
  const userId = config.userId ?? ''
  const warn = (m) => { try { logger?.warn?.('[dsh-tingxue/commands]', m) } catch {} }
  const info = (m) => { try { logger?.info?.('[dsh-tingxue/commands]', m) } catch {} }

  // 当前活跃的隔离会话 handle（/agentstop 时 dispose）
  let agentHandle = null
  // 当前活跃的隔离会话 id（route 清理用，取自创建时生成的 sessionId）
  let activeAgentSessionId = null
  // 最近一次退出时的回绑结果（供回执说明是否已回到聊天会话）
  let exitBinding = null

  /** 判断文本是否为命令。 */
  function isCommand(text) {
    const t = String(text ?? '').trim()
    return t === startKw || t === stopKw
  }

  /** 读取听雪档案文本（agent 会话 setup 注入用）。 */
  async function readProfile() {
    if (!profilePath) return ''
    try {
      return await readFile(profilePath, 'utf-8')
    } catch (e) {
      warn(`读取听雪档案失败: ${e.message}`)
      return ''
    }
  }

  /**
   * 新建隔离 agent 会话并自动 bind。
   * setup 里只注入听雪档案（不含聊天记忆/历史）。
   * /agentstop 由 plugin-entry 的全局 pre-step 拦截处理（对所有 agent 生效）。
   *
   * **顺序：先写绑定，再建会话**（t3 修复，2026-09-25 实测驱动）。
   * 旧顺序是「先 create 再 bind」，结果是绑定写盘失败时磁盘上已经躺着一个
   * 295–298 字节的空壳隔离会话（本机实测 5 个：12:53/13:18/13:26/16:51/20:59。
   * create() 只写 session 头 4 条记录就返回，setup 不抛错，所以 create 成功≠有事发生）。
   * 先写绑定把「可能失败且不可回滚」的那一步放到最前：绑定失败时**根本没建会话**，
   * 也就不可能留下空壳。绑定成功后才 create；create 失败则把绑定回滚到原值。
   *
   * @returns {Promise<{ok: boolean, sessionId?: string, reason?: string, bindError?: Error,
   *   bindDiagnosis?: string, bindSuggestion?: string, rolledBack?: boolean}>}
   */
  async function createIsolatedAgent() {
    if (!agents || typeof agents.create !== 'function') {
      return { ok: false, reason: 'agents 服务不可用（无法创建隔离会话）' }
    }
    const sessionId = `tingxue-agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const profileText = await readProfile()
    // 默认模型：优先用配置显式 provider/model，否则用 DSH 的 agentDefaultModel 当前选择。
    // 必须提供 model，否则 deployment:persona 的 {{model}} 模板变量无值 → 会话无法回复。
    const provider = config.provider ?? dm.provider
    const model = config.model ?? dm.model

    // ---- 1) 先写绑定（失败则不建会话 → 不留空壳）----
    // 记下原绑定，create 失败时要回滚到这个值（而不是简单删除键）。
    // 读取失败**不能裸吞**：那会让「回滚到原值」静默退化成「删除绑定键」，
    // 而调用方与日志都拿不到原因（失败路径要可定位）。
    let prevBinding = null
    let prevBindingReadError = null
    try {
      prevBinding = await getBinding(channel, userId, stateFile)
    } catch (e) {
      prevBindingReadError = e instanceof Error ? e : new Error(String(e))
      warn(`读取原绑定失败，回滚将退化为删除绑定键: ${e?.code ?? ''} ${e?.message ?? e}`)
    }
    const hadPrevBinding = typeof prevBinding === 'string' && prevBinding !== ''
    const bindResult = await setBindingDetailed(channel, userId, sessionId, stateFile)
    if (!bindResult.ok) {
      warn(`自动 bind 写盘失败，已放弃进入 agent 模式（未创建隔离会话，避免留空壳）: ${bindResult.diagnosis ?? bindResult.error?.message ?? '未知原因'}`)
      return {
        ok: false,
        // bound:false 保持既有契约（调用方判据：绑定没切成就绝不进 agent 模式）
        bound: false,
        sessionId,
        bindError: bindResult.error,
        bindDiagnosis: bindResult.diagnosis,
        bindSuggestion: bindResult.suggestion,
        bindAttempts: bindResult.attempts,
        bindElapsedMs: bindResult.elapsedMs,
        hadPrevBinding,
        prevBindingReadError,
        reason: bindResult.diagnosis ?? bindResult.error?.message ?? '未知原因',
      }
    }
    info(`隔离会话绑定已写入：bind:${channel}:${userId} → ${sessionId}`)

    // ---- 2) 再建会话；失败要把绑定回滚，否则 QQ 指向一个不存在的会话 ----
    let handle = null
    try {
      handle = await agents.create({
        sessionId,
        agentOptions: { provider, model },
        // meta.cwd 提供 {{cwd}} 模板变量（deployment:persona 引用），缺省则无值报错
        meta: { cwd: config.cwd || process.cwd() },
        setup: async (agentCtx) => {
          // 只注入听雪档案（agent 会话隔离：不含聊天记忆/历史）
          if (profileText) {
            const section = agentCtx.get('systemPrompt')?.section?.({
              name: 'dsh-tingxue-agent-profile',
              order: 0,
              text: () => profileText,
            })
            if (section) agentCtx.effect(() => section)
          }
        },
      })
    } catch (e) {
      warn(`创建隔离会话失败，回滚绑定: ${e.message}`)
      // 回滚绑定：恢复原值（或删除键），绝不让 QQ 指向刚建失败的会话。
      // hadPrevBinding 决定语义：原本有值 → 'restored'；原本无值 → 'cleared'
      // （删键 ≡ 本就不存在，不是数据丢失；但**文案必须据实**，不能对
      //  「本来就没有绑定」声称「已回滚到原聊天会话」）。
      const restore = await setBindingDetailed(channel, userId, prevBinding ?? '', stateFile)
      // 回滚类型：先用「回滚调用是否成功」定，再按 hadPrevBinding 细化语义。
      let rolledBack = restore.ok ? (hadPrevBinding ? 'restored' : 'cleared') : 'failed'
      // 读取原绑定失败时，连“原本有没有值”都不知道，只能是「回滚为删除键」。
      if (restore.ok && prevBindingReadError) rolledBack = 'cleared'
      if (!restore.ok) {
        warn(`回滚绑定失败（QQ 可能仍指向失败会话 ${sessionId}）: ${restore.diagnosis ?? restore.error?.message}`)
      }
      return {
        ok: false,
        reason: `创建隔离会话失败：${e.message}`,
        createError: e,
        rolledBack,
        // 回滚调用本身是否成功（与 rolledBack 的语义区分：rolledBack 带 restored/cleared 细分）
        rollbackOk: restore.ok,
        hadPrevBinding,
        prevBindingReadError,
        // 兼容既有字段名：bindError 仍指本次失败的错误对象（此处即 create 的错误）
        bindError: e,
      }
    }

    // create 成功：此刻才把 handle 提交到闭包状态（此前失败都不污染共享状态）
    agentHandle = handle
    activeAgentSessionId = sessionId
    // 精确放行 agent 会话的出站通知（覆盖 workspace 静默），让其状态/审批也送达 QQ
    try {
      await setAgentRoute(sessionId, { channels: ['qq-bot'] }, stateFile)
    } catch (e) {
      warn(`放行 agent 会话出站失败: ${e.message}`)
    }
    return { ok: true, sessionId, bound: true }
  }

  /**
   * 退出 agent 模式：归档 + 删文件 + dispose 隔离会话 + 自动 bind 回聊天会话。
   */
  async function handleStop() {
    // 1. 归档对话到记忆库 + 删文件（由 agent 服务处理）
    try {
      const rounds = (deps.pendingAgentRounds ?? []).filter((r) => r.user || r.assistant)
      await deps.agentService?.exitAndArchive?.(rounds, deps.workFiles ?? [])
      // 清空待归档
      if (Array.isArray(deps.pendingAgentRounds)) deps.pendingAgentRounds.length = 0
    } catch (e) {
      warn(`agent 归档失败: ${e.message}`)
    }

    // 2. 自动 bind 回聊天会话（先 bind，确保后续 QQ 消息回到聊天会话）
    //    回绑失败时**绝不**留下「mode=chat 但绑定还指着隔离会话」的漂移：
    //    旧实现只在失败时 warn 一句就继续 exitAgent()，QQ 会继续投隔离会话，
    //    而上下文注入只在聊天模式生效 → 听雪对着一个空壳会话说话。
    exitBinding = await writeExitBinding(channel, userId, state.chatSessionId, stateFile, warn)
    if (exitBinding.cleared) {
      info('退出 agent 模式：回绑失败，已清空绑定键（避免 QQ 继续投隔离会话）')
    }

    // 3. 状态机回聊天模式
    await state.exitAgent()

    // 4. 清理隔离残留（删路由 + 延迟 dispose 会话；dispose 务必在绑定处理之后，
    //    否则会出现「绑定指向已销毁会话」的窗口）
    disposeActiveIsolation()
  }

  /**
   * 清掉组件维护的 isolation 残留：删 agent 会话的精确放行路由 + 延迟 dispose 会话。
   *
   * 为什么走 setImmediate 延迟 dispose：/agentstop 是在 agent/pre-step 瀑布里处理的，
   * 同步销毁正在跑的 agent 会打断当前 turn。
   *
   * 注：旧实现还有一个专门的 `rollbackIsolatedAgent()`（供 /agentstart 失败时回滚刚建的
   * 会话）。改成「先写绑定、再建会话」后，绑定失败时**根本没建会话**，那条回滚路径
   * 永远不可达，已删除——这也是「失败不留空壳会话」从源头成立的证明。
   */
  function disposeActiveIsolation() {
    const handle = agentHandle
    const agentSessionId = activeAgentSessionId
    agentHandle = null
    activeAgentSessionId = null
    if (agentSessionId) {
      // 清理 agent 会话路由：删除精确放行条目（回落 workspace 静默），避免残留放行
      deleteAgentRoute(agentSessionId, stateFile)
        .catch((e) => warn(`清理 agent 会话路由失败: ${e.message}`))
    }
    if (handle && typeof handle.dispose === 'function') {
      setImmediate(() => {
        handle.dispose().catch((e) => warn(`销毁隔离会话失败: ${e.message}`))
      })
    }
  }

  /** 处理命令，返回 true 表示已消费（不进入模型）。 */
  async function handle(text) {
    const t = String(text ?? '').trim()
    if (t === startKw) {
      if (state.isAgentMode()) {
        await push('已在 agent 模式，无需重复进入。')
        return true
      }
      const result = await createIsolatedAgent()
      if (!result.ok) {
        // 注意：绑定写盘失败走的也是这里（createIsolatedAgent 会返回 ok:false + bound:false）。
        // 所以**必须**在这个分支就把诊断与建议一起报出来；只在 !result.bound 分支里写文案
        // 会变成死代码——用户永远看不到真因（实测踩过：只收到一句笼统的失败文案）。
        const code = result.bindError?.code
        const advice = result.bindSuggestion
        const detail = String(result.reason ?? '未知错误')
        // 诊断文案里常常已经写了错误码（如「…会报 EPERM」），别重复一次。
        const codeSuffix = code && !detail.includes(code) ? `（${code}）` : ''
        const lines = [`进入 agent 模式失败：${detail}${codeSuffix}`]
        if (result.bound === false) {
          lines.push('已保持聊天模式，且未创建隔离会话（不留空壳）。')
          if (advice) lines.push(advice)
        } else if (result.rolledBack === 'restored') {
          lines.push('已保持聊天模式，并把 QQ 绑定回滚到原聊天会话。')
        } else if (result.rolledBack === 'cleared') {
          // 原绑定读取失败时不能声称“回滚到原值”——只能说回滚为删除键
          lines.push(result.prevBindingReadError
            ? `已保持聊天模式，并已清除本次写入的绑定键（原绑定读取失败，无法回滚到原值：${result.prevBindingReadError.message}）。`
            : '已保持聊天模式；原本没有绑定，已清除本次写入的绑定键。')
        } else if (result.rolledBack === 'failed') {
          lines.push('⚠️ QQ 绑定回滚失败，下次 /agentstart 会自动纠正；也可自行重发消息触发自愈。')
        }
        await push(lines.join('\n'))
        return true
      }
      if (!result.bound) {
        // 防御性兜底：正常不会走到（绑定失败已在上面返回 ok:false）。
        // 进 agent 模式只会让 QQ 继续投聊天会话、而注入被置空，所以宁可留在聊天模式。
        await push([
          '进入 agent 模式失败：QQ 绑定未切换，已保持聊天模式。',
          '（若强行进入，QQ 仍投聊天会话、人格与记忆注入却会被关掉。）',
          '稍后重试 /agentstart 即可。',
        ].join('\n'))
        return true
      }
      await state.enterAgent(result.sessionId)
      await push([
        '已进入 agent 模式（隔离文件处理会话）。',
        '你可以直接发文件或文字，我会在这个隔离会话里处理。',
        '退出请发送 /agentstop。',
      ].join('\n'))
      return true
    }
    if (t === stopKw) {
      if (!state.isAgentMode()) {
        await push('当前不在 agent 模式。')
        return true
      }
      await handleStop()
      if (exitBinding && !exitBinding.ok) {
        if (exitBinding.unresolved) {
          await push([
            '已退出 agent 模式，但 QQ 绑定既未回绑也没能清空（写盘持续失败）。',
            '请再发一句话给听雪——若收不到回复，说明绑定仍指向已销毁的隔离会话；此时重发 /agentstart 再 /agentstop 即可复位。',
          ].join('\n'))
        } else if (exitBinding.cleared) {
          await push('已退出 agent 模式。注意：回绑聊天会话失败，已清空绑定——请给听雪发条消息确认收到。')
        } else {
          await push('已退出 agent 模式，回到日常聊天。')
        }
      } else {
        await push('已退出 agent 模式，回到日常聊天。')
      }
      return true
    }
    return false
  }

  /** 通过 notifier 推送回执到 QQ（超长时句子完整分段）。 */
  async function push(content) {
    try {
      if (notifier && typeof notifier.push === 'function') {
        const segments = segmentText(String(content ?? ''), { maxCodepoints: 2000 })
        for (const seg of segments) {
          await notifier.push({ title: '听雪', content: seg }, { sourceName: 'dsh-tingxue' })
        }
      }
    } catch (e) {
      warn(`命令回执推送失败: ${e.message}`)
    }
  }

  return { isCommand, handle }
}
