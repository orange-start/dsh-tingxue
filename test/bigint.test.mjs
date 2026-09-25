// dsh-tingxue test/bigint.test.mjs
//
// 回归：**LanceDB 的 Int64 列读出来是 BigInt，裸返回会让 HTTP 响应永久挂住**。
//
// 真机 bug（2026-09-25 实测）：
//   GET /memory/expand?entityId=<有关系>&depth=1  →  180 秒不返回（不是慢，是挂死）
//   同一实体 depth=0（不进循环）→ 2ms 正常返回
//   孤立实体（0 条关系）depth=1 → 55ms 正常返回
//   度数 1、2、3、5、68 的实体 → 全部超时
//   挂起期间 /health 与 /memory/relations 仍 55ms 正常（服务没死，只有这一条路径挂）
//
// 根因链：
//   store.relationsOf 裸返回 LanceDB 行 → validFrom/validTo 是 BigInt
//   → /memory/expand 把结果交给 sendJson → JSON.stringify 抛
//     TypeError: Do not know how to serialize a BigInt
//   → 原 sendJson 里 writeHead(200) 已经发出、res.end() 永不执行
//   → catch {} 静默吞掉，客户端永久挂住，服务端日志上什么都没有
//
// 两条路径唯一的差别：listAllRelations 做了 `Number(r.validFrom)`，
// 而 relationsOf / getEntity / findEntityByName / listLatest 漏了。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// ── 1. 静态断言：所有对外返回原始行的函数必须做 BigInt → Number 规整 ──
// 这类 bug 不会自己报错（被 catch 吞了），只能靠「代码里不许裸 return rows」守住。

test('store.mjs 不得裸返回 LanceDB 原始行（BigInt 会被序列化时炸掉响应）', () => {
  const src = readFileSync(join(here, '..', 'src', 'memory', 'store.mjs'), 'utf8')
  const lines = src.split('\n')

  // 裸返回 = `return rows` 之后紧接的就是语句结束（`;` 或换行后不是 `.`）
  // 允许 `return rows.map(...)` / `return rows\n  .map(...)`（那就是规整过了）。
  const offenders = []
  lines.forEach((l, i) => {
    const t = l.trim()
    if (!/^return rows(;)?$/.test(t) && !/^return rows\[0\](\s*\?\?\s*null)?;?$/.test(t)) return
    // 看下一行是否延续链式调用（`.map(...)` 等）
    const next = (lines[i + 1] ?? '').trim()
    if (next.startsWith('.')) return  // 链式规整，安全
    offenders.push(`第 ${i + 1} 行: ${t}`)
  })
  assert.deepEqual(
    offenders, [],
    `store.mjs 里仍有裸返回原始行（BigInt 会在 JSON.stringify 时抛错 → 响应挂死）:\n  ${offenders.join('\n  ')}`,
  )
})

test('relationsOf / getEntity / findEntityByName / listLatest 都做了 Number() 规整', () => {
  const src = readFileSync(join(here, '..', 'src', 'memory', 'store.mjs'), 'utf8')
  for (const fn of ['relationsOf', 'getEntity', 'findEntityByName', 'listLatest']) {
    // 抓函数体（到下一个 async function 或 return { 为止）
    const re = new RegExp(`async function ${fn}\\(([\\s\\S]*?)\\n  \\}`)
    const m = src.match(re)
    assert.ok(m, `找不到函数 ${fn}`)
    assert.ok(
      /Number\(/.test(m[1]) || /normalizeEntity\(/.test(m[1]),
      `${fn} 没有把 Int64 字段转成 Number（BigInt 会导致响应挂死）`,
    )
  }
})

test('searchEntities 也显式转 Number（不再裸透传 _distance）', () => {
  const src = readFileSync(join(here, '..', 'src', 'memory', 'store.mjs'), 'utf8')
  const m = src.match(/async function searchEntities\(([\s\S]*?)\n  \}/)
  assert.ok(m, '找不到 searchEntities')
  assert.ok(/Number\(r\._distance/.test(m[1]), 'searchEntities 的 distance 未做 Number 转换')
  assert.ok(!/distance:\s*r\._distance/.test(m[1]), 'searchEntities 仍在裸透传 _distance')
})

// ── 1b. 真机 HTTP 契约：/memory/expand 不得再挂死 ──
// 这条直接打运行中的服务。修好后实测 1161ms（depth=1）/ 3605ms（depth=2）；
// 修复前是 180 秒超时。没有服务在跑时跳过（CI / 离线环境友好）。

test('真机：/memory/expand 必须正常返回（修复前是永久挂死）', async (t) => {
  const BASE = 'http://127.0.0.1:8766'
  const call = async (url, ms) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(ms) })
      return { status: r.status, body: await r.text() }
    } catch { return null }
  }

  const health = await call(`${BASE}/health`, 3000)
  if (health === null) { t.skip('记忆服务未在运行：跳过真机契约测试'); return }

  const ents = await call(`${BASE}/memory/entities`, 15000)
  assert.ok(ents?.status === 200, `/memory/entities 应 200，实际 ${ents?.status}`)
  const list = JSON.parse(ents.body).entities ?? []
  assert.ok(list.length > 0, '实体列表为空，无法测试 expand')

  // 取一个**有关系**的实体——正是修复前会挂死的形态（度数 ≥ 1）
  const rels = await call(`${BASE}/memory/relations`, 15000)
  const connected = new Set()
  for (const r of (JSON.parse(rels.body).relations ?? [])) { connected.add(r.sourceId); connected.add(r.targetId) }
  const seed = list.find((e) => connected.has(e.id))
  assert.ok(seed, '找不到有关联的实体')

  const r1 = await call(`${BASE}/memory/expand?entityId=${seed.id}&depth=1`, 25000)
  assert.ok(r1 !== null, '/memory/expand depth=1 超时——BigInt 挂死回归了！')
  assert.equal(r1.status, 200)
  const j1 = JSON.parse(r1.body)
  assert.ok(Array.isArray(j1.relations) && j1.relations.length > 0, '应返回关系')
  // 返回的行必须干净（这正是挂死的根源）
  for (const rel of j1.relations) {
    for (const [k, v] of Object.entries(rel)) {
      assert.notEqual(typeof v, 'bigint', `relations[].${k} 仍是 BigInt —— 会被 JSON.stringify 炸掉`)
    }
  }
})

