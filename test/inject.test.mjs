// dsh-tingxue test/inject.test.mjs
//
// 上下文注入时序回归测试。
//
// 守护的 bug：section.text 是同步的，而 assemble() 在跑 system-prompt/assemble 瀑布
// 之前就把它读走了。若「异步预算 + text 同步返回缓存」，缓存永远滞后一轮：
// 首轮空、之后错位，真机上表现为 system 提示词在 6827 / 13872 字符之间抖动。
//
// 本测试用 DSH 真实顺序复现：先同步读 section.text 拼 assembly，再 await 瀑布。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createContextCache, installContextInjection, SECTION_NAME } from '../src/context/inject.mjs'

/** 最小 systemPrompt 服务：复刻 assemble() 的真实顺序（同步读 text → await 瀑布）。 */
function makeSystemPrompt() {
  const sections = new Map()
  const listeners = []
  return {
    section(def) {
      if (sections.has(def.name)) throw new Error(`duplicate section: ${def.name}`)
      sections.set(def.name, def)
      return () => sections.delete(def.name)
    },
    on(_event, handler) { listeners.push(handler); return () => listeners.splice(listeners.indexOf(handler), 1) },
    /** 复刻 system-prompt/index.ts:504-541 的顺序 */
    async assemble(context) {
      const assembly = {
        sections: [...sections.values()]
          .sort((a, b) => a.order - b.order)
          // 关键：同步求值，早于任何瀑布
          .map((s) => ({ name: s.name, text: typeof s.text === 'function' ? s.text(context) : s.text })),
        contexts: [],
        tools: [],
        variables: {},
      }
      let out = assembly
      for (const h of listeners) {
        const prev = out
        out = await h(prev, context, async () => prev)
      }
      return out
    },
    render(assembly) {
      return assembly.sections.filter((s) => s.text.length > 0).map((s) => s.text).join('\n\n')
    },
  }
}

/** agent 作用域 ctx：get('systemPrompt') + on() + effect()，够插件用。 */
function makeAgent(id, systemPrompt) {
  let cleanup
  return {
    id,
    ctx: {
      get: (n) => (n === 'systemPrompt' ? systemPrompt : undefined),
      on: (e, h) => systemPrompt.on(e, h),
      effect: (fn) => { cleanup = fn() },
    },
    /** 触发 effect 的 disposer（模拟 agent dispose） */
    dispose: () => cleanup?.(),
  }
}

test('首个装配就带上真值（旧设计在这里只能拿到空串）', async () => {
  const sp = makeSystemPrompt()
  const agent = makeAgent('chat-session', sp)

  // 模拟「异步检索」：真值只有在 await 之后才存在
  const cache = createContextCache({
    getInput: () => '你好',
    build: async () => {
      await new Promise((r) => setTimeout(r, 5))
      return '【听雪档案】\n你是听雪。'
    },
  })
  installContextInjection({ agent, shouldInject: () => true, ensureText: () => cache.get() })

  const text = sp.render(await sp.assemble({ agent }))
  assert.ok(text.includes('你是听雪'), `首个装配就该有真值，实际拿到: ${JSON.stringify(text)}`)
})

test('多步回合只检索一次（同一句输入不重复 embed）', async () => {
  const sp = makeSystemPrompt()
  const agent = makeAgent('chat-session', sp)
  let builds = 0
  const cache = createContextCache({
    getInput: () => '同一句话',
    build: async () => { builds++; return '块' },
  })
  installContextInjection({ agent, shouldInject: () => true, ensureText: () => cache.get() })

  await sp.assemble({ agent })
  await sp.assemble({ agent })
  await sp.assemble({ agent })
  assert.equal(builds, 1, `同一句输入应只组装一次，实际 ${builds} 次`)
})

test('预热与瀑布共用同一次检索（不重复 embed）', async () => {
  // 真机形态：用户消息到达时后台预热，随后 agent 循环进瀑布。
  // 两者必须命中同一个 in-flight，否则每条消息白检索两次（0.8s × 2）。
  const sp = makeSystemPrompt()
  const agent = makeAgent('chat-session', sp)
  let builds = 0
  let resolveBuild
  const cache = createContextCache({
    getInput: () => '你好',
    build: () => { builds++; return new Promise((r) => { resolveBuild = r }) },
  })
  installContextInjection({ agent, shouldInject: () => true, ensureText: () => cache.get() })

  // 预热（不 await，模拟 inbox/inserted 里的后台调用）
  const warm = cache.get()
  // 紧接着瀑布来取 —— 此时预热还没完成
  const viaWaterfall = sp.assemble({ agent })
  resolveBuild('【听雪档案】')
  const [w, assembly] = await Promise.all([warm, viaWaterfall])

  assert.equal(builds, 1, `预热与瀑布应共用一次检索，实际 ${builds} 次`)
  assert.equal(w, '【听雪档案】')
  assert.ok(sp.render(assembly).includes('【听雪档案】'), '瀑布必须拿到预热的结果')
})

