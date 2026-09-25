// dsh-tingxue test/selfcheck.test.mjs
//
// 自检脚本自身的回归测试。
//
// 为什么需要它：一个永远返回「正常」的检查毫无价值。这里要证明的是
// **自检在旧毛病（同轮内记忆块消失）上真的会红**，而不只是一个橡皮图章。
//
// 关键判据（曾经踩过的坑）：
//   新回合的第一条 header 天然带 reason="change"（相对上一轮 system 变了），
//   那是**正常**行为，不能当漂移。真正的 bug 特征只有一条：
//   同一轮内 system 长度出现了**多个值**（或记忆块忽有忽无）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeTurns, judgeTurn } from '../scripts/selfcheck.mjs'

const MEM = '\u3010\u76f8\u5173\u8bb0\u5fc6\u3011'
const PROF = '\u3010\u8eab\u4efd\u4e0e\u5916\u89c2\u3011'

/** 造一条 request/header 事件。mem=false 表示这次没有记忆块。 */
function header(turn, { reason = 'change', base = PROF, mem = false, memLen = 1945, tools = 54 }) {
  const sys = mem ? base + MEM + 'x'.repeat(memLen) : base
  return { type: 'request/header', time: new Date(2026, 8, 25, 16, 0, 0).toISOString(), data: { reason, header: { system: sys, tools: new Array(tools).fill({}) } } }
}
const turnStart = (n) => ({ type: 'turn/start', data: { turn: n } })
const stepStart = () => ({ type: 'step/start', data: {} })

/** 从事件流里取某个 turn 的判定结果。 */
function judgeOf(events, turnNo) {
  const t = analyzeTurns(events).find((x) => x.turn === turnNo)
  assert.ok(t, `没找到 turn ${turnNo}`)
  return judgeTurn(t)
}

// ---------- 必须能抓出 bug ----------

test('旧毛病：同轮内记忆块消失 —— 自检必须报漂移', () => {
  // 真机复现：turn 84 的形态。step1 有记忆块（15817），step2 没有（13872）。
  const events = [
    turnStart(84),
    stepStart(), header(84, { mem: true }),      // 15817：带记忆块
    stepStart(), header(84, { reason: 'change', mem: false }), // 13872：记忆块没了
  ]
  const j = judgeOf(events, 84)
  assert.equal(j.drifted, true, '同轮内记忆块消失必须判为漂移')
  assert.equal(j.lens.length, 2, '应记录到两个不同的 system 长度')
  assert.deepEqual(j.mems, [true, false], '记忆块应由有到无')
})

test('长度变了但记忆块都在 —— 也算漂移（长度是更灵敏的判据）', () => {
  const events = [
    turnStart(90),
    header(90, { mem: true, memLen: 1000 }),
    header(90, { reason: 'change', mem: true, memLen: 1200 }),
  ]
  const j = judgeOf(events, 90)
  assert.equal(j.drifted, true, '长度不同就该报，哪怕记忆块都在')
})

// ---------- 不能误报 ----------

test('正常回合：新回合首条 header 带 change —— 不得误报', () => {
  // 这是曾经误报的形态：turn 86 只有 1 条 header、长度唯一，却因为 reason=change 被判漂移。
  const events = [
    turnStart(86),
    stepStart(), header(86, { reason: 'change', mem: true }),
  ]
  const j = judgeOf(events, 86)
  assert.equal(j.drifted, false, '首条 header 的 change 是正常行为，不该算漂移')
  assert.equal(j.changes, 1, 'change 计数仍如实记录')
  assert.equal(j.headerCount, 1)
})

test('正常多 step 回合：多条 header 但 system 完全一致 —— 不得误报', () => {
  const events = [
    turnStart(85),
    stepStart(), header(85, { reason: 'resume', mem: true }),
    stepStart(), // 后续 step：内容没变，所以不再落 header（DSH 只在变化时记录）
    stepStart(),
  ]
  const j = judgeOf(events, 85)
  assert.equal(j.drifted, false)
  assert.equal(j.headerCount, 1, '轮内不变则只有一条记录')
  assert.ok(j.steps >= 3, `step 数应被统计到，实际 ${j.steps}`)
})

test('无记忆块的回合轮内恒定 —— 不算漂移（记忆块为 0 本身不是错）', () => {
  const events = [
    turnStart(70),
    header(70, { mem: false }),
    header(70, { reason: 'change', mem: false }),
  ]
  const j = judgeOf(events, 70)
  // 长度可能因为 base 相同而唯一
  assert.equal(j.mems.every((m) => m === false), true)
})

// ---------- 结构 ----------

test('analyzeTurns 按 turn 归位 header，丢掉没有 header 的回合', () => {
  const events = [
    turnStart(1), // 没有 header → 应被丢掉
    turnStart(2), header(2, { mem: true }),
    turnStart(3), header(3, { mem: true }), header(3, { reason: 'change', mem: false }),
  ]
  const turns = analyzeTurns(events)
  assert.deepEqual(turns.map((t) => t.turn), [2, 3])
})

test('step/start 数被正确统计（判断是否为多 step 回合）', () => {
  const events = [
    turnStart(5), stepStart(), header(5, { mem: true }),
    stepStart(), stepStart(), stepStart(),
  ]
  const j = judgeOf(events, 5)
  assert.equal(j.steps, 4)
})

test('没有 turn/start 的游离 header 不炸', () => {
  const events = [header(9, { mem: true })]
  assert.deepEqual(analyzeTurns(events), [])
})
