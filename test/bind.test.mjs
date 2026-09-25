// 绑定模块单元测试（不依赖 lancedb）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  bindingKey, readNotifierState, writeNotifierState,
  getBinding, setBinding, setBindingDetailed, listBindings,
  getAgentRoute, setAgentRoute, deleteAgentRoute, ROUTE_AGENTS_KEY,
  getNotifierPrefs, setNotifierPrefs, NOTIFIER_PREFS_KEY, NOTIFIER_PREFS_DEFAULTS
} from '../src/bind/index.mjs'

test('bindingKey 组装 `bind:channel:userId`', () => {
  assert.equal(bindingKey('qq', 'ABC'), 'bind:qq:ABC')
})

test('readNotifierState 返回完整对象（含 bind 键）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tx-bind-'))
  const file = join(dir, 'state.json')
  await writeFile(file, JSON.stringify({ 'bind:qq:U': 'sess-1', 'other:x': 1 }))
  const state = await readNotifierState(file)
  assert.equal(state['bind:qq:U'], 'sess-1')
  assert.equal(state['other:x'], 1)
  await rm(dir, { recursive: true, force: true })
})

test('readNotifierState 缺省/损坏回退空对象', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tx-bind-'))
  const file = join(dir, 'state.json')
  let state = await readNotifierState(file) // 缺省
  assert.deepEqual(state, {})
  await writeFile(file, 'not-json{{')
  state = await readNotifierState(file) // 损坏
  assert.deepEqual(state, {})
  await rm(dir, { recursive: true, force: true })
})

test('setBinding 只改 bind 键，不抹其他键（键级合并）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tx-bind-'))
  const file = join(dir, 'state.json')
  await writeFile(file, JSON.stringify({ 'bind:qq:U': 'old', 'admin:token-hash': 'abc' }))
  const ok = await setBinding('qq', 'U', 'sess-new', file)
  assert.equal(ok, true)
  const state = await readNotifierState(file)
  assert.equal(state['bind:qq:U'], 'sess-new')
  assert.equal(state['admin:token-hash'], 'abc') // 保留
  await rm(dir, { recursive: true, force: true })
})

test('getBinding 读取绑定；无绑定返回 null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tx-bind-'))
  const file = join(dir, 'state.json')
  await writeFile(file, JSON.stringify({ 'bind:qq:U': 'sess-x' }))
  assert.equal(await getBinding('qq', 'U', file), 'sess-x')
  assert.equal(await getBinding('qq', 'NOPE', file), null)
  await rm(dir, { recursive: true, force: true })
})

test('listBindings 枚举所有 bind:*', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tx-bind-'))
  const file = join(dir, 'state.json')
  await writeFile(file, JSON.stringify({
    'bind:qq:U1': 'sess1',
    'bind:telegram:T1': 'sess2',
    'admin:token-hash': 'x',
  }))
  const list = await listBindings(file)
  assert.deepEqual(list, [
    { channel: 'qq', userId: 'U1', sessionId: 'sess1' },
    { channel: 'telegram', userId: 'T1', sessionId: 'sess2' },
  ])
  await rm(dir, { recursive: true, force: true })
})

test('setAgentRoute 写 route:agents 字段级合并，不抹其他键', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tx-bind-'))
  const file = join(dir, 'state.json')
  await writeFile(file, JSON.stringify({ 'bind:qq:U': 'sess', 'admin:token-hash': 'abc' }))
  // workspace 静默
  const ok = await setAgentRoute('dsh', { channels: [] }, file)
  assert.equal(ok, true)
  // 精确 agentId 放行
  const ok2 = await setAgentRoute('sess-agent-1', { channels: ['qq-bot'] }, file)
  assert.equal(ok2, true)
  const state = await readNotifierState(file)
  assert.deepEqual(state[ROUTE_AGENTS_KEY].dsh, { channels: [] })
  assert.deepEqual(state[ROUTE_AGENTS_KEY]['sess-agent-1'], { channels: ['qq-bot'] })
  assert.equal(state['bind:qq:U'], 'sess') // 保留
  assert.equal(state['admin:token-hash'], 'abc')
  await rm(dir, { recursive: true, force: true })
})

test('getAgentRoute 读取；无条目返回 null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tx-bind-'))
  const file = join(dir, 'state.json')
  await writeFile(file, JSON.stringify({ [ROUTE_AGENTS_KEY]: { dsh: { channels: [], quiet: true } } }))
  const entry = await getAgentRoute('dsh', file)
  assert.deepEqual(entry, { channels: [], quiet: true })
  assert.equal(await getAgentRoute('nope', file), null)
  await rm(dir, { recursive: true, force: true })
})

test('setAgentRoute quiet 与删字段语义；条目清空整键回收', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tx-bind-'))
  const file = join(dir, 'state.json')
  await writeFile(file, JSON.stringify({}))
  await setAgentRoute('k', { channels: ['qq-bot'], quiet: false }, file)
  assert.deepEqual(await getAgentRoute('k', file), { channels: ['qq-bot'], quiet: false })
  // 删 channels（回落上游），保留 quiet
  await setAgentRoute('k', { channels: null }, file)
  assert.deepEqual(await getAgentRoute('k', file), { quiet: false })
  // 清空条目 → 整键回收
  await setAgentRoute('k', { quiet: null }, file)
  assert.deepEqual(await getAgentRoute('k', file), null)
  await rm(dir, { recursive: true, force: true })
})