test('先发起的慢检索晚回来，不覆盖后发起的新结果', async () => {
  const sp = makeSystemPrompt()
  const agent = makeAgent('chat-session', sp)
  let input = '第一条'
  const slow = { resolve: null }
  let builds = 0
  const cache = createContextCache({
    getInput: () => input,
    build: async () => {
      builds++
      const mine = input
      if (builds === 1) await new Promise((r) => { slow.resolve = r }) // 第一条很慢
      return `块:${mine}`
    },
  })
  installContextInjection({ agent, shouldInject: () => true, ensureText: () => cache.get() })

  const first = cache.get()          // 慢的，卡住
  input = '第二条'
  cache.invalidate()
  const second = await cache.get()   // 快的，先回来
  assert.equal(second, '块:第二条')

  slow.resolve()                     // 慢的现在才回来
  await first

  // 缓存里必须还是第二条的结果
  const fromCache = await cache.get()
  assert.equal(fromCache, '块:第二条', '慢的旧结果不该覆盖新结果')
})

test('同一轮多 step：输入被配对逻辑清空后，记忆块不该消失', async () => {
  // 真机 bug：assistant/message 每个 step 都会触发，step0 结束时把「待配对输入」
  // 清空；若检索拿的是那个变量，step1 的 currentInput 就成了空串 → 记忆块整块消失。
  // 实测同一轮 system 从 15817 掉到 13872（差 1945 = 记忆块）。
  const sp = makeSystemPrompt()
  const agent = makeAgent('chat-session', sp)

  let turn = '今天想吃什么'   // 「本轮输入」：整轮不变，检索与缓存键用它
  let searches = 0

  const cache = createContextCache({
    getInput: () => turn,
    build: async () => {
      if (!turn) return '【听雪档案】'          // 输入空 → 检索被跳过（bug 形态）
      searches++
      return `【听雪档案】\n【相关记忆】\n- 因为${turn}`
    },
  })
  installContextInjection({ agent, shouldInject: () => true, ensureText: () => cache.get() })

  // step0：有输入，记忆块在
  const step0 = sp.render(await sp.assemble({ agent }))
  assert.ok(step0.includes('【相关记忆】'), 'step0 该有记忆块')

  // step0 结束：配对逻辑清空「待配对输入」。turnInput 不受影响——
  // 这正是修复点：生产代码里它们是两个变量（plugin-entry.mjs 的 turnInput）。

  // step1：同一轮，记忆块必须还在
  const step1 = sp.render(await sp.assemble({ agent }))
  assert.ok(step1.includes('【相关记忆】'), 'step1 记忆块不该消失')
  assert.equal(step1, step0, '同一轮各 step 的 system 应完全一致')
  assert.equal(searches, 1, `同一轮只该检索一次，实际 ${searches} 次`)
})

test('用户换新消息后重新检索', async () => {
  const sp = makeSystemPrompt()
  const agent = makeAgent('chat-session', sp)
  let input = '第一句'
  let builds = 0
  const cache = createContextCache({
    getInput: () => input,
    build: async () => { builds++; return `块:${input}` },
  })
  installContextInjection({ agent, shouldInject: () => true, ensureText: () => cache.get() })

  assert.ok(sp.render(await sp.assemble({ agent })).includes('第一句'))
  input = '第二句'
  cache.invalidate()
  assert.ok(sp.render(await sp.assemble({ agent })).includes('第二句'))
  assert.equal(builds, 2)
})

test('agent 模式返回 null 时不落缓存（切回聊天后不会一直读到空）', async () => {
  const sp = makeSystemPrompt()
  const agent = makeAgent('chat-session', sp)
  let agentMode = true
  const cache = createContextCache({
    getInput: () => '你好',
    build: async () => (agentMode ? null : '人格块'),
  })
  installContextInjection({ agent, shouldInject: () => true, ensureText: () => cache.get() })

  assert.equal(sp.render(await sp.assemble({ agent })), '', 'agent 模式下不该注入')
  agentMode = false
  assert.ok(sp.render(await sp.assemble({ agent })).includes('人格块'), '切回聊天后必须立刻恢复注入')
})

