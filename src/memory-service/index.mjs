// dsh-tingxue src/memory-service/index.mjs
// 记忆服务（管家）：DSH 唯一写者，暴露 HTTP REST API 供 AstrBot 读写记忆库。
//  - 人脑仿生记忆：写记忆时自动抽实体/关系（人物节点 + 关系边 + 记忆挂人物）。
//  - 写队列：所有写操作串行化，一次只写一条，规避 LanceDB 单写者并发冲突。
//  - 读操作不排队，可并行（LanceDB 读安全）。
//  - 仅监听 loopback（127.0.0.1），本机访问，不暴露公网。
//
// 端点：
//   POST /memory           写一条记忆（含实体抽取）
//   GET  /memory/search    语义检索记忆
//   GET  /memory/entities  全部实体（人物/地点/事物/概念）
//   GET  /memory/relations 全部关系边
//   GET  /memory/expand    从人物沿关系扩展（人脑检索）
//   GET  /profile          返回人格文本

import { createServer } from 'node:http'
import { findPort, readBody, sendJson } from '../http/index.mjs'

/**
 * 创建记忆服务。
 * @param {object} deps - { store, model, graph, profilePath, logger }
 * @param {object} config - { memoryServiceHost, memoryServicePort, memoriesIdentity }
 */
export function createMemoryService(deps = {}, config = {}) {
  const { store, model, graph, profilePath, logger } = deps
  const warn = (m) => { try { logger?.warn?.('[dsh-tingxue/memory-service]', m) } catch {} }
  const info = (m) => { try { logger?.info?.('[dsh-tingxue/memory-service]', m) } catch {} }

  const host = config.memoryServiceHost ?? '127.0.0.1'
  const port = config.memoryServicePort ?? 8766
  /**
   * 本记忆服务的**权威身份**（t13）：写入与检索都用它，**不读客户端传的 identity**。
   *
   * 为什么必须是服务端权威：若 identity 由请求体决定，客户端改一个字段就能把记忆写进
   * 别人名下、或把别人的记忆检索出来——那样「加了 identity 过滤」也等于没有隔离。
   *
   * 默认 `'user'`：与 `store.addMemory` 的默认 identity 一致，**单用户场景行为不变**，
   * 且既有（无 identity 写入的）库存仍可被检索到，无需数据迁移。
   * 多来源部署时在 profile 配置里把它设成该来源的稳定标识（例如 `qq:<userId>`）。
   */
  const serverIdentity = String(config.memoriesIdentity ?? '').trim() || 'user'

  let server = null
  let boundUrl = ''

  // ---- 写队列：所有写操作串行化 ----
  let writeChain = Promise.resolve()
  function enqueueWrite(fn) {
    const run = writeChain.then(fn)
    writeChain = run.catch(() => {})   // 一个失败不卡死队列
    return run
  }

  // ---- 读人格 ----
  async function readProfile() {
    if (!profilePath) return ''
    try {
      const { readFile } = await import('node:fs/promises')
      return await readFile(profilePath, 'utf-8')
    } catch (e) {
      warn(`读取人格失败: ${e.message}`)
      return ''
    }
  }

  // ---- 路由处理 ----
  async function handle(req, res) {
    const url = (req.url || '/').split('?')[0]
    const method = req.method || 'GET'

    // POST /memory — 写一条记忆（含实体抽取）
    if (method === 'POST' && url === '/memory') {
      let body
      try {
        body = JSON.parse((await readBody(req)) || '{}')
      } catch (e) {
        // 非法 JSON：客户端错误，返回 400 而不是 500
        return sendJson(res, 400, { ok: false, error: 'body 不是合法 JSON' })
      }
      const text = String((body && body.text) ?? '').trim()
      if (!text) return sendJson(res, 400, { ok: false, error: 'text 必填' })
      const scene = String((body && body.scene) ?? 'chat').trim() || 'chat'
      // **identity 由服务端决定，不接受客户端伪造**（t13 修复）。
      // 旧实现取 body.identity：客户端换个字段就能把记忆写进别人的名下，
      // 于是「加了 identity 过滤」也等于没有隔离——钥匙插在门上。
      // 客户端若仍传 identity，仅在响应里回显为 ignoredIdentity 以便排查，不参与写入。
      const clientIdentity = String((body && body.identity) ?? '').trim()
      const identity = serverIdentity
      const source = String((body && body.source) ?? 'astrbot').trim() || 'astrbot'
      try {
        // 记忆正文 + 向量尽快落库并立刻返回：实体抽取是慢模型调用，
        // 若同步做会在响应路径里卡住 AstrBot 的 15s 超时（客户端误报失败、
        // 重试写出重复记忆）。这里只同步写库，图谱抽取挪到响应之后后台做。
        const memoryId = await enqueueWrite(async () => {
          if (!store || !model) throw new Error('记忆服务未就绪')
          const vec = await model.embed([text])
          return store.addMemory({ text, vector: vec[0], scene, identity, source })
        })
        // 先回 200，再异步抽取实体/关系（失败只记日志，不再让客户端等）。
        // 放 writeChain 之后跑，避免和后续写操作并发争用 LanceDB。
        enqueueWrite(async () => {
          if (!graph) return
          try {
            await graph.ingest(text, { source })
          } catch (e) { warn(`实体抽取失败: ${e.message}`) }
        }).catch(() => {})
        const payload = { ok: true, memoryId, entityIds: [], newEntities: 0, async: true, identity }
        if (clientIdentity && clientIdentity !== identity) {
          payload.ignoredIdentity = clientIdentity
          warn(`客户端传入的 identity=${clientIdentity} 已被忽略，按服务端 identity=${identity} 写入`)
        }
        return sendJson(res, 200, payload)
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message })
      }
    }

    // GET /memory/search — 语义检索记忆
    if (method === 'GET' && url === '/memory/search') {
      const q = new URL(req.url, 'http://x').searchParams.get('q') ?? ''
      const limit = Number(new URL(req.url, 'http://x').searchParams.get('limit') ?? 8)
      const scene = new URL(req.url, 'http://x').searchParams.get('scene') ?? undefined
      if (!q.trim()) return sendJson(res, 400, { ok: false, error: 'q 必填' })
      try {
        if (!store || !model) throw new Error('记忆服务未就绪')
        const vec = await model.embed([q])
        // 同样强制服务端 identity：检索永远只在本来源自己的记忆里做（不跨来源串味）。
        const results = await store.searchMemories(vec[0], { limit, scene, identity: serverIdentity })
        return sendJson(res, 200, { ok: true, results, identity: serverIdentity })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message })
      }
    }

    // GET /memory/entities — 全部实体
    if (method === 'GET' && url === '/memory/entities') {
      try {
        if (!store) throw new Error('记忆服务未就绪')
        const entities = await store.listAllEntities?.({ limit: 1500 }) ?? []
        return sendJson(res, 200, { ok: true, entities })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message })
      }
    }

    // GET /memory/relations — 全部关系边
    if (method === 'GET' && url === '/memory/relations') {
      try {
        if (!store) throw new Error('记忆服务未就绪')
        const relations = await store.listAllRelations?.({ limit: 6000 }) ?? []
        return sendJson(res, 200, { ok: true, relations })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message })
      }
    }

    // GET /memory/expand — 从人物沿关系扩展
    if (method === 'GET' && url === '/memory/expand') {
      const entityId = new URL(req.url, 'http://x').searchParams.get('entityId') ?? ''
      const depth = Number(new URL(req.url, 'http://x').searchParams.get('depth') ?? 1)
      if (!entityId) return sendJson(res, 400, { ok: false, error: 'entityId 必填' })
      try {
        if (!graph) throw new Error('图谱服务未就绪')
        const result = await graph.expandFromEntities([entityId], { depth })
        return sendJson(res, 200, { ok: true, ...result })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message })
      }
    }

    // GET /profile — 返回人格文本
    if (method === 'GET' && url === '/profile') {
      try {
        const profile = await readProfile()
        return sendJson(res, 200, { ok: true, profile })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message })
      }
    }

    // 健康检查
    if (method === 'GET' && (url === '/' || url === '/health')) {
      return sendJson(res, 200, { ok: true, service: 'dsh-tingxue-memory', port: port })
    }

    return sendJson(res, 404, { ok: false, error: 'not found' })
  }

  /** 启动 HTTP 服务。返回启动成功的 URL 或 null。 */
  async function start() {
    if (server) return boundUrl
    const actualPort = port || (await findPort(8766, host)) || 8766
    try {
      server = createServer(async (req, res) => {
        try {
          await handle(req, res)
        } catch (e) {
          warn(`请求处理失败: ${e.message}`)
          sendJson(res, 500, { ok: false, error: e.message })
        }
      })
      server.listen(actualPort, host)
      await new Promise((resolve, reject) => {
        server.once('listening', resolve)
        server.once('error', reject)
      })
      boundUrl = `http://${host}:${actualPort}`
      info(`记忆服务已启动：${boundUrl}（DSH 唯一写者，AstrBot 通过 HTTP 对接）`)
      return boundUrl
    } catch (e) {
      warn(`记忆服务启动失败: ${e.message}`)
      server = null
      return null
    }
  }

  async function stop() {
    if (!server) return
    try { await new Promise((r) => server.close(r)) } catch {}
    server = null
  }

  return { start, stop, get url() { return boundUrl } }
}
