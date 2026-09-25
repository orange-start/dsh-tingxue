// dsh-tingxue test/agent-mode-e2e.test.mjs
//
// 真机路径全流程（不改真实绑定：全程用临时 state / data 目录）
//
// 驱动的是**真实的** createCommandHandler + createStateManager + setBindingDetailed，
// 只把 ctx.agents / ctx.notifier 换成替身（它们要的是 DSH 运行时，测试环境没有）。
// 这样 /agentstart → /agentstop 的完整状态机、绑定写入、route 清理、记忆归档全部真实执行。

import { createStateManager } from '../src/state/index.mjs'
import { createCommandHandler } from '../src/commands/index.mjs'
import { readNotifierState } from '../src/bind/index.mjs'
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
  const badRes = await cmds2.handle('/agentstart')
  // dispose 走 setImmediate 延迟（避免在 pre-step 内销毁正在跑的 agent），
  // 要给它一个 tick 才反映到 disposed 数组。
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  const st4 = state2

  check('写绑定失败时仍被消费（有回执）', badRes === true)
  check('失败时回滚了隔离会话', disposed.length > disposedBefore, `disposed ${disposedBefore} → ${disposed.length}`)
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
