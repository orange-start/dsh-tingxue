// dsh-tingxue src/bind/index.mjs
// dsh-notifier 绑定读写工具。
// dsh-notifier 的会话绑定存在 $DSH_HOME/dsh-notifier/state.json，键为 `bind:<channel>:<userId>` → sessionId。
// 插件通过直接读写该键实现「全自动 bind」：/agentstart 自动绑到新隔离会话，/agentstop 自动绑回聊天会话。
//
// 安全说明：
//  - dsh-notifier 的 store 采用「写时重读 + 键级合并 + 跨进程写锁」。
//    插件遵循同样的「读最新 → 只改 bind 键 → 原子写回（tmp+rename）」策略，
//    与 dsh-notifier 运行中内存态兼容（其 get 有 500ms 读收敛，写盘后可见）。
//  - bind 键只在 /agentstart /agentstop 时写，频率极低，竞态窗口可忽略。

import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** 默认 dsh-notifier state 目录（与 dsh-notifier 的 defaultStateDir 一致）。 */
export function notifierStateDir() {
  const home = process.env.DSH_HOME
    ?? (process.env.HOME || process.env.USERPROFILE ? `${process.env.HOME || process.env.USERPROFILE}/.dsh` : null)
  return home !== null ? join(home, 'dsh-notifier') : '.dsh-notifier'
}

/** 绑定键：`bind:<channel>:<userId>`。 */
export function bindingKey(channel, userId) {
  return `bind:${channel}:${userId}`
}

/** agent 隔离会话 id 前缀（/agentstart 生成的 sessionId 以 `tingxue-agent-` 开头）。 */
export const AGENT_SESSION_PREFIX = 'tingxue-agent-'

/** 判断一个会话 id 是否为 agent 隔离会话（聊天会话永不以此为前缀）。 */
export function isAgentSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId.startsWith(AGENT_SESSION_PREFIX)
}

/**
 * 读取当前绑定到某 channel:userId 的会话 id。
 * @returns {Promise<string|null>}
 */
export async function getBinding(channel, userId, stateFile) {
  const state = await readNotifierState(stateFile)
  const value = state[bindingKey(channel, userId)]
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * 读取 dsh-notifier state.json 的完整内容（损坏/缺省回退空对象）。
 * @param {string} [stateFile] - 显式 state.json 路径；缺省用默认目录。
 */
export async function readNotifierState(stateFile) {
  const file = stateFile ?? join(notifierStateDir(), 'state.json')
  try {
    const raw = await readFile(file, 'utf-8')
    const parsed = JSON.parse(raw)
    return (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {}
  } catch {
    return {}
  }
}

/** 可重试的错误码：EPERM/EBUSY/EACCES 是「文件被占用」类；ENOENT/EEXIST 是 tmp 被并发清理/重名。 */
const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOENT', 'EEXIST'])

/**
 * 写盘重试预算（真机实测标定，2026-09-25）。
 *
 * **为什么把预算从约 248ms 放大到约 1.8s**：
 * 实测目标文件 `state.json` = 56,048 bytes / 120 键。无争用时写入 5/5 成功、
 * 4–9ms（平均 6ms）——所以写入本身没问题。但只要 DSH 宿主或 dsh-notifier store
 * 持着读句柄（这是运行期常态），Windows 的 `rename` 覆盖就抛 EPERM：
 *   实测 hold 一个读句柄 → rename 立即 EPERM，旧 6 次退避（8/16/32/64/128ms）
 *   全部耗尽，耗时 330ms，写入失败。
 * 旧预算 248ms 恰好短于一次真实争用窗口，于是 `/agentstart` 偶发
 * 「切换 QQ 绑定失败」。放大预算 + 提高尝试次数，使总预算覆盖到秒级窗口。
 *
 * 退避序列（base=30ms, cap=300ms, 12 次）：30/60/120/240/300×8 ≈ 2.9s 上限。
 * 仍是**有界**的：最多 12 次、封顶约 2.9s，不会无限挂住 /agentstart。
 */
export const WRITE_RETRY_DEFAULTS = Object.freeze({
  attempts: 12,
  baseDelayMs: 30,
  maxDelayMs: 300,
})

/**
 * 原子写回 dsh-notifier state.json（tmp + rename，避免半截文件）。
 *
 * **为什么要重试**（真机实测）：Windows 上 `rename` 覆盖一个正被其他进程打开的
 * 文件会抛 `EPERM: operation not permitted`。而 `state.json` 同时被 DSH 宿主、
 * dsh-notifier 自己的 store 和本插件读写，撞上这个窗口就是随机失败——症状是
 * `/agentstart` 偶发「切换 QQ 绑定失败」，而磁盘/权限其实都正常。
 * 实测复现：持一个句柄后 rename 立即 EPERM。
 *
 * 因此对**可重试**的错误码做有界退避重试；非可重试错误（如 ENOSPC）立即抛出。
 *
 * @param {object} state - 完整 state 对象。
 * @param {string} [stateFile]
 * @param {{attempts?: number, baseDelayMs?: number, maxDelayMs?: number}} [options]
 *   重试预算可覆盖（测试与诊断用；缺省用 WRITE_RETRY_DEFAULTS）。
 * @returns {Promise<{attempts: number, elapsedMs: number}>} 实际尝试次数与耗时。
 */
export async function writeNotifierState(state, stateFile, options = {}) {
  const file = stateFile ?? join(notifierStateDir(), 'state.json')
  await mkdir(dirname(file), { recursive: true })
  const attempts = Number.isInteger(options.attempts) && options.attempts > 0
    ? options.attempts
    : WRITE_RETRY_DEFAULTS.attempts
  const baseDelayMs = Number.isFinite(options.baseDelayMs) && options.baseDelayMs > 0
    ? options.baseDelayMs
    : WRITE_RETRY_DEFAULTS.baseDelayMs
  const maxDelayMs = Number.isFinite(options.maxDelayMs) && options.maxDelayMs > 0
    ? options.maxDelayMs
    : WRITE_RETRY_DEFAULTS.maxDelayMs

  const startedAt = Date.now()
  let lastError
  for (let attempt = 0; attempt < attempts; attempt++) {
    const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, file)
      return { attempts: attempt + 1, elapsedMs: Date.now() - startedAt }
    } catch (e) {
      lastError = e
      // 每次重试都用新 tmp 名：避免上一轮的残骸或他人同名文件干扰
      try { await rm(tmp, { force: true }) } catch { /* 清理失败不致命 */ }
      if (!RETRYABLE_CODES.has(e?.code)) throw e
      if (attempt < attempts - 1) {
        await sleep(Math.min(baseDelayMs * 2 ** attempt, maxDelayMs))
      }
    }
  }
  // 把「试了几次、花了多久」挂到错误上：调用方据此给出可定位诊断。
  try {
    lastError.attempts = attempts
    lastError.elapsedMs = Date.now() - startedAt
  } catch { /* 冻结的错误对象不致命 */ }
  throw lastError
}

