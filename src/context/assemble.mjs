// dsh-tingxue src/context/assemble.mjs
// 聊天模式上下文组装（缓存命中优先，顺序固定）：
//   [1] 听雪档案 —— 从指定 txt 读取，固定不变（稳定缓存前缀）
//   [2] 向量记忆检索结果 —— 按当前输入语义检索，有界（800–2000 token），命中才插入
//   [3] 最近 N 轮原始对话 —— 默认关闭（会话历史已含，注入即重复；见下方说明）
//   [4] 最新信息 —— 最近文件摘要/待办，有界（≤1000 token）
//
// 前缀稳定（[1] 恒定 + [2] 有界）、后缀滑动。
// 每块带来源标记与预算上限。

import { readFile } from 'node:fs/promises'

/** 粗略 token 估算（中文按字，英文按词）。 */
export function estimateTokens(text) {
  const s = String(text ?? '')
  const cjk = (s.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length
  const other = s.replace(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g, ' ').trim()
  const words = other.length === 0 ? 0 : other.split(/\s+/).length
  return cjk + words
}

/**
 * 组装聊天模式上下文。
 * @param {object} opts
 * @param {string} opts.profilePath - 听雪档案 txt 路径
 * @param {string} opts.currentInput - 当前用户输入
 * @param {object} opts.memory - 记忆服务（searchMemories + expandFromEntities）
 * @param {object} opts.model - 模型适配器（embed）
 * @param {Array} opts.recentRounds - 最近 N 轮 [{user, assistant}]
 * @param {object} opts.config - { memoryBudgetTokens, latestInfoBudgetTokens, recentRounds }
 * @returns {Promise<{ blocks: Array<{name, content, tokens}>, totalTokens: number }>}
 */
export async function assembleContext(opts) {
  const {
    profilePath, currentInput, memory, model,
    recentRounds = [], config = {},
  } = opts
  const memoryBudget = config.memoryBudgetTokens ?? 1600
  const latestBudget = config.latestInfoBudgetTokens ?? 1000
  const recentN = config.recentRounds ?? 30

  const blocks = []

  // [1] 听雪档案（固定前缀）
  let profileText = ''
  if (profilePath) {
    try {
      profileText = await readFile(profilePath, 'utf-8')
    } catch (e) {
      profileText = `（听雪档案读取失败：${e.message}）`
    }
  }
  blocks.push({ name: '听雪档案', content: profileText, tokens: estimateTokens(profileText) })

  // [2] 向量记忆检索（有界，命中才插入）
  let memoryBlock = ''
  if (currentInput && memory) {
    try {
      const vec = await model.embed([currentInput])
      const hits = await memory.searchMemories(vec[0], { limit: 8 })
      if (hits.length > 0) {
        // 关系增强：从命中记忆的实体扩展
        const entityIds = hits.flatMap((h) => h.entityIds ?? [])
        let related = []
        if (entityIds.length > 0 && memory.expandFromEntities) {
          const exp = await memory.expandFromEntities(entityIds, { depth: 1, limit: 5 })
          related = exp.relatedEntities.map((e) => `[实体] ${e.name}（${e.type}）：${e.summary}`)
        }
        const lines = [
          '【相关记忆】',
          ...hits.map((h) => `- ${h.text}`),
          ...related.map((r) => `- ${r}`),
        ]
        memoryBlock = lines.join('\n')
        // 超预算截断
        while (estimateTokens(memoryBlock) > memoryBudget && hits.length > 0) {
          hits.pop()
          memoryBlock = ['【相关记忆】', ...hits.map((h) => `- ${h.text}`), ...related.map((r) => `- ${r}`)].join('\n')
        }
      }
    } catch (e) {
      memoryBlock = ''
    }
  }
  if (memoryBlock) blocks.push({ name: '记忆检索', content: memoryBlock, tokens: estimateTokens(memoryBlock) })

  // [3] 最近 N 轮原始对话（滑动窗口）
  //
  // 默认不注入。DSH 会话本身就是「全部交互历史的仅追加真源，LLM 消息历史由它派生」，
  // 最近对话本来就在会话历史里；再塞进 system 一遍 = 同一段话在模型眼里出现两次，
  // 实测每轮白付约 1.5K token。只有会话历史不可用时（换绑到新会话、历史被清空）
  // 才需要打开：config.injectRecentRounds === true。
  if (config.injectRecentRounds === true) {
    const recent = recentRounds.slice(-recentN)
    let recentBlock = ''
    if (recent.length > 0) {
      recentBlock = ['【最近对话】', ...recent.map((r) => `用户：${r.user}\n听雪：${r.assistant}`)].join('\n')
    }
    blocks.push({ name: '最近对话', content: recentBlock, tokens: estimateTokens(recentBlock) })
  }

  // [4] 最新信息（有界）
  let latestBlock = ''
  if (memory && memory.listLatest) {
    try {
      const latest = await memory.listLatest({ limit: 5 })
      if (latest.length > 0) {
        latestBlock = ['【最新信息】', ...latest.map((l) => `- ${l.text}`)].join('\n')
        while (estimateTokens(latestBlock) > latestBudget && latest.length > 0) {
          latest.pop()
          latestBlock = ['【最新信息】', ...latest.map((l) => `- ${l.text}`)].join('\n')
        }
      }
    } catch { latestBlock = '' }
  }
  if (latestBlock) blocks.push({ name: '最新信息', content: latestBlock, tokens: estimateTokens(latestBlock) })

  const totalTokens = blocks.reduce((sum, b) => sum + b.tokens, 0)
  return { blocks, totalTokens }
}

/** 把组装好的块拼成注入管线的 system 文本。 */
export function blocksToSystemText(blocks) {
  return blocks
    .filter((b) => b.content && b.content.trim() !== '')
    .map((b) => b.content)
    .join('\n\n')
}
