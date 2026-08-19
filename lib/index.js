import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const name = 'xindong-client-canvas'
export const inject = ['canvas', 'webServer']

const PREFIX = '/xindong-canvas'
const MAX_BODY_BYTES = 8 * 1024 * 1024
const PIXIBOARD_PATH = fileURLToPath(new URL('./pixiboard.js', import.meta.url))

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: async (req, res) => await handle(ctx, req, res),
  }), 'xindong-client-canvas: HTTP bridge')
}

async function handle(ctx, req, res) {
  const url = new URL(req.url || '/', 'http://x')
  if (url.pathname === `${PREFIX}/pixiboard.js`) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, ['GET', 'HEAD'])
    const body = await readFile(PIXIBOARD_PATH)
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-cache',
      'content-length': String(body.length),
    })
    if (req.method === 'HEAD') res.end()
    else res.end(body)
    return
  }

  const match = url.pathname.match(/^\/xindong-canvas\/boards\/([^/]+)(?:\/(write|replace))?$/)
  if (!match) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Canvas route not found.' } })

  let boardId
  try { boardId = decodeURIComponent(match[1]) } catch { return json(res, 400, { error: { code: 'BAD_BOARD_ID', message: 'Malformed board id.' } }) }
  const action = match[2]

  try {
    if (!action && req.method === 'GET') {
      const document = await ctx.canvas.snapshot(boardId)
      return json(res, 200, { boardId, revision: document.revision, document })
    }
    if (action === 'write' && req.method === 'POST') {
      const body = await readJson(req)
      return json(res, 200, await ctx.canvas.write(boardId, {
        expectedRevision: body.expectedRevision,
        operations: body.operations,
      }))
    }
    if (action === 'replace' && req.method === 'PUT') {
      const body = await readJson(req)
      return json(res, 200, await ctx.canvas.replace(boardId, {
        expectedRevision: body.expectedRevision,
        document: body.document,
      }))
    }
    return methodNotAllowed(res, action === 'replace' ? ['PUT'] : action === 'write' ? ['POST'] : ['GET'])
  } catch (error) {
    const status = error?.code === 'CANVAS_REVISION_CONFLICT' ? 409 : error instanceof SyntaxError || error instanceof TypeError ? 400 : 500
    if (status === 500) ctx.logger.warn(error)
    return json(res, status, {
      error: {
        code: error?.code || (status === 500 ? 'CANVAS_INTERNAL_ERROR' : 'CANVAS_BAD_REQUEST'),
        message: error instanceof Error ? error.message : String(error),
        ...(error?.actual === undefined ? {} : { actualRevision: error.actual }),
      },
    })
  }
}

async function readJson(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new TypeError(`request body exceeds ${MAX_BODY_BYTES} bytes`)
    chunks.push(chunk)
  }
  if (chunks.length === 0) throw new TypeError('request body is required')
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(body.length),
  })
  res.end(body)
}

function methodNotAllowed(res, methods) {
  res.setHeader('allow', methods.join(', '))
  return json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: `Use ${methods.join(' or ')}.` } })
}

export default { name, inject, apply }
