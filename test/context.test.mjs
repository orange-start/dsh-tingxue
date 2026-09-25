// dsh-tingxue test/context.test.mjs
// 上下文组装测试：四块结构、预算截断、顺序固定。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assembleContext, blocksToSystemText, estimateTokens } from '../src/context/assemble.mjs'

test('estimateTokens 中文按字、英文按词', () => {
  assert.equal(estimateTokens('你好世界'), 4)
  assert.equal(estimateTokens('hello world'), 2)
  assert.equal(estimateTokens('你好 hello'), 3)
})

test('四块上下文顺序固定：档案→记忆→最近→最新', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tingxue-ctx-'))
  const profilePath = join(dir, 'profile.txt')
  await writeFile(profilePath, '你是听雪，一个温柔的女孩。', 'utf-8')

  const memory = {
    searchMemories: async () => [{ text: '用户喜欢咖啡', entityIds: ['e1'] }],
    expandFromEntities: async () => ({ relatedEntities: [{ name: '咖啡', type: 'thing', summary: '饮品' }] }),
    listLatest: async () => [{ text: '文件摘要：项目计划' }],
  }
  const model = { embed: async () => [[0.1, 0.2, 0.3]] }

  const { blocks } = await assembleContext({
    profilePath,
    currentInput: '今天喝什么',
    memory,
    model,
    recentRounds: [{ user: '早', assistant: '早呀' }],
    // [3] 默认关闭（会话历史已含最近对话，注入即重复）；这里显式打开以验证顺序
    config: { injectRecentRounds: true },
  })

  const names = blocks.map((b) => b.name)
  assert.deepEqual(names, ['听雪档案', '记忆检索', '最近对话', '最新信息'])
  assert.ok(blocks[0].content.includes('听雪'))
  assert.ok(blocks[1].content.includes('咖啡'))
  assert.ok(blocks[2].content.includes('早呀'))
  assert.ok(blocks[3].content.includes('项目计划'))

  await rm(dir, { recursive: true, force: true })
})

test('默认不注入最近对话（避免与会话历史重复）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tingxue-ctx3-'))
  const profilePath = join(dir, 'profile.txt')
  await writeFile(profilePath, '档案', 'utf-8')

  const memory = {
    searchMemories: async () => [{ text: '记忆A', entityIds: [] }],
    expandFromEntities: async () => ({ relatedEntities: [] }),
    listLatest: async () => [],
  }
  const model = { embed: async () => [[0.1]] }

  const { blocks } = await assembleContext({
    profilePath,
    currentInput: 'x',
    memory,
    model,
    recentRounds: [{ user: '不该出现', assistant: '不该出现' }],
    config: {},
  })

  const names = blocks.map((b) => b.name)
  assert.ok(!names.includes('最近对话'), `默认不该有最近对话块: ${names.join(',')}`)
  const text = blocksToSystemText(blocks)
  assert.ok(!text.includes('不该出现'), '默认不该把最近对话写进 system 文本')

  await rm(dir, { recursive: true, force: true })
})

/**
 * t4 回归：`recentRounds` 对**注入上下文长度**没有影响（当 injectRecentRounds 关闭时）。
 *
 * 真机背景（实测，见交接文档 §11）：用户把 recentRounds 设成 10，却发现「DSH 统计的
 * 上下文长度仍在增长」。实测归因：注入块里 [3]最近对话 = 0 字符（被 injectRecentRounds
 * 守卫）、[4]最新信息 = 0 字符（无写入者），**注入小计恒约 20.3K**，而会变的是 [2]记忆块
 * （12.1K–15.0K，取决于本轮检索命中几条）与 [1]档案（改档案文件即永久变大）。
 * 也就是说：**调 recentRounds 不会让上下文变小或变大**，它只控制「重复注入最近对话」。
 */
