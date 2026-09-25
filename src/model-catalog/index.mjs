// dsh-tingxue src/model-catalog/index.mjs
// 模型目录路由：供设置页的模型选择器询问端点当前提供哪些模型。
//
// 为什么不用 DSH 的 `llm.discoverModels`：
//   那个 seam 由 `llm-pi-ai` 适配器回答，只认 `llm-pi-ai` 命名空间里声明过的
//   provider profile。听雪的模型后端是插件自己的配置（modelBackend / baseURL /
//   apiKey），与 profile 的 provider 表无关，问它只会得到「未知 provider」。
//   这里用听雪自己的适配层问同一条协议（OpenAI 兼容 `GET /v1/models`），
//   端点、协议、key 的解析方式与真正发请求时完全一致 —— 选择器看到的就是
//   实际会用的那份列表。
//
// 契约（对齐 DSH 的 discoverModels 语义）：
//   - 请求体是「表单当前显示的值」，不是已保存的路由；未保存的 key 也能试。
//   - 只读：不写任何配置。apiKey 只用于这一次询问，不存储、不回显。
//   - 未提供 key 时回落到 DSH 凭据服务里的 STA1N_API_KEY（与真实调用一致）。

import { createModelAdapter } from '../models/index.mjs'
import { readBody, sendJson } from '../http/index.mjs'

/** 端点路径。挂在一个独立前缀下，与 DSH 自己的 /api 网关互不干扰。 */
export const MODEL_CATALOG_PATH = '/dsh-tingxue/models'

/** 请求体上限：只有一个端点串和一把临时 key。 */
const MAX_BODY_BYTES = 8192

/** 本机回环来源（无 Origin 头时的兜底判据）。 */
function isLoopback(req) {
  const addr = req.socket?.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

/**
 * 同源判定。这个端点会拿着一把可能是明文的 key 去问一个端点，属于
 * 「配置面」能力（DSH 自己把 llm.discoverModels 钉在 loopback 上就是这个原因），
 * 因此不接受跨站调用。
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function sameOrigin(req) {
  const origin = req.headers.origin
  const host = req.headers.host
  if (origin === undefined) return isLoopback(req)
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * 挂载模型目录路由。
 * @param {object} ctx - 宿主上下文（需要能取得 webServer 服务）
 * @param {object} deps - { logger, warn, config }
 * @returns {(() => void)|null} 卸载函数；无法挂载时返回 null
 */
export function mountModelCatalogRoutes(ctx, deps = {}) {
  const warn = deps.warn ?? (() => {})
  const logger = deps.logger
  let disposeRoute = null

  let fiber = null
  try {
    fiber = ctx.inject(['webServer'], (hostCtx) => {
      const webServer = hostCtx.webServer
      if (!webServer || typeof webServer.register !== 'function') {
        warn('模型目录：宿主没有 webServer 服务，设置页的模型选择器不可用')
        return
      }
      try {
        disposeRoute = webServer.register({
          kind: 'exact',
          path: MODEL_CATALOG_PATH,
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              res.writeHead(405, { allow: 'POST' })
              res.end()
              return
            }
            if (!sameOrigin(req)) {
              return sendJson(res, 403, { ok: false, error: '模型目录仅限本机同源调用' })
            }
            let body
            try {
              body = JSON.parse((await readBody(req, MAX_BODY_BYTES)) || '{}')
            } catch {
              return sendJson(res, 400, { ok: false, error: 'body 不是合法 JSON' })
            }
            const modelBackend = String(body?.modelBackend ?? 'sta1n').trim() || 'sta1n'
            const baseURL = String(body?.baseURL ?? '').trim()
            const apiKey = String(body?.apiKey ?? '').trim()
            // 只借维度以外的字段：列模型用不到 embedding，也不会触发维度告警。
            const adapter = createModelAdapter({
              modelBackend,
              baseURL: baseURL === '' ? undefined : baseURL,
              apiKey: apiKey === '' ? undefined : apiKey,
              embeddingModel: String(body?.embeddingModel ?? '').trim() || undefined,
            }, {
              logger,
              resolveApiKey: deps.resolveApiKey,
            })
            try {
              const models = await adapter.listModels()
              if (models.length === 0) {
                return sendJson(res, 200, {
                  ok: false,
                  error: '端点没有列出任何模型（可以手动填写模型 id）',
                })
              }
              return sendJson(res, 200, { ok: true, models })
            } catch (e) {
              return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
            }
          },
        })
      } catch (e) {
        warn(`模型目录路由注册失败: ${e.message}`)
      }
    })
  } catch (e) {
    warn(`模型目录路由挂载失败: ${e.message}`)
    return null
  }

  return () => {
    try { disposeRoute?.() } catch {}
    try { fiber?.dispose?.() } catch {}
  }
}
