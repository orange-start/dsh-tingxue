// dsh-tingxue test/agent-mode-e2e.test.mjs
//
// 真机路径全流程（不改真实绑定：全程用临时 state / data 目录）
//
// 驱动的是**真实的** createCommandHandler + createStateManager + setBindingDetailed，
// 只把 ctx.agents / ctx.notifier 换成替身（它们要的是 DSH 运行时，测试环境没有）。
// 这样 /agentstart → /agentstop 的完整状态机、绑定写入、route 清理、记忆归档全部真实执行。

import { createStateManager } from '../src/state/index.mjs'
import { createCommandHandler } from '../src/commands/index.mjs'
import { readNotifierState, writeNotifierState, setBindingDetailed, getBinding } from '../src/bind/index.mjs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { test } from 'node:test'
import assert from 'node:assert/strict'

test('真机路径：/agentstart → /agentstop 全流程（34 项）', async () => {
  const KEY = 'bind:qq:USER'
  const results = []
  const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail })
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`)
  }

  const dir = await mkdtemp(join(tmpdir(), 'tx-e2e-'))
  const dataDir = join(dir, 'data')
  const stateFile = join(dir, 'notifier-state.json')
  await (await import('node:fs/promises')).mkdir(dataDir, { recursive: true })

  // 模拟 dsh-notifier 里已有一个 QQ 绑定 + 别的键（验证键级合并不被抹）
  await (await import('node:fs/promises')).writeFile(stateFile, JSON.stringify({
    [KEY]: 'session-chat-aaa',
    'admin:token-hash': 'keep-me',
    'route:agents': { 'dsh': { quiet: true } },
  }), 'utf8')

  const state = await createStateManager({ dataDir })
  // 真实场景里插件启动时会从 dsh-notifier 当前绑定读出 chatSessionId 并持久化。
  // 不补这一步，/agentstop 就没有回绑目标（真机里由 init() 完成）。
  await state.setChatSessionId('session-chat-aaa')

  // 替身：agents / notifier
  const created = []
  const disposed = []
  let pushed = []
  const agents = {
    async create(opts = {}) {
      const id = `tingxue-agent-test${created.length}-xyz`
      created.push({ id, opts })
      return { id, session: { id }, dispose: async () => { disposed.push(id) } }
    },
  }
  const notifier = {
    // 命令层回执走 notifier.push({ title, content }, { sourceName })
    async push(msg) { pushed.push(msg) },
  }

  const commands = createCommandHandler({
    state, notifier, agents,
    config: {
      agentStartKeyword: '/agentstart',
      agentStopKeyword: '/agentstop',
      profilePath: join(process.cwd(), '听雪档案.txt'),
      dataDir, notifierStateFile: stateFile, channel: 'qq', userId: 'USER',
    },
    logger: { warn: () => {}, info: () => {} },
  })

  console.log('=== 1) isCommand 判定 ===')
  check('/agentstart 是命令', commands.isCommand('/agentstart'))
  check('/agentstop 是命令', commands.isCommand('/agentstop'))
  check('/agentstartx 不是命令', !commands.isCommand('/agentstartx'))
  check('普通文本不是命令', !commands.isCommand('你好'))
  check('带前后空白也算', commands.isCommand('  /agentstart  '))

  console.log('')
  console.log('=== 2) /agentstart 全流程（真实写绑定）===')
  const before = state
  const started = await commands.handle('/agentstart')
  const st1 = state
  const nState1 = await readNotifierState(stateFile)

  check('/agentstart 被消费（返回 true）', started === true)
  check('创建了隔离会话', created.length === 1, created[0]?.id ?? '')
  check('state.mode 变为 agent', st1.mode === 'agent', `mode=${st1.mode}`)
  check('state.agentSessionId 已记录', !!st1.agentSessionId, st1.agentSessionId ?? '')
  check('绑定切到了 agent 会话', nState1[KEY] === st1.agentSessionId, `${nState1[KEY]} vs ${st1.agentSessionId}`)
  check('绑定不是聊天会话了', nState1[KEY] !== 'session-chat-aaa')
  check('键级合并：admin:token-hash 保留', nState1['admin:token-hash'] === 'keep-me')
  check('键级合并：route:agents 的 dsh 条目保留', nState1['route:agents']?.dsh?.quiet === true)
  check('给 agent 会话建了 route', !!nState1['route:agents']?.[st1.agentSessionId], JSON.stringify(nState1['route:agents']?.[st1.agentSessionId]))
  check('推送了切换成功提示', pushed.some(m => /agent|模式/.test(String(m?.content ?? ''))), `${pushed.length} 条: ${String(pushed[0]?.content ?? '').slice(0, 40).replace(/\n/g, ' ')}`)

  console.log('')
  console.log('=== 3) 重复 /agentstart 应幂等（已在该模式）===')
  const pushedBefore = pushed.length
  const again = await commands.handle('/agentstart')
  check('重复执行不报错', again === true)
  check('没有重复创建会话', created.length === 1, `created=${created.length}`)

  console.log('')
  console.log('=== 4) /agentstop 全流程（真实回绑）===')
  const stopped = await commands.handle('/agentstop')
  const st2 = state
  const nState2 = await readNotifierState(stateFile)

  check('/agentstop 被消费', stopped === true)
  check('state.mode 回到 chat', st2.mode === 'chat', `mode=${st2.mode}`)
  check('agentSessionId 已清空', !st2.agentSessionId, String(st2.agentSessionId))
  check('隔离会话被 dispose', disposed.length === 1, disposed.join(','))
  check('绑定回到聊天会话', nState2[KEY] === st2.chatSessionId, `${nState2[KEY]} vs ${st2.chatSessionId}`)
  check('回绑目标不是 agent 前缀', !String(nState2[KEY]).startsWith('tingxue-agent-'))
  check('键级合并仍保留 admin 键', nState2['admin:token-hash'] === 'keep-me')
  check('agent 的 route 被清理', !nState2['route:agents']?.[st1.agentSessionId], JSON.stringify(nState2['route:agents'] ?? {}))
  check('route:agents 的 dsh 条目仍在', nState2['route:agents']?.dsh?.quiet === true)

  console.log('')
  console.log('=== 5) 未进入 agent 模式时 /agentstop 不应乱动 ===')
  const st3before = state
  await commands.handle('/agentstop')
  const st3 = state
  check('仍为 chat 模式', st3.mode === 'chat')
  check('绑定没被改成别的', (await readNotifierState(stateFile))[KEY] === st3before.chatSessionId)

  console.log('')
  console.log('=== 6) 绑定写入失败时不得进入 agent 模式（本次修复的核心保护）===')
  // 把 state 文件变成目录 → 写入必然失败（rename 到目录上稳定报错）
  const badStateFile = join(dir, 'bad-state.json')
  await (await import('node:fs/promises')).mkdir(badStateFile, { recursive: true })
  const state2 = await createStateManager({ dataDir: join(dir, 'data2') })
  const cmds2 = createCommandHandler({
    state: state2, notifier, agents,
    config: {
      agentStartKeyword: '/agentstart', agentStopKeyword: '/agentstop',
      profilePath: join(process.cwd(), '听雪档案.txt'),
      dataDir: join(dir, 'data2'), notifierStateFile: badStateFile, channel: 'qq', userId: 'USER',
    },
    logger: { warn: () => {}, info: () => {} },
  })
  const disposedBefore = disposed.length
  const createdBefore = created.length
  const badRes = await cmds2.handle('/agentstart')
  // dispose 走 setImmediate 延迟（避免在 pre-step 内销毁正在跑的 agent），
  // 要给它一个 tick 才反映到 disposed 数组。
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  const st4 = state2

  check('写绑定失败时仍被消费（有回执）', badRes === true)
  // 顺序已改为「先写绑定，再建会话」（t3 修复）：绑定失败时**根本没建会话**，
  // 因此不需要 dispose，也不可能在磁盘上留下 295 字节的空壳会话。
  // 这比旧断言（回滚已建会话）更强：从源头就不产生垃圾。
  check('失败时未创建隔离会话（不留空壳）', created.length === createdBefore,
    `created ${createdBefore} → ${created.length}`)
  check('失败时不需 dispose（因为压根没建）', disposed.length === disposedBefore,
    `disposed ${disposedBefore} → ${disposed.length}`)
  check('失败时 mode 不得停在 agent（防静默失忆）', st4.mode === 'chat', `mode=${st4.mode}`)
  check('失败时 agentSessionId 不得残留', !st4.agentSessionId, String(st4.agentSessionId))

  console.log('')
  console.log('=== 7) 失败回执必须带真因（本次修复的核心）===')
  const failMsgs = pushed.filter(m => /失败/.test(String(m?.content ?? '')))
  const lastFail = failMsgs[failMsgs.length - 1]
  check('推送了失败回执', !!lastFail, `${failMsgs.length} 条`)
  check(
    '回执带真因（EPERM/具体错误），不是光一句「切换QQ绑定失败」',
    /EPERM|operation not permitted|原因/.test(String(lastFail?.content ?? '')),
    String(lastFail?.content ?? '').slice(0, 100).replace(/\n/g, ' '),
  )

  console.log('')
  console.log('=== 汇总 ===')
  const pass = results.filter(r => r.ok).length
  console.log(`  ${pass}/${results.length} 通过`)

  await rm(dir, { recursive: true, force: true })

  // 汇总：任何一项失败都让 test 变红
  const failed = results.filter(r => !r.ok)
  assert.deepEqual(
    failed.map(f => `${f.name} ${f.detail}`), [],
    `${failed.length}/${results.length} 项失败`,
  )
  assert.ok(results.length >= 30, `用例数异常：${results.length}`)
})

/**
 * t3 回归（写盘之争用 + 顺序缺陷）。
 *
 * 实测背景（真实 state.json ≈ 55–56 KB / 120 键；测量时刻 2026-09-25，`Get-Item` 取长度）：
 *   无争用连写 5 次 5/5 成功、4–9ms（平均 6ms）；但另一进程持读句柄时 rename 抛 EPERM。
 *   **旧预算：6 次退避睡眠合计约 248ms（8+16+32+64+128）**——那是**睡眠之和**，
 *   不是硬边界；**实测失败点约 310–330ms**（含写 tmp / rename / 清理的开销）。
 *   本 test 含多条真实争用窗口（400ms/350ms 各一）+ 多次 12 次重试，单项已约 2.7s，
 *   慢机上会接近默认上限，故显式给 timeout。
 */
test('写盘争用重试预算与「先绑定后建会话」（旧代码会失败）', { timeout: 60000 }, async () => {
  const results = []
  const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail })
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`)
  }
  const dir = await mkdtemp(join(tmpdir(), 'tx-e2e2-'))
  const writeFile2 = (await import('node:fs/promises')).writeFile
  const open2 = (await import('node:fs/promises')).open
  const mkdir2 = (await import('node:fs/promises')).mkdir
  /** 稳健清理：Windows 上 rm 常报 ENOTEMPTY/EBUSY，重试以免清理失败掩盖真实断言。 */
  const cleanup = async (d) => {
    for (let i = 0; i < 10; i++) {
      try { await rm(d, { recursive: true, force: true }); return }
      catch (e) {
        if (!/ENOTEMPTY|EBUSY|EPERM|EACCES/.test(String(e?.code ?? ''))) throw e
        await new Promise((r) => setTimeout(r, 30 * (i + 1)))
      }
    }
  }
  /** 造一个「别的进程持着读句柄」的时间窗：holdMs 内 rename 必 EPERM。 */
  const withHold = async (file, holdMs, fn) => {
    const h = await open2(file, 'r')
    let released = false
    const release = async () => { if (!released) { released = true; try { await h.close() } catch {} } }
    const t = setTimeout(() => { release() }, holdMs)
    try { return await fn() } finally { clearTimeout(t); await release() }
  }

  console.log('=== 8) 重试预算：旧 6 次/≈248ms 不够，必须可配且更宽 ===')
  const file = join(dir, 'state.json')
  await writeFile2(file, JSON.stringify({ 'bind:qq:U': 'sess-chat' }))
  // 小预算扛不过 400ms 争用（证明争用窗口真实存在）
  const smallErr = await withHold(file, 400, async () => {
    try { await writeNotifierState({ a: 1 }, file, { attempts: 2, baseDelayMs: 10, maxDelayMs: 20 }); return null }
    catch (e) { return e }
  })
  check('小预算（2 次）在 400ms 争用下必须失败', smallErr !== null, String(smallErr?.code ?? ''))
  check('争用错误码是 EPERM', smallErr?.code === 'EPERM', String(smallErr?.code))
  // 宽预算同窗口必须成功
  let bigErr = null
  const t0 = Date.now()
  await withHold(file, 400, async () => {
    try { await writeNotifierState({ b: 2 }, file, { attempts: 12, baseDelayMs: 30, maxDelayMs: 300 }) }
    catch (e) { bigErr = e }
  })
  check('宽预算（12 次）扛过同一 400ms 争用窗口', bigErr === null, `${Date.now() - t0}ms`)
  // 默认预算必须宽于旧的 ≈248ms
  let defErr = null
  const t1 = Date.now()
  await withHold(file, 350, async () => {
    try { await writeNotifierState({ c: 3 }, file) } catch (e) { defErr = e }
  })
  check('默认预算扛过 350ms 争用（旧默认仅 ≈248ms）', defErr === null, `${Date.now() - t1}ms`)

  console.log('')
  console.log('=== 9) 失败必须给可定位诊断（不是光一句失败文案）===')
  const badDir = join(dir, 'bad-state.json')
  await mkdir2(badDir, { recursive: true })
  const diag = await setBindingDetailed('qq', 'U', 'sess-x', badDir)
  check('写盘失败时 ok=false 且回传 Error', diag.ok === false && diag.error instanceof Error)
  check('带回可定位错误码', diag.code === 'EPERM', String(diag.code))
  check('报出尝试次数与耗时', Number.isInteger(diag.attempts) && typeof diag.elapsedMs === 'number',
    `attempts=${diag.attempts} elapsedMs=${diag.elapsedMs}`)
  check('给出处置建议', typeof diag.suggestion === 'string' && /重试|建议|原因/.test(diag.suggestion),
    String(diag.suggestion).slice(0, 60))

  console.log('')
  console.log('=== 10) 绑定失败时不得创建隔离会话（不留空壳）===')
  const data3 = join(dir, 'data3')
  const state3 = await createStateManager({ dataDir: data3 })
  await state3.setChatSessionId('session-chat-aaa')
  const created3 = []
  const pushed3 = []
  const cmds3 = createCommandHandler({
    state: state3,
    notifier: { async push(m) { pushed3.push(String(m?.content ?? '')) } },
    agents: { async create(o) { created3.push(o.sessionId); return { id: o.sessionId, dispose: async () => {} } } },
    config: {
      agentStartKeyword: '/agentstart', agentStopKeyword: '/agentstop',
      profilePath: join(process.cwd(), '听雪档案.txt'),
      dataDir: data3, notifierStateFile: badDir, channel: 'qq', userId: 'U',
    },
    logger: { warn: () => {}, info: () => {} },
  })
  await cmds3.handle('/agentstart')
  check('绑定失败时未创建任何隔离会话', created3.length === 0, `${created3.length} 个`)
  check('绑定失败时保持聊天模式', state3.mode === 'chat', `mode=${state3.mode}`)
  const failText = pushed3.join('\n')
  check('失败回执带真因（EPERM）', /EPERM/.test(failText), failText.replace(/\n/g, ' ').slice(0, 80))
  check('失败回执说明未留空壳', /未创建隔离会话/.test(failText))

  console.log('')
  console.log('=== 11) 绑定成功 → 新建会话（顺序反转后仍落到正确判据）===')
  const okFile = join(dir, 'ok-state.json')
  await writeFile2(okFile, JSON.stringify({ 'bind:qq:U': 'session-chat-aaa', 'admin:token-hash': 'keep' }))
  const data4 = join(dir, 'data4')
  const state4 = await createStateManager({ dataDir: data4 })
  await state4.setChatSessionId('session-chat-aaa')
  const created4 = []
  const cmds4 = createCommandHandler({
    state: state4, notifier: { async push() {} },
    agents: { async create(o) { created4.push(o.sessionId); return { id: o.sessionId, dispose: async () => {} } } },
    config: {
      agentStartKeyword: '/agentstart', agentStopKeyword: '/agentstop',
      profilePath: join(process.cwd(), '听雪档案.txt'),
      dataDir: data4, notifierStateFile: okFile, channel: 'qq', userId: 'U',
    },
    logger: { warn: () => {}, info: () => {} },
  })
  await cmds4.handle('/agentstart')
  const bound4 = await getBinding('qq', 'U', okFile)
  check('绑定成功后 mode=agent', state4.mode === 'agent', `mode=${state4.mode}`)
  check('创建了 1 个隔离会话', created4.length === 1)
  check('QQ 绑定指向隔离会话（agent 模式的唯一判据）',
    bound4 === state4.agentSessionId && String(bound4).startsWith('tingxue-agent-'), String(bound4))
  check('键级合并未抹掉其他键',
    JSON.parse(await readFile(okFile, 'utf-8'))['admin:token-hash'] === 'keep')
  // /agentstop 回到聊天会话
  await cmds4.handle('/agentstop')
  check('/agentstop 后回到聊天模式', state4.mode === 'chat', `mode=${state4.mode}`)
  check('/agentstop 后绑定回到原聊天会话',
    (await getBinding('qq', 'U', okFile)) === 'session-chat-aaa')

  console.log('')
  console.log('=== 12) /agentstop 回绑失败 → 必须清空绑定键（F1：cleared 分支）===')
  // 这是「mode=chat 但绑定仍指着已销毁隔离会话」的唯一防线，此前零覆盖。
  // 手法：让 setBindingDetailed **第二次**调用（= 回绑那次）写盘失败——
  // 把 state.json 换成同名目录，rename 上去稳定失败（EPERM）。
  const f1File = join(dir, 'f1-state.json')
  await writeFile2(f1File, JSON.stringify({ 'bind:qq:U': 'session-chat-aaa' }))
  const data5 = join(dir, 'data5')
  const state5 = await createStateManager({ dataDir: data5 })
  await state5.setChatSessionId('session-chat-aaa')
  const agents5 = { async create(o) { return { id: o.sessionId, dispose: async () => {} } } }
  const cfg5 = {
    agentStartKeyword: '/agentstart', agentStopKeyword: '/agentstop',
    profilePath: join(process.cwd(), '听雪档案.txt'),
    dataDir: data5, notifierStateFile: f1File, channel: 'qq', userId: 'U',
  }
  const cmds5 = createCommandHandler({
    state: state5, notifier: { async push() {} }, agents: agents5, config: cfg5,
    logger: { warn: () => {}, info: () => {} },
  })
  await cmds5.handle('/agentstart')
  check('F1 前置：已进入 agent 模式', state5.mode === 'agent', `mode=${state5.mode}`)
  const agentSid5 = state5.agentSessionId
  // 破坏写入目标：文件 → 目录
  await rm(f1File, { force: true })
  await mkdir2(f1File, { recursive: true })
  const f1Pushed = []
  const cmds5b = createCommandHandler({
    state: state5, notifier: { async push(m) { f1Pushed.push(String(m?.content ?? '')) } },
    agents: agents5, config: cfg5, logger: { warn: () => {}, info: () => {} },
  })
  await cmds5b.handle('/agentstop')
  const f1Text = f1Pushed.join('\n')
  check('F1 绑定被清空（cleared：回绑失败后删键，QQ 不再指向已销毁会话）',
    (await getBinding('qq', 'U', f1File)) === null,
    `键值=${JSON.stringify(await getBinding('qq', 'U', f1File))}`)
  check('F1 回执明说已清空绑定，不能只回一句「已退出 agent 模式」',
    /已清空绑定|既未回绑也没能清空/.test(f1Text) && !/^已退出 agent 模式，回到日常聊天。$/.test(f1Text.trim()),
    f1Text.replace(/\n/g, ' | ').slice(0, 140))
  // 真断言（原先是硬编码 true 的空断言，白占一行且不检验任何东西）：
  // 防御目标 = 绑定既不能指向已销毁的隔离会话，也不能停留在「无绑定」以外的错误值上。
  check('F1 绑定不得停留在已销毁的隔离会话',
    (await getBinding('qq', 'U', f1File)) !== agentSid5,
    `键值=${JSON.stringify(await getBinding('qq', 'U', f1File))} 原 agentSid=${agentSid5}`)

  console.log('')
  console.log('=== 13) /agentstop：回绑与清空双双失败 → 必须报 unresolved（F1 的 unresolved 分支）===')
  // 覆盖目标：writeExitBinding 的 `unresolved` 分支（回绑失败 **且** 清空也失败）。
  // writeExitBinding 只在 /agentstop 路径上运行，所以本组必须真的走 /agentstop。
  // 构造方式：
  //   ① 先在**可写**路径上正常 /agentstart 进入 agent 模式（前置断言 mode=agent）；
  //   ② 把 chatSessionId 清掉 → handleStop 会走「无可信聊天会话可回绑」那条分支
  //      （原语意：回绑目标不存在 = 回绑失败）；
  //   ③ 把 notifierStateFile 换成同名目录 → 清键的写盘也稳定失败（EPERM）。
  // 于是「回绑失败 + 清空失败」两条同时成立 → unresolved。
  const f1cFile = join(dir, 'f1c-state.json')
  await writeFile2(f1cFile, JSON.stringify({ 'bind:qq:U': 'session-chat-aaa' }))
  const data6 = join(dir, 'data6')
  const state6 = await createStateManager({ dataDir: data6 })
  await state6.setChatSessionId('session-chat-aaa')
  const cfg6 = {
    agentStartKeyword: '/agentstart', agentStopKeyword: '/agentstop',
    profilePath: join(process.cwd(), '听雪档案.txt'),
    dataDir: data6, notifierStateFile: f1cFile, channel: 'qq', userId: 'U',
  }
  const agents6 = { async create(o) { return { id: o.sessionId, dispose: async () => {} } } }
  const cmds6 = createCommandHandler({
    state: state6, notifier: { async push() {} }, agents: agents6, config: cfg6,
    logger: { warn: () => {}, info: () => {} },
  })
  await cmds6.handle('/agentstart')
  check('第13组前置：已进入 agent 模式', state6.mode === 'agent', `mode=${state6.mode}`)
  // ② 清掉 chatSessionId（回绑目标不存在）
  await state6.setChatSessionId(null)
  // ③ 写盘目标变目录（清键也失败）
  await rm(f1cFile, { force: true })
  await mkdir2(f1cFile, { recursive: true })
  const f1cPushed = []
  const cmds6b = createCommandHandler({
    state: state6, notifier: { async push(m) { f1cPushed.push(String(m?.content ?? '')) } },
    agents: agents6, config: cfg6, logger: { warn: () => {}, info: () => {} },
  })
  await cmds6b.handle('/agentstop')
  const f1cText = f1cPushed.join('\n')
  check('第13组 mode 回到 chat', state6.mode === 'chat', `mode=${state6.mode}`)
  check('第13组：回执出现 unresolved 文案「既未回绑也没能清空」',
    /既未回绑也没能清空/.test(f1cText),
    f1cText.replace(/\n/g, ' | ').slice(0, 160))
  check('第13组：回执不得只是「已退出 agent 模式，回到日常聊天。」',
    !/^已退出 agent 模式，回到日常聊天。$/.test(f1cText.trim()),
    f1cText.replace(/\n/g, ' | ').slice(0, 160))

  console.log('')
  console.log('=== 14) 绑定成功但 agents.create 失败 → 绑定回滚到原值（F2）===')
  const f2File = join(dir, 'f2-state.json')
  await writeFile2(f2File, JSON.stringify({ 'bind:qq:U': 'session-chat-aaa' }))
  const data7 = join(dir, 'data7')
  const state7 = await createStateManager({ dataDir: data7 })
  await state7.setChatSessionId('session-chat-aaa')
  const f2Pushed = []
  const cmds7 = createCommandHandler({
    state: state7, notifier: { async push(m) { f2Pushed.push(String(m?.content ?? '')) } },
    agents: { async create() { throw new Error('模拟 agents.create 失败') } },
    config: {
      agentStartKeyword: '/agentstart', agentStopKeyword: '/agentstop',
      profilePath: join(process.cwd(), '听雪档案.txt'),
      dataDir: data7, notifierStateFile: f2File, channel: 'qq', userId: 'U',
    },
    logger: { warn: () => {}, info: () => {} },
  })
  await cmds7.handle('/agentstart')
  const f2Text = f2Pushed.join('\n')
  check('F2 回执说明是「创建隔离会话失败」', /创建隔离会话失败/.test(f2Text),
    f2Text.replace(/\n/g, ' | ').slice(0, 140))
  check('F2 绑定回到原值（原本有值 → restored）',
    (await getBinding('qq', 'U', f2File)) === 'session-chat-aaa',
    `键值=${JSON.stringify(await getBinding('qq', 'U', f2File))}`)
  check('F2 mode 保持 chat', state7.mode === 'chat', `mode=${state7.mode}`)
  check('F2 回执据实说「回滚到原聊天会话」', /回滚到原聊天会话/.test(f2Text))

  console.log('')
  console.log('=== 15) 原本无绑定 + create 失败 → 键不存在，且不谎称「回滚到原聊天会话」（F2）===')
  const f2bFile = join(dir, 'f2b-state.json')
  await writeFile2(f2bFile, JSON.stringify({ 'admin:token-hash': 'keep' })) // 刻意无 bind 键
  const data8 = join(dir, 'data8')
  const state8 = await createStateManager({ dataDir: data8 })
  await state8.setChatSessionId('session-chat-aaa')
  const f2bPushed = []
  const cmds8 = createCommandHandler({
    state: state8, notifier: { async push(m) { f2bPushed.push(String(m?.content ?? '')) } },
    agents: { async create() { throw new Error('模拟 agents.create 失败') } },
    config: {
      agentStartKeyword: '/agentstart', agentStopKeyword: '/agentstop',
      profilePath: join(process.cwd(), '听雪档案.txt'),
      dataDir: data8, notifierStateFile: f2bFile, channel: 'qq', userId: 'U',
    },
    logger: { warn: () => {}, info: () => {} },
  })
  await cmds8.handle('/agentstart')
  const f2bText = f2bPushed.join('\n')
  check('F2b 原本无绑定时键不存在（cleared，不是 restored）',
    (await getBinding('qq', 'U', f2bFile)) === null)
  check('F2b 键级合并未抹掉其他键',
    JSON.parse(await readFile(f2bFile, 'utf-8'))['admin:token-hash'] === 'keep')
  check('F2b 不得谎称「回滚到原聊天会话」', !/回滚到原聊天会话/.test(f2bText),
    f2bText.replace(/\n/g, ' | ').slice(0, 140))
  check('F2b 据实说明原本没有绑定', /原本没有绑定/.test(f2bText),
    f2bText.replace(/\n/g, ' | ').slice(0, 140))

  console.log('')
  console.log('=== 汇总 ===')
  const pass = results.filter(r => r.ok).length
  console.log(`  ${pass}/${results.length} 通过`)
  await cleanup(dir)
  const failed = results.filter(r => !r.ok)
  assert.deepEqual(failed.map(f => `${f.name} ${f.detail}`), [], `${failed.length}/${results.length} 项失败`)
})
