// 记忆服务独立测试：用假 store/model/graph 启动 HTTP 服务，验证各接口。
import { createMemoryService } from '../src/memory-service/index.mjs'

// 假 embedding 模型：返回固定维度向量
const fakeModel = {
  async embed(texts) {
    return texts.map((t) => new Array(4).fill(0.1))
  },
}

// 假记忆存储
const fakeStore = {
  async addMemory({ text, vector, scene, identity, source }) {
    return 'mem-' + text.length
  },
  async searchMemories(vector, { limit = 8, scene } = {}) {
    return [{ id: 'm1', text: '张三喜欢喝咖啡', scene: scene ?? 'chat', identity: 'user:1', createdAt: 123, distance: 0.3 }]
  },
  async listAllEntities() {
    return [{ id: 'e1', name: '张三', type: 'person', summary: '用户' }]
  },
  async listAllRelations() {
    return [{ id: 'r1', sourceId: 'e1', targetId: 'e2', relation: '喜欢' }]
  },
}

// 假图谱服务
const fakeGraph = {
  async ingest(text, { source } = {}) {
    return { entityIds: ['e1'], newEntities: 1 }
  },
  async expandFromEntities(entityIds, { depth = 1 } = {}) {
    return { relatedEntities: [{ id: 'e2', name: '咖啡', type: 'thing' }], relations: [{ id: 'r1', sourceId: 'e1', targetId: 'e2', relation: '喜欢' }] }
  },
}

const svc = createMemoryService(
  { store: fakeStore, model: fakeModel, graph: fakeGraph, profilePath: '', logger: console },
  { memoryServicePort: 8798 }
)
const url = await svc.start()
console.log('URL:', url)

// 1. POST /memory
const postRes = await fetch(url + '/memory', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: '张三说他喜欢喝咖啡', scene: 'group', identity: 'user:1', source: 'astrbot' }),
})
const post = await postRes.json()
console.log('POST /memory:', JSON.stringify(post))
console.log('  ok:', post.ok === true, 'memoryId:', post.memoryId, 'entityIds:', post.entityIds)

// 2. GET /memory/search
const searchRes = await fetch(url + '/memory/search?q=咖啡&limit=5&scene=group')
const search = await searchRes.json()
console.log('GET /memory/search:', JSON.stringify(search))
console.log('  ok:', search.ok === true, 'results:', search.results?.length)

// 3. GET /memory/entities
const entRes = await fetch(url + '/memory/entities')
const ent = await entRes.json()
console.log('GET /memory/entities:', JSON.stringify(ent))
console.log('  ok:', ent.ok === true, 'entities:', ent.entities?.length)

// 4. GET /memory/relations
const relRes = await fetch(url + '/memory/relations')
const rel = await relRes.json()
console.log('GET /memory/relations:', JSON.stringify(rel))
console.log('  ok:', rel.ok === true, 'relations:', rel.relations?.length)

// 5. GET /memory/expand
const expRes = await fetch(url + '/memory/expand?entityId=e1&depth=1')
const exp = await expRes.json()
console.log('GET /memory/expand:', JSON.stringify(exp))
console.log('  ok:', exp.ok === true, 'relatedEntities:', exp.relatedEntities?.length)

// 6. GET /profile
const profRes = await fetch(url + '/profile')
const prof = await profRes.json()
console.log('GET /profile:', JSON.stringify(prof))
console.log('  ok:', prof.ok === true)

// 7. 错误：POST /memory 缺 text
const badRes = await fetch(url + '/memory', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({}),
})
const bad = await badRes.json()
console.log('POST /memory (no text):', badRes.status, JSON.stringify(bad))
console.log('  ok:', bad.ok === false)

// 7b. 边界：POST /memory 非法 JSON → 400（客户端错误，而非 500）
const badJsonRes = await fetch(url + '/memory', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '这不是 JSON {{{',
})
const badJson = await badJsonRes.json()
console.log('POST /memory (bad json):', badJsonRes.status, JSON.stringify(badJson))
console.log('  ok:', badJsonRes.status === 400, badJson.ok === false)

// 8. 404
const nfRes = await fetch(url + '/nope')
console.log('GET /nope:', nfRes.status)

await svc.stop()
console.log('stopped OK')
