// dsh-tingxue src/state/index.mjs
// 双模式状态机：聊天模式（默认）↔ agent 模式（按需开启）。
// 状态持久化到 JSON 文件（dataDir/state.json），崩溃可恢复。

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const MODES = { CHAT: 'chat', AGENT: 'agent' }

/**
 * 创建状态管理器。
 * @param {object} config - { dataDir }
 */
export async function createStateManager(config) {
  const dataDir = config.dataDir
  const stateFile = join(dataDir, 'state.json')
  await mkdir(dataDir, { recursive: true })

  // 保留上限：注入只取最近 recentRounds 轮，多留几倍做缓冲就够了。
  // 不能无上限堆——persist() 每轮把整个数组重写一遍，数组越大写放大越狠。
  const recentN = Number(config.recentRounds) > 0 ? Number(config.recentRounds) : 10
  const maxStored = Number(config.maxStoredRounds) > 0
    ? Number(config.maxStoredRounds)
    : Math.max(recentN * 3, 50)

  let state = {
    mode: MODES.CHAT,
    agentSessionId: null,   // agent 模式绑定的隔离会话 id
    chatSessionId: null,    // 日常聊天会话 id
    recentRounds: [],       // 最近 N 轮 [{user, assistant}]
    latestInfo: [],         // 最新信息（文件摘要/待办）
  }

  // 加载持久化状态
  try {
    const raw = await readFile(stateFile, 'utf-8')
    const saved = JSON.parse(raw)
    state = { ...state, ...saved }
    // 历史遗留：早期版本无限累积，加载时先裁一次，避免旧的大数组一直背着
    if (Array.isArray(state.recentRounds) && state.recentRounds.length > maxStored) {
      state.recentRounds = state.recentRounds.slice(-maxStored)
    }
  } catch { /* 首次运行 */ }

  async function persist() {
    try {
      await writeFile(stateFile, JSON.stringify(state, null, 2), 'utf-8')
    } catch (e) {
      // 持久化失败不致命
    }
  }

  return {
    get mode() { return state.mode },
    get agentSessionId() { return state.agentSessionId },
    get chatSessionId() { return state.chatSessionId },
    get recentRounds() { return state.recentRounds },
    get latestInfo() { return state.latestInfo },

    isAgentMode() { return state.mode === MODES.AGENT },

    /** 设置聊天会话 id（插件启动时从 dsh-notifier 当前绑定读取）。 */
    async setChatSessionId(sessionId) {
      state.chatSessionId = sessionId
      await persist()
    },

    /** 进入 agent 模式。 */
    async enterAgent(agentSessionId) {
      state.mode = MODES.AGENT
      state.agentSessionId = agentSessionId
      await persist()
    },

    /** 退出 agent 模式，回到聊天模式。 */
    async exitAgent() {
      state.mode = MODES.CHAT
      state.agentSessionId = null
      await persist()
    },

    /** 追加一轮对话（用户 + AI）。 */
    async pushRound(user, assistant) {
      state.recentRounds.push({ user, assistant })
      // 滑动窗口：超出上限丢弃最旧的（注入只取最近 recentRounds 轮，
      // 留 maxStored 倍缓冲；此前只 push 不裁剪，state.json 会无限增长）
      if (state.recentRounds.length > maxStored) {
        state.recentRounds = state.recentRounds.slice(-maxStored)
      }
      await persist()
    },

    /** 追加最新信息（文件摘要/待办）。 */
    async pushLatest(kind, text) {
      state.latestInfo.push({ kind, text, createdAt: Date.now() })
      // 有界：最多保留 20 条
      if (state.latestInfo.length > 20) state.latestInfo = state.latestInfo.slice(-20)
      await persist()
    },

    /** 清空最近对话（agent 模式退出后归档用）。 */
    async clearRounds() {
      state.recentRounds = []
      await persist()
    },

    MODES,
  }
}
