// 记忆服务独立测试：用假 store/model/graph 启动 HTTP 服务，验证各接口。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryService } from '../src/memory-service/index.mjs'

// 记录每次写入实际落到的 identity / 收到的检索 identity，供 t13 断言使用
const writeLog = []
const searchLog = []

// 假 embedding 模型：返回固定维度向量
const fakeModel = {
  async embed(texts) {
    return texts.map((t) => new Array(4).fill(0.1))
  },
}

// 假记忆存储
const fakeStore = {
  async addMemory({ text, vector, scene, identity, source }) {
    writeLog.push({ text, identity, scene, source })
    return 'mem-' + text.length
  },
  async searchMemories(vector, { limit = 8, scene, identity } = {}) {
    searchLog.push({ identity, scene, limit })
    // 有过滤时只回该 identity 的结果，模拟真实 store 的过滤语义
    if (identity !== undefined && identity !== null && identity !== 'user:1') return []
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

// ── t13 回归：identity 必须由服务端决定，不接受客户端伪造 ──────────────
//
// 缺陷原形（修复前）：handle() 从 body 取 identity，GET /memory/search 完全不传 identity。
// 实测（真实 LanceDB 库）：owner 的 `user` 记忆与另一来源的 `qq:999` 记忆会被一起返回。
// 修法：服务端配置 `memoriesIdentity` 为权威身份；写入忽略客户端 identity，检索强制带上它。

test('t13: POST /memory 忽略客户端伪造的 identity，按服务端 identity 写入', async () => {
  const w = []
  const s = []
  const svc2 = createMemoryService(
    {
      store: {
        async addMemory({ text, identity, scene, source }) { w.push({ text, identity }); return 'id-' + text.length },
        async searchMemories(v, { identity } = {}) { s.push(identity); return [] },
        async listAllEntities() { return [] },
        async listAllRelations() { return [] },
      },
      model: fakeModel, graph: fakeGraph, profilePath: '', logger: { warn() {}, info() {} },
    },
    // 服务端权威身份 = 本机主人
    { memoryServicePort: 8799, memoriesIdentity: 'qq:OWNER' },
  )
  const u2 = await svc2.start()
  try {
    // 客户端谎称自己是别人
    const res = await fetch(u2 + '/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '伪造身份的写入', scene: 'chat', identity: 'qq:ATTACKER' }),
    })
    const body = await res.json()
    assert.equal(res.status, 200)
    assert.equal(body.ok, true)
    // 关键断言：真正落库的 identity 是服务端的，不是客户端传的
    assert.equal(w.length, 1, '应恰好写入一条')
    assert.equal(w[0].identity, 'qq:OWNER',
      `必须按服务端 identity 写入，实际写到 ${w[0].identity}（客户端伪造成功 = 隔离失效）`)
    assert.equal(body.identity, 'qq:OWNER', '响应应回显权威 identity')
    assert.equal(body.ignoredIdentity, 'qq:ATTACKER', '应明确告知客户端 identity 被忽略')

    // 检索同样强制服务端 identity
    const sres = await fetch(u2 + '/memory/search?q=测试&limit=5')
    const sbody = await sres.json()
    assert.equal(sres.status, 200)
    assert.equal(sbody.ok, true)
    assert.equal(s.length, 1, '检索应恰好调用一次 searchMemories')
    assert.equal(s[0], 'qq:OWNER',
      `检索必须带上服务端 identity，实际 ${s[0]}（不带 = 会串到他人记忆）`)
  } finally {
    await svc2.stop()
  }
})

test('t13: 默认（未配置 memoriesIdentity）行为不变 —— 单用户场景仍能检索到既有记忆', async () => {
  const w = []
  const s = []
  const svc3 = createMemoryService(
    {
      store: {
        async addMemory({ text, identity }) { w.push({ text, identity }); return 'x' },
        async searchMemories(v, { identity } = {}) { s.push(identity); return [{ id: 'm', text: '既有记忆', identity: 'user' }] },
        async listAllEntities() { return [] },
        async listAllRelations() { return [] },
      },
      model: fakeModel, graph: fakeGraph, profilePath: '', logger: { warn() {}, info() {} },
    },
    { memoryServicePort: 8800 }, // 刻意不配 memoriesIdentity
  )
  const u3 = await svc3.start()
  try {
    await fetch(u3 + '/memory', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '单用户写入' }),
    })
    assert.equal(w[0].identity, 'user', '未配置时应回落 user，与 store.addMemory 默认一致')
    const r = await fetch(u3 + '/memory/search?q=x')
    const j = await r.json()
    assert.equal(s[0], 'user', '未配置时检索 identity 应回落 user（既有库存无需迁移）')
    assert.equal(j.ok, true)
    assert.equal(j.results.length, 1, '单用户场景必须仍能检索到记忆（行为不变）')
  } finally {
    await svc3.stop()
  }
})