test('recentRounds 不影响注入长度（injectRecentRounds 关闭时）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tingxue-ctx4-'))
  const profilePath = join(dir, 'profile.txt')
  await writeFile(profilePath, '档案正文', 'utf-8')

  const memory = {
    searchMemories: async () => [{ text: '记忆A', entityIds: [] }],
    expandFromEntities: async () => ({ relatedEntities: [] }),
    listLatest: async () => [],
  }
  const model = { embed: async () => [[0.1]] }
  // 造 100 轮会话历史：若 recentRounds 泄漏进注入，长度必然随它变化
  const rounds = Array.from({ length: 100 }, (_, i) => ({ user: `Q${i}`, assistant: `A${i}` }))

  const base = { profilePath, currentInput: 'x', memory, model, recentRounds: rounds }
  const a = await assembleContext({ ...base, config: { recentRounds: 10 } })
  const b = await assembleContext({ ...base, config: { recentRounds: 100 } })
  const textA = blocksToSystemText(a.blocks)
  const textB = blocksToSystemText(b.blocks)

  assert.equal(textA.length, textB.length,
    `recentRounds 10→100 不得改变注入长度（实测 ${textA.length} vs ${textB.length}）`)
  assert.ok(!textA.includes('Q0'), '注入里不得出现会话历史原文')
  assert.ok(!textA.includes('【最近对话】'), '默认不该有最近对话块')
  // 关掉时「最近对话」块根本不参与，因此 recentRounds 这个旋钮对长度无效果
  const names = a.blocks.map((x) => x.name)
  assert.deepEqual(names.filter((n) => n === '最近对话'), [])

  await rm(dir, { recursive: true, force: true })
})

/**
 * t4 回归：`[4] 最新信息` 在**没有数据源**时必须整块消失（不产出空标题）。
 *
 * 真机实测：68 条 request/header 里 `【最新信息】` 出现 **0 次**；`store.addLatest`
 * 全仓无调用者（插件写的是 state.latestInfo，实测为 []），所以该 table 始终为空。
 * 代码路径本身是活的，属于「有读取无写入」的未接线状态。
 */
test('无写入者时最新信息块整块消失（不产出空标题）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tingxue-ctx5-'))
  const profilePath = join(dir, 'profile.txt')
  await writeFile(profilePath, '档案正文', 'utf-8')

  const memory = {
    searchMemories: async () => [],
    expandFromEntities: async () => ({ relatedEntities: [] }),
    // 空表：store.listLatest 在无 addLatest 写入时的真实返回
    listLatest: async () => [],
  }
  const model = { embed: async () => [[0.1]] }

  const { blocks } = await assembleContext({
    profilePath, currentInput: '', memory, model,
    recentRounds: [],
    config: { latestInfoBudgetTokens: 1000 },
  })
  const text = blocksToSystemText(blocks)
  assert.ok(!text.includes('【最新信息】'),
    `无数据源时不该出现最新信息标题，实际：${text.slice(0, 120)}`)
  assert.deepEqual(blocks.map((b) => b.name), ['听雪档案'],
    '只应有档案块（记忆无命中、最近对话关闭、最新信息为空）')

  await rm(dir, { recursive: true, force: true })
})

test('记忆检索超预算截断', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tingxue-ctx2-'))
  const profilePath = join(dir, 'profile.txt')
  await writeFile(profilePath, '档案', 'utf-8')

  const longText = '记忆内容'.repeat(500) // 1500 字
  const memory = {
    searchMemories: async () => [
      { text: longText, entityIds: [] },
      { text: '短记忆', entityIds: [] },
    ],
    expandFromEntities: async () => ({ relatedEntities: [] }),
    listLatest: async () => [],
  }
  const model = { embed: async () => [[0.1, 0.2, 0.3]] }

  const { blocks } = await assembleContext({
    profilePath,
    currentInput: 'x',
    memory,
    model,
    recentRounds: [],
    config: { memoryBudgetTokens: 100 },
  })

  const memBlock = blocks.find((b) => b.name === '记忆检索')
  assert.ok(memBlock.tokens <= 100, `记忆块超预算: ${memBlock.tokens}`)

  await rm(dir, { recursive: true, force: true })
})

test('blocksToSystemText 拼接非空块', () => {
  const text = blocksToSystemText([
    { name: 'a', content: '档案', tokens: 2 },
    { name: 'b', content: '', tokens: 0 },
    { name: 'c', content: '记忆', tokens: 2 },
  ])
  assert.equal(text, '档案\n\n记忆')
})
