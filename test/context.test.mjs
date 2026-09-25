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