test('真机：序列化失败必须回 500，不得让客户端挂住', async (t) => {
  // 这条用假 res 单测（真机无法构造序列化失败），见下方 sendJson 测试。
  // 这里只断言运行中的服务对「不存在的实体」快速返回，证明响应链路没卡。
  const BASE = 'http://127.0.0.1:8766'
  const r = await (async () => {
    try {
      const res = await fetch(`${BASE}/memory/expand?entityId=nope-xxx&depth=1`, { signal: AbortSignal.timeout(8000) })
      return { status: res.status, body: await res.text() }
    } catch { return null }
  })()
  if (r === null) { t.skip('记忆服务未在运行：跳过'); return }
  assert.equal(r.status, 200)
  assert.deepEqual(JSON.parse(r.body), { ok: true, relatedEntities: [], relations: [] })
})

// ── 2. 行为断言：BigInt 真的会被 JSON.stringify 拒绝（证明这个 bug 是真的）──

test('BigInt 确实无法 JSON 序列化 —— 这个 bug 的物理基础', () => {
  assert.throws(
    () => JSON.stringify({ validFrom: 1788094122650n }),
    /Do not know how to serialize a BigInt/,
    '若这条不抛了，说明运行时变了，前面的判据需要重新审视',
  )
  // 转换之后就正常了
  assert.equal(JSON.stringify({ validFrom: Number(1788094122650n) }), '{"validFrom":1788094122650}')
})

// ── 3. 行为断言：sendJson 序列化失败时必须给出明确的 500，而不是挂住 ──

test('sendJson 序列化失败 → 立刻回 500（不再 writeHead 后挂死）', async () => {
  const { sendJson } = await import('../src/http/index.mjs')

  // 最小 res 替身：记录 writeHead/end 调用顺序
  const calls = []
  const res = {
    writableEnded: false,
    destroyed: false,
    writeHead(status) { calls.push(['writeHead', status]); this._status = status },
    end(body) { calls.push(['end', body]); this.writableEnded = true },
  }

  const ok = sendJson(res, 200, { bad: 1n })

  assert.equal(ok, false, '带 BigInt 的响应必须报告失败')
  assert.equal(res.writableEnded, true, '**必须调用过 end**，否则客户端永久挂住')

  const kinds = calls.map(c => c[0])
  assert.deepEqual(kinds, ['writeHead', 'end'], `应为 writeHead→end，实际 ${kinds.join('→')}`)
  assert.equal(calls[0][1], 500, '序列化失败应回 500，而不是先发 200')
  assert.match(String(calls[1][1]), /序列化失败/, '错误响应里应带明确原因')
})

test('sendJson 正常路径不受影响', async () => {
  const { sendJson } = await import('../src/http/index.mjs')
  const calls = []
  const res = {
    writableEnded: false, destroyed: false,
    writeHead(s) { calls.push(['writeHead', s]) },
    end(b) { calls.push(['end', b]); this.writableEnded = true },
  }
  assert.equal(sendJson(res, 200, { ok: true }), true)
  assert.deepEqual(calls, [['writeHead', 200], ['end', '{"ok":true}']])
})

test('sendJson 对已结束/已销毁的响应静默跳过（保持原行为）', async () => {
  const { sendJson } = await import('../src/http/index.mjs')
  assert.equal(sendJson({ writableEnded: true, destroyed: false, writeHead() {}, end() {} }, 200, {}), false)
  assert.equal(sendJson({ writableEnded: false, destroyed: true, writeHead() {}, end() {} }, 200, {}), false)
  assert.equal(sendJson(null, 200, {}), false)
})

// ── 4. 静态断言：sendJson 里序列化必须在 writeHead 之前 ──

test('sendJson 必须先序列化再 writeHead（顺序错了就会挂死）', () => {
  const src = readFileSync(join(here, '..', 'src', 'http', 'index.mjs'), 'utf8')
  const body = src.slice(src.indexOf('export function sendJson'))
  const iStringify = body.indexOf('JSON.stringify(obj)')
  const iWriteHead = body.indexOf('res.writeHead(status')
  assert.ok(iStringify !== -1, '找不到 JSON.stringify(obj)')
  assert.ok(iWriteHead !== -1, '找不到 res.writeHead(status')
  assert.ok(
    iStringify < iWriteHead,
    'JSON.stringify 必须在 writeHead 之前 —— 否则序列化抛错时头已发出、end 永不执行，客户端挂死',
  )
})
