// dsh-tingxue test/graph.test.mjs
// 关系图谱服务测试：实体抽取、实体链接、关系建立、图遍历。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGraphService } from '../src/graph/index.mjs'

// mock 模型：embed 返回固定向量，complete 按输入返回不同实体
function makeMockModel() {
  return {
    embed: async (texts) => (Array.isArray(texts) ? texts : [texts]).map(() => [0.1, 0.2, 0.3]),
    complete: async (prompt) => {
      if (prompt.includes('下雨')) {
        return JSON.stringify({
          entities: [{ name: '用户', type: 'person' }, { name: '下雨', type: 'concept' }],
          relations: [{ source: '用户', target: '下雨', relation: '讨厌' }],
        })
      }
      return JSON.stringify({
        entities: [{ name: '用户', type: 'person' }, { name: '咖啡', type: 'thing' }],
        relations: [{ source: '用户', target: '咖啡', relation: '喜欢' }],
      })
    },
  }
}

// mock store：内存实现
function makeMockStore() {
  const entities = new Map()
  const relations = []
  return {
    entities, relations,
    async findEntityByName(name) {
      for (const e of entities.values()) if (e.name === name) return e
      return null
    },
    async getEntity(id) { return entities.get(id) ?? null },
    async upsertEntity({ id, name, type, summary, vector }) {
      entities.set(id, { id, name, type, summary, vector })
      return id
    },
    async searchEntities() { return [] },
    async addRelation({ sourceId, targetId, relation, source }) {
      relations.push({ sourceId, targetId, relation, source })
      return 'r1'
    },
    async relationsOf(entityId) {
      return relations.filter((r) => r.sourceId === entityId || r.targetId === entityId)
    },
  }
}

test('ingest 抽取实体并写入图谱', async () => {
  const store = makeMockStore()
  const graph = createGraphService(store, makeMockModel())
  const result = await graph.ingest('用户喜欢喝咖啡', { source: 'chat' })
  assert.equal(result.newEntities, 2)
  assert.equal(result.relationsAdded, 1)
  assert.equal(store.entities.size, 2)
  assert.equal(store.relations.length, 1)
})

test('实体链接：同名实体复用', async () => {
  const store = makeMockStore()
  const graph = createGraphService(store, makeMockModel())
  await graph.ingest('用户喜欢咖啡', { source: 'chat' })
  const before = store.entities.size
  await graph.ingest('用户讨厌下雨', { source: 'chat' })
  // 用户实体应复用，不新增
  assert.equal(store.entities.size, before + 1) // 只新增"下雨"
})

test('图遍历：从种子实体扩展', async () => {
  const store = makeMockStore()
  const graph = createGraphService(store, makeMockModel())
  await graph.ingest('用户喜欢咖啡', { source: 'chat' })
  const user = store.entities.get([...store.entities.keys()].find((k) => store.entities.get(k).name === '用户'))
  const { relatedEntities, relations } = await graph.expandFromEntities([user.id], { depth: 1 })
  assert.equal(relations.length, 1)
  assert.equal(relatedEntities.length, 1)
  assert.equal(relatedEntities[0].name, '咖啡')
})
