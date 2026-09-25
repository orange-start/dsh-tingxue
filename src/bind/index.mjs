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

/**
 * 原子写回 dsh-notifier state.json（tmp + rename，避免半截文件）。
 *
 * **为什么要重试**（真机实测）：Windows 上 `rename` 覆盖一个正被其他进程打开的
 * 文件会抛 `EPERM: operation not permitted`。而 `state.json` 同时被 DSH 宿主、
 * dsh-notifier 自己的 store 和本插件读写，撞上这个窗口就是随机失败——症状是
 * `/agentstart` 偶发「切换 QQ 绑定失败」，而磁盘/权限其实都正常。
 * 实测复现：持一个句柄后 rename 立即 EPERM。
 *
 * 因此对**可重试**的错误码做有界退避重试（EPERM/EBUSY/EACCES/ENOENT：最后一个
 * 是 tmp 被并发清理）；非可重试错误（如 ENOSPC）立即抛出，不浪费时间。
 *
 * @param {object} state - 完整 state 对象。
 * @param {string} [stateFile]
 */
export async function writeNotifierState(state, stateFile) {
  const file = stateFile ?? join(notifierStateDir(), 'state.json')
  await mkdir(dirname(file), { recursive: true })
  const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOENT', 'EEXIST'])
  const ATTEMPTS = 6
  let lastError
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, file)
      return
    } catch (e) {
      lastError = e
      // 每次重试都用新 tmp 名：避免上一轮的残骸或他人同名文件干扰
      try { await rm(tmp, { force: true }) } catch { /* 清理失败不致命 */ }
      if (!RETRYABLE.has(e?.code)) throw e
      if (attempt < ATTEMPTS - 1) {
        // 有界退避：8/16/32/64/128ms，总等待约 248ms（与 notifier 自身两轮
        // 自旋 ~480ms 同量级，足够躲过宿主一次读窗口）
        await sleep(8 * 2 ** attempt)
      }
    }
  }
  throw lastError
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
 * 同 setBinding，但返回失败原因（供命令层给出可诊断的回复文案）。
 * @returns {Promise<{ok: boolean, error?: Error}>}
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
    await writeNotifierState(state, stateFile)
    return { ok: true }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    try {
      console.error('[dsh-tingxue/bind]', `写 bind 失败 key=${key}: ${err.message}`)
    } catch { /* 控制台不可用不致命 */ }
    return { ok: false, error: err }
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
