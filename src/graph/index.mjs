// dsh-tingxue src/graph/index.mjs
// 自建实体关系图谱（参考 Graphiti / Mem0 优秀实践）：
//   - 实体抽取：小 LLM 从文本抽取实体（person/place/thing/concept）
//   - 实体链接：实体名归一化 + 向量相似，把新实体关联到已有实体
//   - 关系建立：抽取实体间三元组关系（source → relation → target），带时间窗口与溯源
//   - 图遍历：从种子实体沿关系扩展，得到关联记忆
//
// 设计要点（学自 Graphiti）：
//   - 实体是轻量索引与扩展点，不是事实的替代
//   - 关系带 validFrom/validTo 时间窗口，支持"现在 vs 过去"
//   - 每条关系溯源到原始记忆（episode）
// 设计要点（学自 Mem0）：
//   - 实体链接：跨记忆把同一实体关联起来，提升检索
//   - 多信号：语义 + 实体匹配融合

import { randomUUID } from 'node:crypto'

/**
 * 创建关系图谱服务。
 * @param {object} store - LanceDB 记忆存储
 * @param {object} model - 模型适配器（embed + complete）
 * @param {object} deps - { logger }
 */
export function createGraphService(store, model, deps = {}) {
  const logger = deps.logger
  const warn = (m) => { try { logger?.warn?.('[dsh-tingxue/graph]', m) } catch {} }

  /** 归一化实体名（实体链接用）：去空白、统一大小写。 */
  function normalizeName(name) {
    return String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
  }

  /**
   * 用 LLM 从文本抽取实体与关系。
   * 返回 { entities: [{name,type}], relations: [{source,target,relation}] }
   */
  async function extractEntitiesAndRelations(text) {
    const prompt = [
      '从以下对话/文本中抽取实体与实体间关系。',
      '实体类型：person（人）/ place（地点）/ thing（事物）/ concept（概念）。',
      '关系用三元组：source → relation → target。',
      '只输出 JSON，不要多余文字。格式：',
      '{"entities":[{"name":"...","type":"person"}],"relations":[{"source":"...","target":"...","relation":"..."}]}',
      '',
      '文本：',
      text,
    ].join('\n')

    const raw = await model.complete(prompt, { temperature: 0.1, maxTokens: 1024 })
    return parseGraphJson(raw)
  }

  /** 解析 LLM 输出的 JSON（容忍 markdown 代码块包裹）。 */
  function parseGraphJson(raw) {
    try {
      let s = String(raw ?? '').trim()
      // 去掉 ```json ... ``` 包裹
      const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
      if (fence) s = fence[1].trim()
      const obj = JSON.parse(s)
      return {
        entities: Array.isArray(obj.entities) ? obj.entities : [],
        relations: Array.isArray(obj.relations) ? obj.relations : [],
      }
    } catch (e) {
      warn(`图谱 JSON 解析失败: ${e.message}`)
      return { entities: [], relations: [] }
    }
  }

  /**
   * 把抽取的实体写入图谱（含实体链接）。
   * 返回 { entityIds: string[], newEntities: number }
   */
  async function ingestEntities(entities, { source = 'chat' } = {}) {
    const entityIds = []
    let newEntities = 0
    for (const ent of entities) {
      const name = String(ent.name ?? '').trim()
      if (!name) continue
      const type = String(ent.type ?? 'concept').trim() || 'concept'
      const norm = normalizeName(name)

      // 实体链接：先精确查，再语义检索候选
      let existing = await store.findEntityByName(norm)
      if (!existing) {
        const vec = await model.embed([name])
        const candidates = await store.searchEntities(vec[0], { limit: 3 })
        // 相似度阈值内视为同一实体
        const match = candidates.find((c) => c.distance < 0.6)
        if (match) existing = await store.getEntity(match.id)
      }

      if (existing) {
        entityIds.push(existing.id)
      } else {
        const id = randomUUID()
        const vec = await model.embed([name])
        await store.upsertEntity({ id, name: norm, type, summary: name, vector: vec[0] })
        entityIds.push(id)
        newEntities++
      }
    }
    return { entityIds, newEntities }
  }

  /**
   * 把抽取的关系写入图谱（实体名 → 实体 id 解析）。
   */
  async function ingestRelations(relations, entityIds, { source = 'chat' } = {}) {
    // 建立 name → id 映射
    const nameToId = new Map()
    for (const ent of relations) {
      if (ent.source) nameToId.set(normalizeName(ent.source), true)
      if (ent.target) nameToId.set(normalizeName(ent.target), true)
    }
    // 需要从 store 反查实体 id（ingestEntities 已写入）
    const idByName = new Map()
    for (const name of nameToId.keys()) {
      const ent = await store.findEntityByName(name)
      if (ent) idByName.set(name, ent.id)
    }
    for (const rel of relations) {
      const s = normalizeName(rel.source)
      const t = normalizeName(rel.target)
      const r = String(rel.relation ?? '').trim()
      if (!s || !t || !r) continue
      const sid = idByName.get(s)
      const tid = idByName.get(t)
      if (!sid || !tid) continue
      await store.addRelation({ sourceId: sid, targetId: tid, relation: r, source })
    }
  }

  /**
   * 从文本提取实体与关系并写入图谱（完整流程）。
   * 返回 { entityIds, newEntities, relationsAdded }
   */
  async function ingest(text, { source = 'chat' } = {}) {
    const { entities, relations } = await extractEntitiesAndRelations(text)
    const { entityIds, newEntities } = await ingestEntities(entities, { source })
    await ingestRelations(relations, entityIds, { source })
    return { entityIds, newEntities, relationsAdded: relations.length }
  }

  /**
   * 图遍历：从种子实体沿关系扩展，返回关联实体与关系。
   * 用于记忆检索的"关系增强"。
   */
  async function expandFromEntities(entityIds, { depth = 1, limit = 10 } = {}) {
    const visited = new Set(entityIds)
    const frontier = [...entityIds]
    const foundRelations = []
    for (let d = 0; d < depth && frontier.length > 0; d++) {
      const next = []
      for (const id of frontier) {
        const rels = await store.relationsOf(id)
        for (const rel of rels) {
          foundRelations.push(rel)
          const other = rel.sourceId === id ? rel.targetId : rel.sourceId
          if (!visited.has(other)) {
            visited.add(other)
            next.push(other)
          }
        }
      }
      frontier.length = 0
      frontier.push(...next)
    }
    // 取关联实体详情
    const relatedEntities = []
    for (const id of visited) {
      if (entityIds.includes(id)) continue
      const ent = await store.getEntity(id)
      if (ent) relatedEntities.push(ent)
    }
    return { relatedEntities: relatedEntities.slice(0, limit), relations: foundRelations }
  }

  return {
    extractEntitiesAndRelations,
    ingest,
    ingestEntities,
    ingestRelations,
    expandFromEntities,
    normalizeName,
  }
}
