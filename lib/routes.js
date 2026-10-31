/**
 * HTTP routes behind the panel.
 *
 * The browser half never touches the filesystem: it calls these endpoints, and
 * every request is re-validated against the same path policy the tool uses.
 * Requests are accepted only from the loopback origin this Host itself serves,
 * so a page on another site cannot drive the editor through the user's browser.
 *
 * @module @sorarisu/dsh-drawio/lib/routes
 */
import { PathPolicyError } from './paths.js'

/** Largest JSON body accepted from the browser, in bytes. */
const MAX_BODY_BYTES = 12 * 1024 * 1024

/** JSON response helper. */
function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body, 'utf8'),
  })
  response.end(body)
}

/** Plain-text response helper, used for SVG so it renders as an image. */
function sendSvg(response, svg) {
  response.writeHead(200, {
    'content-type': 'image/svg+xml; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(svg)
}

/** Read a JSON body with a hard size cap. */
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    request.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        reject(new PathPolicyError(`请求体超过 ${MAX_BODY_BYTES} 字节上限。`, 'too-large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (bytes > MAX_BODY_BYTES) return
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim().length === 0) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {})
      } catch {
        reject(new PathPolicyError('请求体不是合法 JSON。', 'unresolvable'))
      }
    })
    request.on('error', reject)
  })
}

/** Whether `address` is a loopback literal. */
function isLoopback(address) {
  const text = String(address ?? '').toLowerCase().replace(/^\[|\]$/gu, '')
  return text === 'localhost' || text === 'localhost.' || text === '::1' || text.startsWith('127.') || text.startsWith('::ffff:127.')
}

/**
 * Whether a request came from this Host's own page.
 *
 * Writes are state-changing, so they require the same-origin signal a browser
 * sends for a same-site fetch; reads are limited to loopback sockets.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {boolean} requireSameOrigin - true for mutations.
 */
export function isTrustedRequest(request, requireSameOrigin) {
  if (!isLoopback(request.socket?.remoteAddress)) return false
  if (requireSameOrigin) {
    const site = request.headers['sec-fetch-site']
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return false
    const origin = request.headers.origin
    const host = request.headers.host
    if (host === undefined || host.length === 0) return false
    if (origin !== undefined && origin.length > 0) {
      try {
        const parsed = new URL(origin)
        if (parsed.host !== host) return false
      } catch {
        return false
      }
    }
    return true
  }
  return true
}

/** Map a thrown error onto a response, keeping policy reasons visible. */
function fail(response, error) {
  if (error instanceof PathPolicyError) {
    const status = error.code === 'too-large' ? 413 : error.code === 'outside-workspace' || error.code === 'not-a-diagram' ? 403 : 404
    sendJson(response, status, { ok: false, error: error.message, code: error.code })
    return
  }
  sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
}

/**
 * Register the panel's routes on the Host web server.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - context providing `webServer`.
 * @param {object} deps
 * @param {import('./store.js').DiagramStore} deps.store
 * @param {string} deps.prefix - route prefix, e.g. `/api/sorarisu/dsh-drawio`.
 * @param {string} deps.embedOrigin - allowed editor iframe origin, reported to the panel.
 * @param {{ warn: (message: string) => void }} [deps.logger]
 * @returns {Array<() => void>} disposers, in registration order.
 */
export function registerRoutes(ctx, deps) {
  const { store, prefix, embedOrigin } = deps
  const disposers = []

  const route = (kind, path, handler) => {
    disposers.push(ctx.webServer.register({ kind, path, handler }))
  }

  route('exact', `${prefix}/config`, async (request, response) => {
    if (!isTrustedRequest(request, false)) {
      sendJson(response, 403, { ok: false, error: '仅本机可访问。' })
      return
    }
    sendJson(response, 200, {
      ok: true,
      embedOrigin,
      roots: store.roots,
      maxDocumentBytes: store.maxBytes,
    })
  })

  route('exact', `${prefix}/list`, async (request, response) => {
    if (!isTrustedRequest(request, false)) {
      sendJson(response, 403, { ok: false, error: '仅本机可访问。' })
      return
    }
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const directory = url.searchParams.get('directory') ?? undefined
      const recursive = url.searchParams.get('recursive') === '1'
      const files = await store.list(directory, { recursive })
      sendJson(response, 200, { ok: true, files, roots: store.roots })
    } catch (error) {
      fail(response, error)
    }
  })

  route('exact', `${prefix}/document`, async (request, response) => {
    if (!isTrustedRequest(request, false)) {
      sendJson(response, 403, { ok: false, error: '仅本机可访问。' })
      return
    }
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const path = url.searchParams.get('path')
      if (path === null || path.length === 0) {
        sendJson(response, 400, { ok: false, error: '缺少 path 参数。' })
        return
      }
      const document = await store.read(path)
      sendJson(response, 200, {
        ok: true,
        path: document.path,
        xml: document.xml,
        summary: document.summary,
      })
    } catch (error) {
      fail(response, error)
    }
  })

  route('exact', `${prefix}/save`, async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    if (!isTrustedRequest(request, true)) {
      sendJson(response, 403, { ok: false, error: '已拒绝非本机同源请求。' })
      return
    }
    try {
      const body = await readJsonBody(request)
      if (typeof body.path !== 'string' || body.path.length === 0) {
        sendJson(response, 400, { ok: false, error: '缺少 path。' })
        return
      }
      if (typeof body.xml !== 'string') {
        sendJson(response, 400, { ok: false, error: '缺少 xml。' })
        return
      }
      const written = await store.write(body.path, body.xml)
      sendJson(response, 200, { ok: true, path: written.path, created: written.created, summary: written.summary })
    } catch (error) {
      fail(response, error)
    }
  })

  route('exact', `${prefix}/preview`, async (request, response) => {
    if (!isTrustedRequest(request, false)) {
      sendJson(response, 403, { ok: false, error: '仅本机可访问。' })
      return
    }
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const path = url.searchParams.get('path')
      if (path === null || path.length === 0) {
        sendJson(response, 400, { ok: false, error: '缺少 path 参数。' })
        return
      }
      const document = await store.read(path)
      sendSvg(response, store.preview(document.xml, { title: document.summary.pageName, background: '#ffffff' }))
    } catch (error) {
      fail(response, error)
    }
  })

  return disposers
}