/**
 * 把写盘失败翻译成用户/日志能据以行动的诊断。
 * 失败路径不允许只说「切换 QQ 绑定失败」——那让真因完全不可见。
 *
 * @param {Error & {code?: string, attempts?: number, elapsedMs?: number}} err
 * @returns {{code: string, attempts: number, elapsedMs: number, diagnosis: string, suggestion: string}}
 */
export function describeWriteFailure(err, stateFile) {
  const code = err?.code ?? 'UNKNOWN'
  const attempts = Number.isInteger(err?.attempts) ? err.attempts : 0
  const elapsedMs = Number.isFinite(err?.elapsedMs) ? err.elapsedMs : 0
  const target = stateFile ?? join(notifierStateDir(), 'state.json')

  let diagnosis
  let suggestion
  if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
    diagnosis = `目标文件被其他进程占用（Windows 上 rename 覆盖被打开的文件会报 ${code}）`
    suggestion =
      `已重试 ${attempts} 次 / ${elapsedMs}ms 仍未成功。` +
      'DSH 宿主与 dsh-notifier 会持续读写同一个 state.json，争用窗口偶发较长；' +
      '稍后重试 /agentstart 通常即可。若持续失败，请确认该文件未被编辑器/杀毒软件独占。'
  } else if (code === 'ENOSPC') {
    diagnosis = '磁盘空间不足，无法写入绑定文件'
    suggestion = `请清理磁盘后重试。目标：${target}`
  } else if (code === 'ENOENT') {
    diagnosis = '目标目录不存在或瞬时文件被并发清理'
    suggestion = `已重试 ${attempts} 次仍未成功。请确认目录存在且可写：${target}`
  } else if (code === 'EISDIR' || code === 'ENOTDIR') {
    diagnosis = `目标路径不是可写的普通文件（${code}）`
    suggestion = `请检查该路径是否被目录/链接占用：${target}`
  } else {
    diagnosis = `写盘失败（${code}）`
    suggestion = `已重试 ${attempts} 次 / ${elapsedMs}ms。请检查权限与磁盘：${target}`
  }
  return { code, attempts, elapsedMs, diagnosis, suggestion }
}

