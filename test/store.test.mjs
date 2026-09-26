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

// ── t13 回归：检索必须按 identity 过滤，不得串到他人记忆 ────────────────
//
// 缺陷原形（修复前 searchMemories 只有 scene 过滤）：
//   写入时分人（addMemory 的 identity），读出时不分人 → 任何一次检索都返回混合记忆。
//   实测（LanceDB 真实库，同一向量）：owner 的 `user` 记忆与另一来源的 `qq:999` 记忆一起返回。

test('t13: searchMemories 默认只返回同 identity 的记忆（不串到他人）', async () => {
  await withStore(async (store) => {
    await store.addMemory({ text: '主人喜欢喝咖啡', vector: [0.1, 0.2, 0.3], scene: 'chat', identity: 'user' })
    await store.addMemory({ text: '别人的隐私：他住在某地', vector: [0.1, 0.2, 0.3], scene: 'chat', identity: 'qq:999' })

    const hits = await store.searchMemories([0.1, 0.2, 0.3], { limit: 10 })
    const texts = hits.map((h) => h.text)
    assert.ok(!texts.some((t) => t.includes('别人的隐私')),
      `检索串到了他人记忆：${texts.join(' | ')}`)
    assert.equal(hits.length, 1, `默认只应返回 owner 的记忆，实际 ${hits.length} 条`)
    assert.equal(hits[0].text, '主人喜欢喝咖啡')
    assert.ok(hits.every((h) => h.identity === 'user'), '返回结果的 identity 必须一致')
  })
})

test('t13: 显式 identity 只命中该身份；不存在的身份返回空', async () => {
  await withStore(async (store) => {
    await store.addMemory({ text: 'A 的记忆', vector: [0.1, 0.2, 0.3], scene: 'chat', identity: 'qq:A' })
    await store.addMemory({ text: 'B 的记忆', vector: [0.1, 0.2, 0.3], scene: 'chat', identity: 'qq:B' })

    const a = await store.searchMemories([0.1, 0.2, 0.3], { limit: 10, identity: 'qq:A' })
    assert.equal(a.length, 1)
    assert.equal(a[0].text, 'A 的记忆')

    const b = await store.searchMemories([0.1, 0.2, 0.3], { limit: 10, identity: 'qq:B' })
    assert.equal(b.length, 1)
    assert.equal(b[0].text, 'B 的记忆')

    const none = await store.searchMemories([0.1, 0.2, 0.3], { limit: 10, identity: 'qq:NOBODY' })
    assert.equal(none.length, 0, '不存在的身份必须返回空，而不是全库')
  })
})

test('t13: identity 默认值与 addMemory 默认一致（既有库存无需迁移，单用户行为不变）', async () => {
  await withStore(async (store) => {
    // 不传 identity 写入 → 走 addMemory 默认
    await store.addMemory({ text: '旧库存（无 identity 显式传入）', vector: [0.1, 0.2, 0.3], scene: 'chat' })
    // 检索也不传 identity → 走 searchMemories 默认，必须能搜到旧库存
    const hits = await store.searchMemories([0.1, 0.2, 0.3], { limit: 10 })
    assert.equal(hits.length, 1, '默认默认必须自洽：旧库存仍可被检索（否则单用户场景回归）')
    assert.equal(hits[0].identity, 'user')
  })
})

test('t13: identity 含单引号不会破坏过滤（字面量转义）', async () => {
  await withStore(async (store) => {
    await store.addMemory({ text: '带引号身份', vector: [0.1, 0.2, 0.3], scene: 'chat', identity: "qq:o'brien" })
    await store.addMemory({ text: '别的身份', vector: [0.1, 0.2, 0.3], scene: 'chat', identity: 'qq:other' })
    const hits = await store.searchMemories([0.1, 0.2, 0.3], { limit: 10, identity: "qq:o'brien" })
    assert.equal(hits.length, 1, `单引号身份应被正确转义，实际 ${hits.length} 条`)
    assert.equal(hits[0].text, '带引号身份')
  })
})