test('只认自己的装配：别的 agent 的 scope 不注入（防跨会话串线）', async () => {
  const sp = makeSystemPrompt()
  const mine = makeAgent('chat-session', sp)
  const other = makeAgent('unrelated-session', sp)
  const cache = createContextCache({ getInput: () => 'x', build: async () => '听雪私密上下文' })
  installContextInjection({ agent: mine, shouldInject: () => true, ensureText: () => cache.get() })

  assert.ok(sp.render(await sp.assemble({ agent: mine })).includes('听雪'))
  assert.equal(sp.render(await sp.assemble({ agent: other })), '', '无关会话绝不能拿到听雪上下文')
  assert.equal(sp.render(await sp.assemble({})), '', '无 agent 的诊断装配也不该拿到')
})

test('块保持就位（order 位置不被推到末尾）', async () => {
  const sp = makeSystemPrompt()
  sp.section({ name: 'deployment:persona', order: 0, text: '人格' })
  sp.section({ name: 'tool-guidance', order: 150, text: '工具指引' })
  const agent = makeAgent('chat-session', sp)
  const cache = createContextCache({ getInput: () => 'x', build: async () => '听雪块' })
  installContextInjection({ agent, shouldInject: () => true, ensureText: () => cache.get() })

  const assembly = await sp.assemble({ agent })
  const names = assembly.sections.map((s) => s.name)
  assert.deepEqual(names, ['deployment:persona', SECTION_NAME, 'tool-guidance'],
    `听雪块应停在自己 order:100 的位置，实际顺序: ${names.join(' -> ')}`)
})

test('section 占位为空文本：不注入时 system 里不留空块', async () => {
  const sp = makeSystemPrompt()
  const agent = makeAgent('chat-session', sp)
  const cache = createContextCache({ getInput: () => 'x', build: async () => '' })
  installContextInjection({ agent, shouldInject: () => true, ensureText: () => cache.get() })

  assert.equal(sp.render(await sp.assemble({ agent })), '', '空上下文应渲染为空，不留残余')
})

test('shouldInject 为假时不挂任何东西（无关会话零开销）', async () => {
  const sp = makeSystemPrompt()
  const agent = makeAgent('other', sp)
  const ok = installContextInjection({
    agent, shouldInject: () => false, ensureText: async () => '不该出现',
  })
  assert.equal(ok, false)
  assert.equal(sp.render(await sp.assemble({ agent })), '')
})

test('组装抛错不致命：退化成只有 DSH 本体', async () => {
  const sp = makeSystemPrompt()
  const agent = makeAgent('chat-session', sp)
  const errors = []
  const cache = createContextCache({
    getInput: () => 'x',
    build: async () => { throw new Error('向量服务挂了') },
    warn: (m) => errors.push(m),
  })
  installContextInjection({ agent, shouldInject: () => true, ensureText: () => cache.get(), warn: (m) => errors.push(m) })

  assert.equal(sp.render(await sp.assemble({ agent })), '', '检索失败不该炸掉整个请求')
  assert.ok(errors.some((m) => m.includes('向量服务挂了')), `应记录告警，实际: ${errors.join('|')}`)
})

test('重复注入同一个 agent 幂等（两个入口都触发也不炸）', async () => {
  const sp = makeSystemPrompt()
  const agent = makeAgent('chat-session', sp)
  const errors = []
  const cache = createContextCache({ getInput: () => 'x', build: async () => '块' })
  const install = () => installContextInjection({
    agent, shouldInject: () => true, ensureText: () => cache.get(), warn: (m) => errors.push(m),
  })

  assert.equal(install(), true)
  // 第二次不该因 section 重名抛错，也不该改变装配结果
  assert.equal(install(), true)
  assert.equal(install(), true)
  assert.deepEqual(errors, [], `不该有告警: ${errors.join('|')}`)

  const assembly = await sp.assemble({ agent })
  assert.equal(assembly.sections.filter((s) => s.name === SECTION_NAME).length, 1, '同名块只该有一个')
  assert.ok(sp.render(assembly).includes('块'))
})

test('disposer 卸载后不再注入', async () => {
  const sp = makeSystemPrompt()
  const agent = makeAgent('chat-session', sp)
  const cache = createContextCache({ getInput: () => 'x', build: async () => '块' })
  installContextInjection({ agent, shouldInject: () => true, ensureText: () => cache.get() })

  assert.ok(sp.render(await sp.assemble({ agent })).includes('块'))
  agent.dispose()
  assert.equal(sp.render(await sp.assemble({ agent })), '', '卸载后不该再注入')
})