/** 毫秒睡眠。 */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** route:agents 键：`{"<workspace|agentId>": { channels?: string[], quiet?: boolean }}`。 */
export const ROUTE_AGENTS_KEY = 'route:agents'

/**
 * 读取某个 route:agents 条目（workspace 名或精确 agentId）。
 * @param {string} key - workspace 名或精确 agentId。
 * @returns {Promise<{channels?: string[], quiet?: boolean}|null>} 无条目返回 null。
 */
export async function getAgentRoute(key, stateFile) {
  const state = await readNotifierState(stateFile)
  const table = state[ROUTE_AGENTS_KEY]
  if (table === null || typeof table !== 'object' || Array.isArray(table)) return null
  const entry = table[key]
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
  const copy = {}
  if (Array.isArray(entry.channels)) copy.channels = [...entry.channels]
  if (typeof entry.quiet === 'boolean') copy.quiet = entry.quiet
  return copy
}

/**
 * 写（合并）一个 route:agents 条目。字段级合并：只有显式提供的字段会覆盖/新增；
 * 显式 `channels === null` 删除该字段（回落上游）；条目清空则整键回收。
 * @param {string} key - workspace 名或精确 agentId。
 * @param {{ channels?: string[]|null, quiet?: boolean|null }} [patch]
 * @returns {Promise<boolean>} 是否写盘成功。
 */
export async function setAgentRoute(key, patch = {}, stateFile) {
  const state = await readNotifierState(stateFile)
  if (state[ROUTE_AGENTS_KEY] === null || typeof state[ROUTE_AGENTS_KEY] !== 'object' || Array.isArray(state[ROUTE_AGENTS_KEY])) {
    state[ROUTE_AGENTS_KEY] = {}
  }
  const table = state[ROUTE_AGENTS_KEY]
  const entry = { ...(table[key] ?? {}) }
  if (patch !== null && typeof patch === 'object' && !Array.isArray(patch)) {
    if (patch.channels !== undefined) {
      if (patch.channels === null) delete entry.channels
      else entry.channels = Array.isArray(patch.channels)
        ? [...new Set(patch.channels.filter((c) => typeof c === 'string' && c.trim() !== '').map((c) => c.trim()))]
        : []
    }
    if (patch.quiet !== undefined) {
      if (patch.quiet === null) delete entry.quiet
      else entry.quiet = Boolean(patch.quiet)
    }
  }
  if (Object.keys(entry).length === 0) delete table[key]
  else table[key] = entry
  try {
    await writeNotifierState(state, stateFile)
    return true
  } catch {
    return false
  }
}

/**
 * 删除一个 route:agents 条目（返回键存在并删除 / 键不存在）。
 * @returns {Promise<boolean>}
 */
export async function deleteAgentRoute(key, stateFile) {
  const state = await readNotifierState(stateFile)
  const table = state[ROUTE_AGENTS_KEY]
  if (table === null || typeof table !== 'object' || Array.isArray(table)) return false
  if (!Object.prototype.hasOwnProperty.call(table, key)) return false
  delete table[key]
  try {
    await writeNotifierState(state, stateFile)
    return true
  } catch {
    return false
  }
}

/**
 * 通知偏好键：`prefs:tingxue`。
 *
 * 用途：听雪设置侧边栏里的开关，需要作用于 dsh-notifier 的推送行为
 * （dsh-notifier 补丁从同一个 state store 读取）。键级合并写，不碰别的键。
 * 字段：
 *  - statusNotice: 是否把「任务开始/完成/中止」「心跳」「疑似卡住」等状态提示发到 QQ
 *  - approvalAllowlistOnly: 审批只推给被显式放行出站的会话（如听雪聊天/agent 会话）
 */
export const NOTIFIER_PREFS_KEY = 'prefs:tingxue'

/** prefs 的默认值（键缺失时的语义，与 dsh-notifier 补丁的默认保持一致）。 */
export const NOTIFIER_PREFS_DEFAULTS = Object.freeze({
  statusNotice: true,
  approvalAllowlistOnly: true,
})

/**
 * 读取通知偏好（键缺失回落默认值；损坏值按默认处理）。
 * @returns {Promise<{statusNotice: boolean, approvalAllowlistOnly: boolean}>}
 */
