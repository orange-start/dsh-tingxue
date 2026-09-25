// dsh-tingxue test/store.test.mjs
// LanceDB 记忆存储集成测试（真实 lancedb，临时目录）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../src/memory/store.mjs'

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tingxue-'))
  const store = await createMemoryStore({ dataDir: dir, dimensions: 3, embeddingModel: 'test' })
  try {
    await fn(store)
  } finally {
    await store.close()
    await rm(dir, { recursive: true, force: true })
  }
}

test('addMemory + searchMemories 向量检索', async () => {
  await withStore(async (store) => {
    await store.addMemory({ text: '用户喜欢喝咖啡', vector: [0.1, 0.2, 0.3], scene: 'chat' })
    await store.addMemory({ text: '用户讨厌下雨', vector: [0.9, 0.8, 0.7], scene: 'chat' })
    const hits = await store.searchMemories([0.1, 0.2, 0.3], { limit: 2 })
    assert.equal(hits.length, 2)
    assert.equal(hits[0].text, '用户喜欢喝咖啡')
    assert.ok(hits[0].distance < 0.1)
  })
})

test('实体 upsert + 查询 + 语义检索', async () => {
  await withStore(async (store) => {
    await store.upsertEntity({ id: 'e1', name: '咖啡', type: 'thing', summary: '用户喜欢的饮品', vector: [0.1, 0.2, 0.3] })
    const ent = await store.getEntity('e1')
    assert.equal(ent.name, '咖啡')
    const byName = await store.findEntityByName('咖啡')
    assert.equal(byName.id, 'e1')
    const hits = await store.searchEntities([0.1, 0.2, 0.3], { limit: 1 })
    assert.equal(hits[0].id, 'e1')
  })
})

test('关系 + 图遍历', async () => {
  await withStore(async (store) => {
    await store.upsertEntity({ id: 'e1', name: '用户', type: 'person', summary: '', vector: [0.1, 0.2, 0.3] })
    await store.upsertEntity({ id: 'e2', name: '咖啡', type: 'thing', summary: '', vector: [0.4, 0.5, 0.6] })
    await store.addRelation({ sourceId: 'e1', targetId: 'e2', relation: '喜欢', source: 'chat' })
    const rels = await store.relationsOf('e1')
    assert.equal(rels.length, 1)
    assert.equal(rels[0].relation, '喜欢')
  })
})

test('最新信息有界', async () => {
  await withStore(async (store) => {
    for (let i = 0; i < 8; i++) await store.addLatest({ kind: 'file-summary', text: `摘要${i}` })
    const latest = await store.listLatest({ limit: 5 })
    assert.equal(latest.length, 5)
    assert.equal(latest[0].text, '摘要7') // 最新在前
  })
})
