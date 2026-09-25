// dsh-tingxue src/http/index.mjs
// 共享 HTTP 工具：本地端口探测 + 统一 JSON 读写响应。
// 抽取自 graph-dashboard / memory-service 两份重复实现，消除重复（交接文档 B1）。
//
// 注意：本模块不引入任何第三方依赖，纯 node:http 工具。

import { createServer } from 'node:http'

/**
 * 探测一个本地可用端口（从 start 起最多试 50 个）。
 * @param {number} start - 起始端口
 * @param {string} host - 监听地址（默认 loopback）
 * @returns {Promise<number|null>} 可用端口，找不到返回 null
 */
export async function findPort(start, host = '127.0.0.1') {
  for (let p = start; p < start + 50; p++) {
    const ok = await new Promise((resolve) => {
      const srv = createServer()
      srv.once('error', () => resolve(false))
      srv.once('listening', () => srv.close(() => resolve(true)))
      srv.listen(p, host)
    })
    if (ok) return p
  }
  return null
}

/**
 * 读取请求体（纯文本；JSON 由调用方自行 parse）。
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit] - 字节上限，默认 1MB
 * @returns {Promise<string>}
 */
export function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > limit) { reject(new Error('body too large')); req.destroy() }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/**
 * 统一 JSON 响应。
 * 若响应已结束（如已 sendJson 过或客户端断开），静默跳过，避免重复写头/写流异常。
 *
 * **序列化必须先做，再写头**：原实现在 `writeHead()` 之后才 `JSON.stringify()`，
 * 一旦序列化抛错（实测过 LanceDB 的 BigInt 行 → `TypeError: Do not know how to
 * serialize a BigInt`），头已经发出去了、`res.end()` 却永远不执行，客户端**永久挂住**；
 * 而 catch 把错误吞了，服务端日志上什么都没有。现在把序列化提到写头之前，
 * 失败就回 500（且把原因带上），保证「要么是完整响应、要么是明确的错误响应」。
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {object} obj
 */
export function sendJson(res, status, obj) {
  if (!res || res.writableEnded || res.destroyed) return false
  let body
  try {
    body = JSON.stringify(obj)
  } catch (e) {
    // 序列化失败：此时**还没写头**，可以安全地改成 500 明确报错。
    const reason = e instanceof Error ? e.message : String(e)
    try {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ ok: false, error: `响应序列化失败: ${reason}` }))
    } catch { /* 响应已异常关闭：忽略 */ }
    return false
  }
  try {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(body)
    return true
  } catch {
    // 响应已异常关闭（客户端断开）等，忽略
    return false
  }
}
