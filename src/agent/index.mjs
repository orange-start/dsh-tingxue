// dsh-tingxue src/agent/index.mjs
// agent 模式：隔离的纯文件处理会话。
//  - 进入：/agentstart（插件新建隔离会话 + 自动绑定）
//  - 文件作为上下文持续处理，可多轮（文件下载/注入见 plugin-entry 的 pre-step 链路）
//  - 退出：/agentstop → 删除工作副本 → 归档对话+摘要到记忆库 → 回聊天模式
//
// 文件生命周期：
//  - 聊天模式内发文件：pre-step 下载到 workcopy → 注入上下文 → 处理
//  - agent 模式退出：删除工作副本与中间产物，保留原始文件（fileDeleteScope: 'workcopy'）

import { unlink } from 'node:fs/promises'

/**
 * 创建 agent 模式服务。
 * @param {object} deps
 * @param {object} deps.state - 状态管理器
 * @param {object} deps.memory - 记忆服务（addMemory）
 * @param {object} deps.graph - 关系图谱服务（ingest，可空）
 * @param {object} deps.model - 模型适配器
 * @param {object} deps.config - { fileDeleteScope, dataDir }
 * @param {object} deps.logger
 */
export function createAgentService(deps) {
  const { state, memory, graph, model, config = {}, logger } = deps
  const warn = (m) => { try { logger?.warn?.('[dsh-tingxue/agent]', m) } catch {} }
  const deleteScope = config.fileDeleteScope ?? 'workcopy'

  /**
   * agent 模式退出：删除文件 + 归档对话到记忆库。
   * @param {Array} rounds - 本会话文字对话 [{user, assistant}]
   * @param {string[]} workFiles - 工作副本/中间产物路径
   */
  async function exitAndArchive(rounds = [], workFiles = []) {
    // 1. 删除文件（默认删工作副本与中间产物，保留原始）
    if (deleteScope === 'workcopy') {
      for (const f of workFiles) {
        try { await unlink(f) } catch { /* 文件可能已删 */ }
      }
    }

    // 2. 归档对话到记忆库
    if (rounds.length > 0) {
      const conversationText = rounds
        .map((r) => `用户：${r.user}\n听雪：${r.assistant}`)
        .join('\n')
      const vec = await model.embed([conversationText])
      await memory.addMemory({
        text: `【agent 会话归档】\n${conversationText}`,
        vector: vec[0],
        scene: 'agent',
        source: 'agent',
      })
      try {
        if (graph) await graph.ingest(conversationText, { source: 'agent' })
      } catch (e) {
        warn(`agent 归档实体抽取失败: ${e.message}`)
      }
    }

    // 3. 清空最近对话
    await state.clearRounds()
    return { archived: rounds.length > 0 }
  }

  return { exitAndArchive }
}
