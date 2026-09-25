// dsh-tingxue src/memory/store.mjs
// LanceDB 记忆存储：本地文件即库，零服务器。
// 四张表：
//   memories  —— 记忆条目（向量检索主表）：text + embedding + metadata(场景/身份/时间/来源)
//   entities  —— 实体节点：name + type + summary + embedding
//   relations —— 关系边（三元组）：source → target + relation + 时间窗口
//   latest    —— 最新信息（最近文件摘要/待办，有界）
//
// 同库单一向量模型、维度一致（铁律）。换模型需全量重嵌入。
// 基于 @lancedb/lancedb 0.37 API：query().nearestTo().where().limit().toArray()

import * as lancedb from '@lancedb/lancedb'
import { Field, FixedSizeList, Float32, Utf8, Int64, Schema } from 'apache-arrow'
import { randomUUID } from 'node:crypto'

/**
 * 创建 LanceDB 记忆存储。
 * @param {object} config - { dataDir, dimensions, embeddingModel }
 * @param {object} deps - { logger }
 */
export async function createMemoryStore(config, deps = {}) {
  const logger = deps.logger
  const warn = (m) => { try { logger?.warn?.('[dsh-tingxue/memory]', m) } catch {} }
  const dataDir = config.dataDir
  const dimensions = config.dimensions

  if (!dataDir) throw new Error('dsh-tingxue: dataDir 未配置')
  if (!dimensions) throw new Error('dsh-tingxue: dimensions 未配置（需先确定向量模型维度）')

  const db = await lancedb.connect(dataDir)

  /** 建表（不存在则建）。 */
  async function ensureTable(name, fields) {
    try {
      const exists = await db.tableNames()
      if (exists.includes(name)) return await db.openTable(name)
    } catch { /* 首次建表 */ }
    return await db.createEmptyTable(name, new Schema(fields))
  }

  const vecField = (name, nullable = true) =>
    new Field(name, new FixedSizeList(dimensions, new Field('item', new Float32())), nullable)

  // ---- 表结构 ----
  const memories = await ensureTable('memories', [
    new Field('id', new Utf8(), false),
    new Field('text', new Utf8(), true),
    vecField('vector', false),
    new Field('scene', new Utf8(), true),
    new Field('identity', new Utf8(), true),
    new Field('source', new Utf8(), true),
    new Field('createdAt', new Int64(), true),
    new Field('entityIds', new Utf8(), true), // 逗号分隔的实体 id 列表（避免 list 类型序列化问题）
  ])

  const entities = await ensureTable('entities', [
    new Field('id', new Utf8(), false),
    new Field('name', new Utf8(), true),
    new Field('type', new Utf8(), true),
    new Field('summary', new Utf8(), true),
    vecField('vector', true),
    new Field('createdAt', new Int64(), true),
  ])

  const relations = await ensureTable('relations', [
    new Field('id', new Utf8(), false),
    new Field('sourceId', new Utf8(), true),
    new Field('targetId', new Utf8(), true),
    new Field('relation', new Utf8(), true),
    new Field('validFrom', new Int64(), true),
    new Field('validTo', new Int64(), true),
    new Field('source', new Utf8(), true),
  ])

  const latest = await ensureTable('latest', [
    new Field('id', new Utf8(), false),
    new Field('kind', new Utf8(), true),
    new Field('text', new Utf8(), true),
    new Field('createdAt', new Int64(), true),
  ])

  // ---- 行规整（BigInt → Number）----
  //
  // LanceDB 的 INT64 列读出来是 **BigInt**，而 `JSON.stringify(BigInt)` 抛
  // `TypeError: Do not know how to serialize a BigInt`。任何裸返回原始行的函数
  // 一旦被放进 HTTP 响应，就会让 `sendJson` 在已 `writeHead(200)` 之后失败、
  // `res.end()` 永不执行 → 客户端永久挂住（实测 /memory/expand 180s 不返回）。
  // 因此所有对外返回的实体/关系/最新信息都必须过这里。
  const normalizeEntity = (row) => row === undefined || row === null ? null : ({
    id: row.id, name: row.name, type: row.type, summary: row.summary,
    createdAt: Number(row.createdAt ?? 0),
  })

  // ---- 记忆条目 ----
  async function addMemory({ text, vector, scene = 'chat', identity = 'user', source = 'chat', entityIds = [] }) {
    const id = randomUUID()
    await memories.add([{
      id, text, vector,
      scene, identity, source,
      createdAt: Date.now(),
      entityIds: (entityIds ?? []).join(','),
    }])
    return id
  }

  /** 语义检索记忆（按当前输入）。 */
  async function searchMemories(vector, { limit = 8, scene } = {}) {
    let q = memories.query().nearestTo(vector).limit(limit)
    if (scene) q = q.where(`scene = '${scene}'`)
    const rows = await q.toArray()
    return rows.map((r) => ({
      id: r.id, text: r.text, scene: r.scene, identity: r.identity,
      source: r.source, createdAt: Number(r.createdAt ?? 0),
      entityIds: String(r.entityIds ?? '').split(',').filter(Boolean),
      distance: r._distance,
    }))
  }

  /** 按精确 ID 删除记忆（用户主动删除）。 */
  async function deleteMemory(id) {
    await memories.delete(`id = '${id}'`)
  }

  // ---- 实体 ----
  async function upsertEntity({ id, name, type, summary, vector }) {
    const existing = await entities.query().where(`id = '${id}'`).toArray()
    if (existing.length > 0) {
      await entities.update({
        where: `id = '${id}'`,
        values: { name, type, summary, vector, createdAt: Date.now() },
      })
      return id
    }
    await entities.add([{ id, name, type, summary, vector, createdAt: Date.now() }])
    return id
  }

  /**
   * 按 id 取实体。
   * **必须规整 Int64 字段**：LanceDB 的 `createdAt` 读出来是 BigInt，
   * `JSON.stringify(BigInt)` 会抛 TypeError（详见 relationsOf 的注释）。
   */
  async function getEntity(id) {
    const rows = await entities.query().where(`id = '${id}'`).toArray()
    return normalizeEntity(rows[0])
  }

  /** 按名称精确查实体（实体链接用）。 */
  async function findEntityByName(name) {
    const rows = await entities.query().where(`name = '${name}'`).toArray()
    return normalizeEntity(rows[0])
  }

  /**
   * 语义检索实体（实体链接候选）。
   * distance 是 LanceDB 的 `_distance`（f32，本来就不是 Int64），但显式转 Number
   * 与其它函数保持一致：任何裸透传的字段将来都可能变成 BigInt 类隐患。
   */
  async function searchEntities(vector, { limit = 5 } = {}) {
    const rows = await entities.query().nearestTo(vector).limit(limit).toArray()
    return rows.map((r) => ({
      id: r.id, name: r.name, type: r.type, summary: r.summary,
      distance: Number(r._distance ?? 0),
    }))
  }

  /** 列出全部实体（图谱 UI 用）。 */
  async function listAllEntities({ limit = 500 } = {}) {
    const rows = await entities.query().limit(limit).toArray()
    return rows.map((r) => ({
      id: r.id, name: r.name, type: r.type, summary: r.summary,
      createdAt: Number(r.createdAt ?? 0),
    }))
  }

  /** 列出全部关系（图谱 UI 用）。 */
  async function listAllRelations({ limit = 2000 } = {}) {
    const rows = await relations.query().limit(limit).toArray()
    return rows.map((r) => ({
      id: r.id, sourceId: r.sourceId, targetId: r.targetId,
      relation: r.relation, validFrom: Number(r.validFrom ?? 0),
      validTo: Number(r.validTo ?? 0), source: r.source,
    }))
  }

  // ---- 关系 ----
  async function addRelation({ sourceId, targetId, relation, source = 'chat' }) {
    const id = randomUUID()
    await relations.add([{
      id, sourceId, targetId, relation,
      validFrom: Date.now(), validTo: 0, source,
    }])
    return id
  }

  /**
   * 查询某实体的所有关系（图遍历）。
   *
   * **必须把 BigInt 转成 Number**：LanceDB 的 INT64 列读出来是 BigInt，
   * 而 `JSON.stringify(BigInt)` 会抛 `TypeError: Do not know how to serialize a BigInt`。
   * 调用链 `/memory/expand` → `sendJson` 一旦遇到它就会「已 writeHead 200、res.end 从未执行」，
   * 在 `sendJson` 的 catch 里被静默吞掉，客户端**永久挂住**（实测 180s 不返回）。
   * `listAllRelations` 一直有 `Number()` 转换，本函数漏了——这是两条路径唯一的差别。
   */
  async function relationsOf(entityId) {
    const rows = await relations.query()
      .where(`(sourceId = '${entityId}' OR targetId = '${entityId}') AND validTo = 0`)
      .toArray()
    return rows.map((r) => ({
      id: r.id, sourceId: r.sourceId, targetId: r.targetId,
      relation: r.relation, validFrom: Number(r.validFrom ?? 0),
      validTo: Number(r.validTo ?? 0), source: r.source,
    }))
  }

  // ---- 最新信息 ----
  async function addLatest({ kind, text }) {
    const id = randomUUID()
    await latest.add([{ id, kind, text, createdAt: Date.now() }])
    return id
  }

  /** 取最新信息（有界，按时间倒序）。 */
  async function listLatest({ limit = 5 } = {}) {
    const rows = await latest.query().toArray()
    // createdAt 是 Int64 → BigInt，必须转 Number 才能 JSON 序列化。
    return rows
      .map((r) => ({ id: r.id, kind: r.kind, text: r.text, createdAt: Number(r.createdAt ?? 0) }))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
  }

  return {
    db,
    addMemory, searchMemories, deleteMemory,
    upsertEntity, getEntity, findEntityByName, searchEntities, listAllEntities,
    addRelation, relationsOf, listAllRelations,
    addLatest, listLatest,
    async close() { await db.close() },
  }
}