test('deleteAgentRoute 删除条目', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tx-bind-'))
  const file = join(dir, 'state.json')
  await writeFile(file, JSON.stringify({ [ROUTE_AGENTS_KEY]: { a: { channels: ['qq-bot'] }, b: { channels: ['tg'] } } }))
  assert.equal(await deleteAgentRoute('a', file), true)
  assert.equal(await deleteAgentRoute('a', file), false) // 不存在
  const state = await readNotifierState(file)
  assert.equal(state[ROUTE_AGENTS_KEY].a, undefined)
  assert.deepEqual(state[ROUTE_AGENTS_KEY].b, { channels: ['tg'] })
  await rm(dir, { recursive: true, force: true })
})

test('getNotifierPrefs 缺省回落默认值（状态提示开、审批只推放行会话）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tx-bind-'))
  const file = join(dir, 'state.json')
  await writeFile(file, JSON.stringify({ 'admin:token-hash': 'abc' }))
  assert.deepEqual(await getNotifierPrefs(file), { ...NOTIFIER_PREFS_DEFAULTS })
  // 损坏形状（数组/字符串）同样回落默认
  await writeFile(file, JSON.stringify({ [NOTIFIER_PREFS_KEY]: ['x'] }))
  assert.deepEqual(await getNotifierPrefs(file), { ...NOTIFIER_PREFS_DEFAULTS })
  await rm(dir, { recursive: true, force: true })
})

test('setNotifierPrefs 键级合并写入，不抹其他键；可分别关闭两个开关', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tx-bind-'))
  const file = join(dir, 'state.json')
  await writeFile(file, JSON.stringify({ 'bind:qq:U': 'sess', 'admin:token-hash': 'abc' }))
  assert.equal(await setNotifierPrefs({ statusNotice: false }, file), true)
  assert.deepEqual(await getNotifierPrefs(file), { statusNotice: false, approvalAllowlistOnly: true })
  assert.equal(await setNotifierPrefs({ approvalAllowlistOnly: false }, file), true)
  assert.deepEqual(await getNotifierPrefs(file), { statusNotice: false, approvalAllowlistOnly: false })
  const state = await readNotifierState(file)
  assert.equal(state['bind:qq:U'], 'sess') // 保留
  assert.equal(state['admin:token-hash'], 'abc')
  await rm(dir, { recursive: true, force: true })
})

// ── 真机 bug 回归：Windows 上 rename 撞上「文件被打开」会 EPERM ──
//
// 症状：/agentstart 偶发「切换 QQ 绑定失败」，而磁盘/权限都正常。
// 根因：state.json 同时被 DSH 宿主、dsh-notifier store、本插件读写；
//      Windows 的 rename 覆盖正被打开的文件会抛 EPERM，旧代码 catch{} 吞掉，
//      调用方只拿到 false，真因完全不可见。
// 修法：对可重试错误码做有界退避重试 + 失败时打日志/回传原因。

test('writeNotifierState 持续失败时必须抛错，不能静默成功', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tx-bind-'))
  // 把「目标路径」做成一个目录：rename 到目录上会稳定失败（EISDIR/EPERM 类），
  // 用来验证重试耗尽后**抛错**——旧实现是 try/catch 吞掉，调用方只看到 false。
  const badTarget = join(dir, 'as-dir')
  await mkdir(badTarget, { recursive: true })

  let threw = null
  try {
    await writeNotifierState({ a: 1 }, badTarget)
  } catch (e) {
    threw = e
  }
  assert.ok(threw !== null, '持续失败必须抛错，不能静默成功')
  assert.ok(threw.code, `错误应带 code，实际 ${threw.code}`)

  await rm(dir, { recursive: true, force: true })
})

test('setBindingDetailed 失败时回传真因（不再吞错）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tx-bind-'))
  // 把 state.json 做成目录 → 写入必然失败，用来验证错误被回传而非吞掉
  const badFile = join(dir, 'state.json')
  await mkdir(badFile, { recursive: true })

  const r = await setBindingDetailed('qq', 'U', 'sess-x', badFile)
  assert.equal(r.ok, false, '写盘失败必须 ok:false')
  assert.ok(r.error instanceof Error, '必须回传 Error 对象，而不是只给 false')
  assert.ok(r.error.message.length > 0, '错误信息不能为空')

  await rm(dir, { recursive: true, force: true })
})

test('setBinding 保持布尔契约（兼容既有调用方与测试）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tx-bind-'))
  const file = join(dir, 'state.json')
  await writeFile(file, JSON.stringify({ 'bind:qq:U': 'old' }))
  const ok = await setBinding('qq', 'U', 'new', file)
  assert.equal(ok, true, 'setBinding 必须返回 boolean，不能变成对象')
  assert.equal(typeof ok, 'boolean')
  await rm(dir, { recursive: true, force: true })
})