export async function getNotifierPrefs(stateFile) {
  const state = await readNotifierState(stateFile)
  const raw = state[NOTIFIER_PREFS_KEY]
  const entry = (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
  const pick = (key) => (typeof entry[key] === 'boolean' ? entry[key] : NOTIFIER_PREFS_DEFAULTS[key])
  return { statusNotice: pick('statusNotice'), approvalAllowlistOnly: pick('approvalAllowlistOnly') }
}

/**
 * 写（合并）通知偏好（键级合并，不碰其他键）。
 * @param {{ statusNotice?: boolean, approvalAllowlistOnly?: boolean }} patch
 * @returns {Promise<boolean>} 是否写盘成功。
 */
export async function setNotifierPrefs(patch = {}, stateFile) {
  const state = await readNotifierState(stateFile)
  const raw = state[NOTIFIER_PREFS_KEY]
  const entry = (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) ? { ...raw } : {}
  for (const key of ['statusNotice', 'approvalAllowlistOnly']) {
    if (patch?.[key] === undefined || patch?.[key] === null) continue
    entry[key] = Boolean(patch[key])
  }
  state[NOTIFIER_PREFS_KEY] = entry
  try {
    await writeNotifierState(state, stateFile)
    return true
  } catch {
    return false
  }
}

/**
 * 设置绑定：把 channel:userId 绑到 sessionId。
 * 读最新 state → 只改 bind 键 → 原子写回（键级合并，不抹掉其他键）。
 * sessionId 传空串/undefined 时删除该绑定键（等同"清空绑定"）。
 *
 * @returns {Promise<boolean>} 是否写盘成功（保持布尔契约，兼容既有调用方与测试）。
 *   失败原因会**打日志**——原实现 `catch {}` 吞掉一切，用户只看到
 *   「切换 QQ 绑定失败」这种笼统文案，真因（权限/磁盘/路径/并发写）完全不可见。
 *   需要真因的调用方用 `setBindingDetailed`。
 */
export async function setBinding(channel, userId, sessionId, stateFile) {
  const r = await setBindingDetailed(channel, userId, sessionId, stateFile)
  return r.ok
}

/**
 * 同 setBinding，但返回失败原因与**可定位诊断**（供命令层给出可行动的回复文案）。
 *
 * 为什么要有 diagnosis/suggestion：旧实现失败只给一句「切换 QQ 绑定失败」，
 * 用户和日志都拿不到 code / 尝试次数 / 耗时，真因（占用、权限、磁盘）完全不可见，
 * 排查只能靠猜。现在失败路径必须自证。
 *
 * @returns {Promise<{ok: boolean, error?: Error, code?: string, attempts?: number,
 *   elapsedMs?: number, diagnosis?: string, suggestion?: string}>}
 */
export async function setBindingDetailed(channel, userId, sessionId, stateFile) {
  const key = bindingKey(channel, userId)
  let state = {}
  try {
    // 文件不存在是正常的首次写入：读失败一律回退空对象，不中断写入。
    state = await readNotifierState(stateFile)
  } catch {
    state = {}
  }
  if (sessionId == null || sessionId === '') delete state[key]
  else state[key] = sessionId
  try {
    const res = await writeNotifierState(state, stateFile)
    return { ok: true, attempts: res.attempts, elapsedMs: res.elapsedMs }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    const diag = describeWriteFailure(err, stateFile)
    try {
      console.error(
        '[dsh-tingxue/bind]',
        `写 bind 失败 key=${key} code=${diag.code} attempts=${diag.attempts} elapsed=${diag.elapsedMs}ms` +
        ` 诊断=${diag.diagnosis} 建议=${diag.suggestion} 原始错误=${err.message}`,
      )
    } catch { /* 控制台不可用不致命 */ }
    return {
      ok: false,
      error: err,
      code: diag.code,
      attempts: diag.attempts,
      elapsedMs: diag.elapsedMs,
      diagnosis: diag.diagnosis,
      suggestion: diag.suggestion,
    }
  }
}

/**
 * 列出所有 `bind:*` 绑定键（channel:userId → sessionId）。
 * @returns {Promise<Array<{channel: string, userId: string, sessionId: string}>>}
 */
export async function listBindings(stateFile) {
  const state = await readNotifierState(stateFile)
  const result = []
  for (const [key, value] of Object.entries(state)) {
    if (!key.startsWith('bind:')) continue
    const rest = key.slice('bind:'.length)
    const sep = rest.indexOf(':')
    if (sep < 0) continue
    const channel = rest.slice(0, sep)
    const userId = rest.slice(sep + 1)
    if (typeof value === 'string' && value !== '') {
      result.push({ channel, userId, sessionId: value })
    }
  }
  return result
}
