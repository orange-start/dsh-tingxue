// dsh-tingxue test/notifier-suppress.test.mjs
//
// 回归：**命令消费不该被报成「任务被阻塞」**。
//
// 真机 bug（2026-09-25 16:51:09，turn 89）：
//   QQ 发 /agentstart → 命令层处理完，插件用 `{ kind: 'reject' }` 消费该 step
//   → DSH `agent.ts:268` 把 reject 记成 turn/end reason.kind = 'blocked'
//   → dsh-notifier 推「🚫 任务被阻塞，等待你处理」
//   → QQ 收到一条假的「阻塞」提示，碍事又没用，还掩盖了真正的失败原因。
//
// 判据：`blocked` 在 DSH 里**只有一个来源**（preStep 返回 reject）。
//   该 turn 内**没有任何 step/start** ⇒ 从没进过模型 ⇒ 是命令消费，不是真阻塞。
//   真阻塞（如权限询问待批准）必然已经跑过至少一个 step。
//
// 这个判据要双向都对：命令消费抑制，真阻塞不抑制。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// ── 优先对**真实打补丁后的 notifier 源码**做校验 ──
// 上面的纯函数副本只能证明「逻辑对」，不能证明「补丁真的装上了」。
// 补丁是 pnpm patch 固化的，容易在重装/升级时静默丢失——那时假阻塞会悄悄回来。
// 所以这里直接读 profile 里的 notifier 源码，确认三处关键改动在位。
const NOTIFIER_SRC = join(
  process.env.DSH_HOME ?? join(homedir(), '.dsh'),
  'profiles', 'web', 'node_modules', 'dsh-notifier', 'src', 'event-listener.mjs',
)

test('补丁在位：notifier 源码含「命令消费抑制」三处关键改动', (t) => {
  if (!existsSync(NOTIFIER_SRC)) {
    t.skip(`未找到 notifier 源码：${NOTIFIER_SRC}`)
    return
  }
  const src = readFileSync(NOTIFIER_SRC, 'utf8')

  assert.ok(
    src.includes('turnHadNoModelStep'),
    '缺少 turnHadNoModelStep 判据函数 —— 补丁可能被覆盖/丢失',
  )
  assert.ok(
    /const turn = typeof event\.data\?\.turn === 'number'/.test(src),
    'turn/end 的 intent 未携带 turn 号 —— 判据会静默失效',
  )
  assert.ok(
    /intent\.kind === 'blocked' && turnHadNoModelStep\(/.test(src),
    'push 侧未接上抑制分支 —— 假阻塞通知会照发',
  )
})

// ── 复刻补丁里的判据（与 dsh-notifier 补丁的 turnHadNoModelStep 同逻辑）──
// 保证「逻辑本身」有回归保护；若补丁改了判据，这里必须同步改，否则测试会红。
// **fail-open**：拿不到可信事件时返回 false（不抑制）——宁可多报，不能吞掉真阻塞。
function turnHadNoModelStep(session, turn) {
  if (typeof turn !== 'number') return false
  const events = session?.events
  if (!Array.isArray(events) || events.length === 0) return false
  let sawStepStart = false
  let sawTurnStart = false
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/start' && event.data?.turn === turn) { sawTurnStart = true; break }
    if (event?.type === 'step/start' && event.data?.turn === turn) { sawStepStart = true; break }
  }
  if (sawStepStart) return false
  return sawTurnStart
}

const shouldSuppress = (session, intent) =>
  intent.event === 'turn/end' && intent.kind === 'blocked' && turnHadNoModelStep(session, intent.turn)

const sess = (events) => ({ id: 's1', events })
const endBlocked = (turn) => ({ event: 'turn/end', kind: 'blocked', turn })
const endEv = (turn) => ({ type: 'turn/end', data: { turn, reason: { kind: 'blocked' } } })

test('命令消费：同轮 0 个 step/start → 抑制（真机 turn 89 的形态）', () => {
  const session = sess([
    { type: 'turn/start', data: { turn: 89 } },
    endEv(89),
  ])
  assert.equal(shouldSuppress(session, endBlocked(89)), true, '命令消费必须被抑制')
})

test('真阻塞：同轮有 step/start → 不抑制', () => {
  const session = sess([
    { type: 'turn/start', data: { turn: 90 } },
    { type: 'step/start', data: { turn: 90, step: 1 } },
    endEv(90),
  ])
  assert.equal(shouldSuppress(session, endBlocked(90)), false, '跑过模型的阻塞要照常报')
})

test('多 step 回合的阻塞：不抑制', () => {
  const session = sess([
    { type: 'turn/start', data: { turn: 91 } },
    { type: 'step/start', data: { turn: 91, step: 1 } },
    { type: 'step/start', data: { turn: 91, step: 2 } },
    endEv(91),
  ])
  assert.equal(shouldSuppress(session, endBlocked(91)), false)
})

test('只看当前 turn：上一轮的 step/start 不能算进本轮', () => {
  const session = sess([
    { type: 'turn/start', data: { turn: 88 } },
    { type: 'step/start', data: { turn: 88, step: 1 } },
    { type: 'turn/start', data: { turn: 89 } }, // 本轮无 step
    endEv(89),
  ])
  assert.equal(shouldSuppress(session, endBlocked(89)), true, '必须按 turn 号隔离，否则会漏抑制')
})

test('非 blocked 的其他 kind 一律不抑制', () => {
  const session = sess([{ type: 'turn/start', data: { turn: 92 } }, endEv(92)])
  for (const kind of ['completed', 'error', 'aborted', 'max-tokens', 'interrupted']) {
    assert.equal(
      shouldSuppress(session, { event: 'turn/end', kind, turn: 92 }),
      false,
      `${kind} 不该被抑制`,
    )
  }
})

test('非 turn/end 事件一律不抑制', () => {
  const session = sess([{ type: 'turn/start', data: { turn: 93 } }])
  for (const event of ['turn/start', 'longRunning', 'stall', 'approval/asked']) {
    assert.equal(shouldSuppress(session, { event, kind: 'blocked', turn: 93 }), false)
  }
})

test('无 events / 结构异常时不抑制（fail-open，宁可多报不可漏报）', () => {
  assert.equal(shouldSuppress({ id: 'x' }, endBlocked(1)), false)
  assert.equal(shouldSuppress(sess(null), endBlocked(1)), false)
  assert.equal(shouldSuppress(sess([]), endBlocked(1)), false)
})

test('intent 必须带 turn 号，且缺失时不得抑制（fail-open）', () => {
  // 补丁给 intentOfSessionEvent 的 turn/end 分支加了 turn 字段。
  // 缺 turn 就无法定位该轮，判据必须**放弃抑制**——否则会把真阻塞一起吞掉。
  const intent = endBlocked(89)
  assert.equal(typeof intent.turn, 'number', 'turn/end 的 intent 必须携带 turn')

  const broken = { event: 'turn/end', kind: 'blocked', turn: undefined }
  const session = sess([{ type: 'turn/start', data: { turn: 89 } }, endEv(89)])
  assert.equal(shouldSuppress(session, broken), false,
    'turn 缺失时必须不抑制（fail-open），绝不能因信息不足而吞掉真阻塞')
})

test('找不到该轮的 turn/start 时不抑制（事件被截断等情形）', () => {
  // 会话事件可能因保留策略被截断，导致看不到目标轮的 turn/start。
  // 此时信息不足，必须放行通知。
  const session = sess([
    { type: 'step/start', data: { turn: 99 } }, // 别的轮
  ])
  assert.equal(shouldSuppress(session, endBlocked(89)), false, '定位不到该轮 → 不抑制')
})
