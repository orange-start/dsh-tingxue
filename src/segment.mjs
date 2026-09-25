// dsh-tingxue src/segment.mjs
// 听雪 · 聊天回复 QQ 分段投递（方案 B 实现）。
//
// 约束（t1 调研确认）：聊天回复由 dsh-notifier 出站链路直接投递（agent 产出 →
// replyViaChannel → QQ postMessage → String(content).slice(0,2000) 硬截断），
// 该链路不经过 dsh-tingxue 插件、没有出站 hook 可接管。
//
// 本模块提供「句子完整不截断」的分段器，供插件自己可控的输出通道
// （命令回执 / agent 模式状态等经 notifier.push 的内容）在投递前按
// maxCodepoints（默认 2000 码点，匹配 QQ 单条上限）切段：
//   - 优先在句末分隔符（。？！… 等）后切，保证每段以完整句子收尾；
//   - 若某整句放不进当前段预算，则整句整体移到下一条，绝不留下半截句；
//   - 段号前缀（i/n）计入预算（参考 dsh-notifier segmentText 的递归收敛）。
//
// 不依赖 dsh-notifier 任何内部实现，纯逻辑、可单独单元测试。

/** Unicode 码点计数（代理对算 1）。 */
export function countCodepoints(text) {
  return Array.from(String(text ?? '')).length
}

// 句末分隔符（中文句点 / 问号 / 感叹号 / 省略号，可后跟引号、括号、空格）。连续匹配取最后。
// 省略号 '…' 与英文省略号 '...' 都视为句末。后随的闭合引号/括号归入本句（不拆到下一段）。
const SENTENCE_END_RE = /[。？！…!?][”’』」）】\s]*$/u

/** 在 chars[0..budget] 内找到最后一个「句末分隔符后」的切点（不含切点自身）。
 *  返回 [cutAt, isSentenceCut]；cutAt<=0 表示范围内无句末分隔符。 */
function lastSentenceCut(chars, budget) {
  // 从预算末尾往前扫，找到最近的一个句末分隔符位置并往后吃闭合引号等。
  const searchLen = Math.min(budget, chars.length)
  // 用字符串从 index 0 构建子串找句末；从后往前试每一个分隔符位置
  let cutAt = -1
  for (let i = searchLen - 1; i >= 0; i -= 1) {
    const c = chars[i]
    if (c === '。' || c === '？' || c === '！' || c === '…' || c === '!' || c === '?') {
      // 已确定句末分隔符在 i；检查其后是否紧跟闭合引号/括号/空白（同属本句）
      let j = i
      while (j + 1 < searchLen) {
        const nc = chars[j + 1]
        if (nc === '”' || nc === '’' || nc === '』' || nc === '」' || nc === '）' || nc === '】' || nc === ' ' || nc === '　') {
          j += 1
        } else {
          break
        }
      }
      cutAt = j + 1 // 切在分隔符（含闭合符号）之后
      break
    }
  }
  if (cutAt <= 0) return [0, false]
  return [cutAt, true]
}

/**
 * 把长文本切成每段 ≤ maxCodepoints（含段号前缀）的多段，段间尽量落在句末。
 *  短文本（≤预算）原样返回单段（零开销，不加前缀）。
 *  段号前缀 `（i/n）` 计入预算（递归收敛，两轮内必稳定）。
 * @param {string} text 待分段文本
 * @param {{ maxCodepoints?: number, noPrefix?: boolean }} [opts]
 * @returns {string[]}
 */
export function segmentText(text, { maxCodepoints = 2000, noPrefix = false } = {}) {
  const raw = String(text ?? '')
  const chars = Array.from(raw)
  const limit = Number.isFinite(maxCodepoints) && maxCodepoints > 0 ? Math.floor(maxCodepoints) : 2000
  if (chars.length === 0) return ['']
  if (chars.length <= limit) return [raw]

  let n = Math.max(1, Math.ceil(chars.length / limit))
  for (let round = 0; round < 8; round += 1) {
    const prefixLen = noPrefix ? 0 : Array.from(`（${n}/${n}）`).length
    const budget = limit - prefixLen
    if (budget <= 0) return [raw] // 预算装不下前缀：退化为整段（渠道自己截断）

    const parts = []
    let rest = chars
    while (rest.length > 0) {
      if (rest.length <= budget) {
        parts.push(rest.join(''))
        break
      }
      const [sentenceCutAt, isSentence] = lastSentenceCut(rest, budget)
      if (isSentence && sentenceCutAt > 0) {
        // 句末切点存在：切在这里（句子完整收尾）
        parts.push(rest.slice(0, sentenceCutAt).join(''))
        rest = rest.slice(sentenceCutAt)
        continue
      }
      // 范围内无完整句末：退化为空格/换行切点，仍无则硬切。
      let fallbackAt = -1
      for (let i = budget - 1; i > 0; i -= 1) {
        if (rest[i] === '\n') { fallbackAt = i + 1; break }
      }
      if (fallbackAt === -1) {
        for (let i = budget - 1; i > 0; i -= 1) {
          if (rest[i] === ' ') { fallbackAt = i + 1; break }
        }
      }
      const head = (fallbackAt > 0 ? fallbackAt : budget)
      parts.push(rest.slice(0, head).join(''))
      rest = rest.slice(head)
    }

    if (parts.length <= n) {
      if (noPrefix) return parts
      return parts.map((part, i) => (parts.length === 1 ? part : `（${i + 1}/${parts.length}）${part}`))
    }
    n = parts.length // 前缀挤占预算导致段数变多：用新段数重算前缀再切（收敛）
  }
  return [raw] // 8 轮仍不收敛（数学上不会发生）：宁可整段也不死循环
}

/**
 * 分段发送：预算内一次发送；超预算按 segmentText 切段顺序逐段发送。
 * @param {(piece: string) => Promise<void>} send 单条发送函数
 * @param {string} content 回复正文
 * @param {{ maxCodepoints?: number, noPrefix?: boolean }} [opts]
 * @returns {Promise<{ sent: number, total: number, error?: Error }>}
 */
export async function sendSegmented(send, content, opts = {}) {
  const segments = segmentText(content, opts)
  let sent = 0
  let lastError = null
  for (let i = 0; i < segments.length; i += 1) {
    try {
      await send(segments[i])
      sent += 1
    } catch (error) {
      lastError = error
      break
    }
  }
  return { sent, total: segments.length, error: lastError }
}
