// state 滑动窗口测试：pushRound 必须有界（此前只 push 不裁剪，state.json 无限增长）。
import { createStateManager } from '../src/state/index.mjs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let pass = 0, fail = 0
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`[PASS] ${name}`) }
  else { fail++; console.log(`[FAIL] ${name}`, extra ?? '') }
}

const dir = await mkdtemp(join(tmpdir(), 'tingxue-state-'))

// 1. 默认上限：recentRounds=10 → maxStored = max(10*3, 50) = 50
const s1 = await createStateManager({ dataDir: dir, recentRounds: 10 })
for (let i = 1; i <= 120; i++) await s1.pushRound(`u${i}`, `a${i}`)
check('默认上限 50：push 120 轮后长度为 50', s1.recentRounds.length === 50, s1.recentRounds.length)
check('保留的是最新一轮', s1.recentRounds.at(-1).user === 'u120', s1.recentRounds.at(-1))
check('丢的是最旧（u70 起）', s1.recentRounds[0].user === 'u71', s1.recentRounds[0])

const saved = JSON.parse(await readFile(join(dir, 'state.json'), 'utf-8'))
check('落盘也是 50 条', saved.recentRounds.length === 50, saved.recentRounds.length)

// 2. 显式 maxStoredRounds 覆盖
const dir2 = await mkdtemp(join(tmpdir(), 'tingxue-state2-'))
const s2 = await createStateManager({ dataDir: dir2, recentRounds: 10, maxStoredRounds: 5 })
for (let i = 1; i <= 20; i++) await s2.pushRound(`u${i}`, `a${i}`)
check('maxStoredRounds=5 生效', s2.recentRounds.length === 5, s2.recentRounds.length)

// 3. 旧 state.json 遗留的大数组在加载时被裁
const dir3 = await mkdtemp(join(tmpdir(), 'tingxue-state3-'))
const legacy = { mode: 'chat', recentRounds: Array.from({ length: 400 }, (_, i) => ({ user: `old${i}`, assistant: `old${i}` })) }
await writeFile(join(dir3, 'state.json'), JSON.stringify(legacy), 'utf-8')
const s3 = await createStateManager({ dataDir: dir3, recentRounds: 10 })
check('加载时裁掉遗留的 400 条 → 50', s3.recentRounds.length === 50, s3.recentRounds.length)
check('裁剪后保留最新', s3.recentRounds.at(-1).user === 'old399', s3.recentRounds.at(-1))

// 4. 注入窗口仍拿得到最近 recentRounds 轮（端到端：裁剪不会饿死注入）
const s4 = await createStateManager({ dataDir: await mkdtemp(join(tmpdir(), 'tingxue-state4-')), recentRounds: 10 })
for (let i = 1; i <= 60; i++) await s4.pushRound(`u${i}`, `a${i}`)
const injected = s4.recentRounds.slice(-10)
check('注入窗口仍有 10 轮', injected.length === 10, injected.length)
check('注入窗口最后一条是 u60', injected.at(-1).user === 'u60', injected.at(-1))

await rm(dir, { recursive: true, force: true })
await rm(dir2, { recursive: true, force: true })
await rm(dir3, { recursive: true, force: true })

console.log()
console.log(`通过 ${pass} 项，失败 ${fail} 项`)
if (fail) process.exitCode = 1
