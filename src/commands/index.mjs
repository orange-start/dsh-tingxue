// dsh-tingxue src/commands/index.mjs
// 关键词命令处理：/agentstart（进入 agent 模式）、/agentstop（退出 agent 模式）。
// 全自动双会话（A 方案）：
//  - /agentstart：用 ctx.agents.create() 新建隔离会话（setup 只注入听雪档案 + 拦截 /agentstop），
//    然后自动写 dsh-notifier 的 bind 键，把 QQ 对话投到新会话。
//  - /agentstop：归档对话+文件摘要到记忆库 → 删文件 → dispose 隔离会话 → 自动 bind 回聊天会话。
// 全程只有 /agentstart /agentstop 两条指令，QQ 一进来就是聊天会话。

import { readFile } from 'node:fs/promises'
import { setBinding, setBindingDetailed, setAgentRoute, deleteAgentRoute } from '../bind/index.mjs'
import { segmentText } from '../segment.mjs'

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
   * @returns {Promise<{ok: boolean, sessionId?: string, reason?: string}>}
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
    try {
      const handle = await agents.create({
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
      agentHandle = handle
      activeAgentSessionId = sessionId
      // 精确放行 agent 会话的出站通知（覆盖 workspace 静默），让其状态/审批也送达 QQ
      try {
        await setAgentRoute(sessionId, { channels: ['qq-bot'] }, stateFile)
      } catch (e) {
        warn(`放行 agent 会话出站失败: ${e.message}`)
      }
      // 自动 bind：把 QQ 对话投到新会话
      const bindResult = await setBindingDetailed(channel, userId, sessionId, stateFile)
      const bound = bindResult.ok
      if (!bound) warn(`自动 bind 写盘失败（QQ 消息可能仍投到聊天会话）: ${bindResult.error?.message ?? '未知原因'}`)
      // bound 必须回传给调用方：bind 没切成时绝不能进入 agent 模式。
      // 否则 QQ 仍投聊天会话，而 agent 模式会把上下文注入置空
      // = 既丢了人格/记忆，又没有真正隔离（静默失忆的最坏组合）。
      return { ok: true, sessionId, bound, bindError: bindResult.error }
    } catch (e) {
      warn(`创建隔离会话失败: ${e.message}`)
      return { ok: false, reason: e.message }
    }
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
    const chatSessionId = state.chatSessionId
    if (chatSessionId) {
      const bound = await setBinding(channel, userId, chatSessionId, stateFile)
      if (!bound) warn('自动 bind 回聊天会话写盘失败')
    }

    // 3. 状态机回聊天模式
    await state.exitAgent()

    // 4. dispose 隔离会话（延迟到当前 turn 结束后，避免在 pre-step 内销毁正在运行的 agent）
    const handle = agentHandle
    const agentSessionId = activeAgentSessionId
    agentHandle = null
    activeAgentSessionId = null
    if (agentSessionId) {
      // 清理 agent 会话路由：删除精确放行条目（回落 workspace 静默），避免残留放行
      try { await deleteAgentRoute(agentSessionId, stateFile) } catch (e) { warn(`清理 agent 会话路由失败: ${e.message}`) }
    }
    if (handle && typeof handle.dispose === 'function') {
      setImmediate(() => {
        handle.dispose().catch((e) => warn(`销毁隔离会话失败: ${e.message}`))
      })
    }
  }

  /**
   * 回滚刚创建的隔离会话（dispose + 清精确放行路由）。
   * 用于 /agentstart 失败时不留残留——否则会积一堆 295 字节的空壳会话。
   */
  async function rollbackIsolatedAgent() {
    const handle = agentHandle
    const agentSessionId = activeAgentSessionId
    agentHandle = null
    activeAgentSessionId = null
    if (agentSessionId) {
      try { await deleteAgentRoute(agentSessionId, stateFile) } catch (e) { warn(`清理 agent 会话路由失败: ${e.message}`) }
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
        await push(`进入 agent 模式失败：${result.reason ?? '未知错误'}`)
        return true
      }
      if (!result.bound) {
        // 绑定没切成：进 agent 模式只会让 QQ 继续投聊天会话、而注入被置空。
        // 直接回滚 + 保持聊天模式，比"静默失忆且没隔离"好得多。
        await rollbackIsolatedAgent()
        const why = result.bindError?.message ? `（原因：${result.bindError.message}）` : ''
        await push([
          `进入 agent 模式失败：切换 QQ 绑定失败，已保持聊天模式。${why}`,
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
      await push('已退出 agent 模式，回到日常聊天。')
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
