import { serveSite } from './site-server.js'
import { createPreviewService } from './preview-service.js'
import { createHash } from 'node:crypto'
import { openCanvasDirectory, chooseCanvasDirectory } from './storage-actions.js'
import { createMediaService } from './media-service.js'

export const name = 'xindong-client-canvas'
export const inject = ['canvas', 'webServer', 'officeToPdf']

const previewServices = new WeakMap()
const mediaServices = new WeakMap()
const previewStreams = new WeakMap()

const PREFIX = '/xindong-canvas'
const MAX_BODY_BYTES = 64 * 1024 * 1024

export async function apply(ctx) {
  // Preview caches and journals must use the root selected by storage recovery.
  try { await ctx.canvas.initPromise }
  catch (error) { ctx.logger?.warn?.('画布存储初始化失败，仍提供临时画布入口', error) }
  const previews = createPreviewService(ctx)
  previewServices.set(ctx, previews)
  const media = createMediaService(ctx)
  mediaServices.set(ctx, media)
  const streams = new Set()
  previewStreams.set(ctx, streams)
  ctx.effect(() => () => {
    for (const stream of streams) stream.end()
    streams.clear()
    previewStreams.delete(ctx)
  }, 'xindong-client-canvas: preview events')
  ctx.effect(() => () => { previewServices.delete(ctx); mediaServices.delete(ctx); return Promise.allSettled([previews.dispose(), media.dispose()]) }, 'xindong-client-canvas: preview worker')
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: async (req, res) => await handle(ctx, req, res),
  }), 'xindong-client-canvas: HTTP bridge')
}

async function handle(ctx, req, res) {
  try {
    if (await serveSite(req, res)) return
    return await handleApi(ctx, req, res)
  } catch (error) {
    const status = ['CANVAS_REVISION_CONFLICT', 'CANVAS_PROMPT_SETTINGS_CONFLICT'].includes(error?.code) ? 409
      : ['MEDIA_QUEUE_FULL', 'MEDIA_SERVICE_STOPPED'].includes(error?.code) ? 503
      : error?.code === 'ENOENT' ? 404
        : error instanceof SyntaxError || error instanceof TypeError || error instanceof URIError ? 400 : 500
    if (status === 500) ctx.logger?.warn?.(error)
    if (res.headersSent) {
      res.destroy(error instanceof Error ? error : new Error(String(error)))
      return
    }
    return json(res, status, {
      error: {
        code: error?.code || (status === 500 ? 'CANVAS_INTERNAL_ERROR' : 'CANVAS_BAD_REQUEST'),
        message: error instanceof Error ? error.message : String(error),
        ...(error?.actual === undefined ? {} : { actualRevision: error.actual }),
      },
    })
  }
}

async function handleApi(ctx, req, res) {
  const url = new URL(req.url || '/', 'http://x')

  if (url.pathname === `${PREFIX}/storage-settings` || url.pathname.startsWith(`${PREFIX}/storage-settings/`)) {
    // Native dialogs and filesystem changes must originate from our own UI.
    const origin = req.headers.origin
    if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && new URL(origin).host !== req.headers.host)) {
      return json(res, 403, { error: { message: '请从 DSH 设置页面操作画布目录' } })
    }
    if (url.pathname === `${PREFIX}/storage-settings`) {
      if (req.method === 'GET') return json(res, 200, await ctx.canvas.getStorageSettings())
      if (req.method === 'PUT') return json(res, 200, await ctx.canvas.saveStorageSettings(await readJson(req)))
      return methodNotAllowed(res, ['GET', 'PUT'])
    }
    if (url.pathname === `${PREFIX}/storage-settings/open`) {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST'])
      await openCanvasDirectory((await readJson(req)).root)
      return json(res, 200, { opened: true })
    }
    if (url.pathname === `${PREFIX}/storage-settings/choose`) {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST'])
      return json(res, 200, { root: await chooseCanvasDirectory() })
    }
    return json(res, 404, { error: { message: '画布目录接口不存在' } })
  }

  if (url.pathname === `${PREFIX}/prompt-settings`) {
    if (req.method === 'GET') return json(res, 200, await ctx.canvas.getPromptSettings())
    if (req.method === 'PUT') return json(res, 200, await ctx.canvas.savePromptSettings(await readJson(req)))
    return methodNotAllowed(res, ['GET', 'PUT'])
  }

  const previewEvents = url.pathname.match(/^\/xindong-canvas\/boards\/([^/]+)\/preview-events$/)
  if (previewEvents) {
    if (req.method !== 'GET') return methodNotAllowed(res, ['GET'])
    const boardId = decodeSafe(previewEvents[1])
    if (boardId === null) throw new TypeError('Malformed preview board id')
    const service = previewServices.get(ctx)
    if (!service) return json(res, 503, { error: { code: 'PREVIEW_UNAVAILABLE', message: '预览服务尚未就绪' } })
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    res.flushHeaders?.()
    res.write(': connected\n\n')
    const send = event => {
      if (event.job?.boardId !== boardId || res.destroyed || res.writableEnded) return
      if (res.writableLength > 256 * 1024) { res.end(); return }
      res.write(`event: preview\ndata: ${JSON.stringify(event)}\n\n`)
    }
    const streams = previewStreams.get(ctx)
    let unsubscribe = () => {}
    let unsubscribeMedia = () => {}
    let heartbeat
    const cleanup = () => { clearInterval(heartbeat); unsubscribe(); unsubscribeMedia(); streams?.delete(res) }
    // Install cleanup before replay: recent events can fill the socket buffer.
    res.once('close', cleanup)
    streams?.add(res)
    try {
      unsubscribe = service.subscribe(send)
      unsubscribeMedia = mediaServices.get(ctx)?.subscribe(event => {
        if (event.boardId !== boardId || res.destroyed || res.writableEnded) return
        if (res.writableLength > 256 * 1024) { res.end(); return }
        res.write(`event: media\ndata: ${JSON.stringify(event)}\n\n`)
      }) || (() => {})
      for (const event of service.recent(boardId)) send(event)
      if (res.destroyed || res.writableEnded) { cleanup(); return }
      heartbeat = setInterval(() => {
        if (res.destroyed || res.writableEnded) { cleanup(); return }
        if (res.writableLength > 256 * 1024) { res.end(); return }
        res.write(': keepalive\n\n')
      }, 15_000)
      heartbeat.unref?.()
    } catch (error) {
      cleanup()
      throw error
    }
    return
  }

  const previewBatch = url.pathname.match(/^\/xindong-canvas\/boards\/([^/]+)\/previews$/)
  if (previewBatch && req.method === 'POST') {
    const boardId = decodeSafe(previewBatch[1])
    if (boardId === null) throw new TypeError('Malformed preview board id')
    const body = await readJson(req)
    if (!Array.isArray(body.requests) || !body.requests.length || body.requests.length > 32) throw new TypeError('Expected 1–32 preview requests')
    const service = previewServices.get(ctx)
    if (!service) return json(res, 503, { error: { code: 'PREVIEW_UNAVAILABLE', message: '预览服务尚未就绪' } })
    const jobs = await Promise.all(body.requests.map(async input => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: { code: 'PREVIEW_BAD_REQUEST', message: 'Invalid preview request' } }
      try { return { nodeId: input.nodeId, requestId: input.requestId, job: await service.request({ ...input, boardId }) } }
      catch (error) { return { nodeId: input.nodeId, requestId: input.requestId,
        error: { code: error?.code || (error instanceof TypeError ? 'PREVIEW_BAD_REQUEST' : 'PREVIEW_ADMISSION_FAILED'), message: error?.message || String(error) } } }
    }))
    return json(res, 202, { jobs })
  }

  if (url.pathname === `${PREFIX}/preview-metrics` && req.method === 'POST') {
    const body = await readJson(req)
    const ms = value => Number.isFinite(value) ? Math.max(0, Math.min(600_000, value)) : undefined
    const metrics = { jobId: String(body.jobId || '').slice(0, 128), deliveryMs: ms(body.deliveryMs), applyMs: ms(body.applyMs),
      textureReadyMs: ms(body.textureReadyMs), frameMs: ms(body.frameMs) }
    previewServices.get(ctx)?.reportVisibility?.(metrics)
    ctx.logger?.info?.('[canvas-preview] visible', metrics)
    res.writeHead(204); res.end(); return
  }

  const mediaRequest = url.pathname.match(/^\/xindong-canvas\/boards\/([^/]+)\/assets\/([^/]+)\/media$/)
  if (mediaRequest && req.method === 'POST') {
    const boardId = decodeSafe(mediaRequest[1]), assetId = decodeSafe(mediaRequest[2])
    if (boardId === null || assetId === null) throw new TypeError('Malformed media asset id')
    const service = mediaServices.get(ctx)
    if (!service) return json(res, 503, { error: { message: '媒体预览服务尚未就绪' } })
    return json(res, 202, await service.request(boardId, assetId))
  }

  const previewRequest = url.pathname.match(/^\/xindong-canvas\/boards\/([^/]+)\/assets\/([^/]+)\/preview$/)
  if (previewRequest && req.method === 'POST') {
    const boardId = decodeSafe(previewRequest[1]), assetId = decodeSafe(previewRequest[2])
    if (boardId === null || assetId === null) throw new TypeError('Malformed preview asset id')
    const body = await readJson(req)
    const service = previewServices.get(ctx)
    if (!service) return json(res, 503, { error: { code: 'PREVIEW_UNAVAILABLE', message: '预览服务尚未就绪' } })
    return json(res, 202, await service.request({ ...body, boardId, assetId }))
  }
  const previewJob = url.pathname.match(/^\/xindong-canvas\/preview-jobs\/([^/]+)$/)
  if (previewJob) {
    if (req.method !== 'GET') return methodNotAllowed(res, ['GET'])
    const id = decodeSafe(previewJob[1])
    const job = id && previewServices.get(ctx)?.status(id)
    return job ? json(res, 200, job) : json(res, 404, { error: { code: 'PREVIEW_JOB_NOT_FOUND', message: '预览任务不存在或已过期' } })
  }

  // Board list & creation (canvases are global, not per-session).
  if (url.pathname === `${PREFIX}/boards`) {
    if (req.method === 'GET') {
      const boards = await ctx.canvas.listBoards()
      return json(res, 200, { boards })
    }
    if (req.method === 'POST') {
      const body = await readJson(req, true)
      const boardId = body.boardId && String(body.boardId).trim() ? String(body.boardId).trim() : randomId()
      await ctx.canvas.createBoard(boardId, { name: body.name, document: body.document })
      const document = await ctx.canvas.snapshot(boardId)
      return json(res, 200, { boardId, revision: document.revision, document })
    }
    return methodNotAllowed(res, ['GET', 'POST'])
  }

  // The globally current canvas: the one every conversation and agent tool
  // sees by default. GET returns the document directly so the client can
  // render it without a second round trip.
  if (url.pathname === `${PREFIX}/current`) {
    if (req.method === 'GET') {
      const boardId = await ctx.canvas.getCurrentBoardId()
      const document = await ctx.canvas.snapshot(boardId)
      return json(res, 200, { boardId, revision: document.revision, document })
    }
    if (req.method === 'PUT') {
      const body = await readJson(req)
      const boardId = await ctx.canvas.setCurrentBoardId(body.boardId)
      return json(res, 200, { boardId })
    }
    return methodNotAllowed(res, ['GET', 'PUT'])
  }

  const assetGet = url.pathname.match(/^\/xindong-canvas\/boards\/([^/]+)\/assets\/([^/]+)\/([^/]+)$/)
  if (assetGet) {
    if (!['GET', 'HEAD', 'PUT'].includes(req.method)) return methodNotAllowed(res, ['GET', 'HEAD', 'PUT'])
    const boardId = decodeSafe(assetGet[1])
    if (boardId === null) return json(res, 400, { error: { code: 'BAD_BOARD_ID', message: 'Malformed board id.' } })
    const assetId = decodeSafe(assetGet[2])
    const variant = decodeSafe(assetGet[3])
    if (assetId === null || variant === null) return json(res, 400, { error: { code: 'BAD_ASSET_ID', message: 'Malformed asset id.' } })
    if (req.method === 'PUT') {
      const body = await readRaw(req)
      const mimeType = url.searchParams.get('mimeType') || 'application/octet-stream'
      const fileName = url.searchParams.get('fileName') || `${assetId}.bin`
      const binaryResult = await ctx.canvas.putBinary(boardId, assetId, variant, body, { mimeType, fileName, size: body.length })
      if (variant === 'original') {
        const current = await ctx.canvas.snapshot(boardId)
        const existing = current.assets.find((asset) => asset.id === assetId)
        const recordText = url.searchParams.get('assetRecord')
        const record = recordText ? JSON.parse(recordText) : {}
        if (!record || typeof record !== 'object' || Array.isArray(record) || (record.id !== undefined && record.id !== assetId)) {
          throw new TypeError('assetRecord must describe the asset being uploaded')
        }
        const result = await ctx.canvas.upsertAsset(boardId, {
          ...existing,
          id: assetId,
          kind: record.kind || url.searchParams.get('kind') || existing?.kind || inferKind(mimeType, fileName),
          metadata: { ...existing?.metadata, ...record.metadata, mimeType, fileName, name: fileName, size: body.length, contentHash: createHash('sha256').update(body).digest('hex') },
        })
        return json(res, 200, { ...binaryResult, revision: result.revision, asset: result.asset })
      }
      const document = await ctx.canvas.snapshot(boardId)
      return json(res, 200, { ...binaryResult, revision: document.revision })
    }
    const binary = await ctx.canvas.getBinary(boardId, assetId, variant)
    if (!binary) return json(res, 404, { error: { code: 'ASSET_NOT_FOUND', message: 'Asset binary not found.' } })
    res.writeHead(200, {
      'content-type': binary.mimeType,
      'content-length': String(binary.data.length),
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox allow-downloads; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; media-src 'self' data: blob:",
      ...(binary.fileName ? { 'content-disposition': `inline; filename="${encodeURIComponent(binary.fileName)}"` } : {}),
    })
    if (req.method === 'HEAD') res.end()
    else res.end(binary.data)
    return
  }

  const assetDelete = url.pathname.match(/^\/xindong-canvas\/boards\/([^/]+)\/assets\/([^/]+)$/)
  if (assetDelete) {
    if (req.method !== 'DELETE') return methodNotAllowed(res, ['DELETE'])
    const boardId = decodeSafe(assetDelete[1])
    const assetId = decodeSafe(assetDelete[2])
    if (boardId === null) return json(res, 400, { error: { code: 'BAD_BOARD_ID', message: 'Malformed board id.' } })
    if (assetId === null) return json(res, 400, { error: { code: 'BAD_ASSET_ID', message: 'Malformed asset id.' } })
    return json(res, 200, await ctx.canvas.removeAsset(boardId, assetId))
  }

  const assetPost = url.pathname.match(/^\/xindong-canvas\/boards\/([^/]+)\/assets$/)
  if (assetPost && req.method === 'POST') {
    const boardId = decodeSafe(assetPost[1])
    if (boardId === null) return json(res, 400, { error: { code: 'BAD_BOARD_ID', message: 'Malformed board id.' } })
    const body = await readRaw(req)
    if (body.length === 0) throw new TypeError('asset body is required')
    const assetId = url.searchParams.get('assetId') || randomId()
    const kind = url.searchParams.get('kind') || inferKind(url.searchParams.get('mimeType') || 'application/octet-stream', url.searchParams.get('fileName') || '')
    const fileName = url.searchParams.get('fileName') || `${assetId}.bin`
    const mimeType = url.searchParams.get('mimeType') || 'application/octet-stream'
    const variant = url.searchParams.get('variant') || 'original'
    const create = (url.searchParams.get('create') || 'true') !== 'false'
    const duration = finiteParam(url, 'duration', 0)
    const documentNode = !['image', 'video', 'audio'].includes(kind)

    // Variant-only uploads (poster frame, waveform, preview) just store bytes;
    // the owning asset record and node are committed by the `create` call.
    if (!create) {
      await ctx.canvas.putBinary(boardId, assetId, variant, body, { mimeType, fileName, size: body.length })
      return json(res, 200, { boardId, assetId, variant, size: body.length })
    }

    const imported = await ctx.canvas.storeImportedAsset(boardId, {
      assetId,
      data: body,
      kind,
      fileName,
      mimeType,
      metadata: duration > 0 ? { duration } : {},
    })
    const props = {}
    if (duration > 0) props.duration = duration
    const intrinsicWidth = positiveParam(url, 'intrinsicWidth', 0)
    const intrinsicHeight = positiveParam(url, 'intrinsicHeight', 0)
    if (intrinsicWidth > 0 && intrinsicHeight > 0 && !imported.intrinsicWidth) {
      imported.intrinsicWidth = intrinsicWidth; imported.intrinsicHeight = intrinsicHeight
    }
    const node = ctx.canvas.createImportedNode(imported, {
      node: {
        type: ['image', 'video', 'audio', 'html', 'markdown', 'text-file', 'model'].includes(kind) ? kind : 'file',
        x: numberParam(url, 'x', 100), y: numberParam(url, 'y', 100),
        ...(url.searchParams.has('width') ? { width: positiveParam(url, 'width', 320) } : {}),
        ...(url.searchParams.has('height') ? { height: positiveParam(url, 'height', 240) } : {}),
        props,
      },
    })
    const writeResult = await ctx.canvas.write(boardId, {
      assets: [imported.asset],
      operations: [{
        type: 'create',
        nodes: [node],
      }],
    })
    if (!documentNode) void mediaServices.get(ctx)?.request(boardId, assetId).catch(error => ctx.logger?.warn?.('[canvas-media] HTTP import admission failed', error))
    if (documentNode) {
      void previewServices.get(ctx)?.request({ boardId, assetId, nodeId: writeResult.addedNodeIds[0], requestId: node.props.previewRequestId, ...node.props.previewSpec })
        .catch(error => ctx.logger?.warn?.('[canvas-preview] HTTP import preview admission failed', error))
    }
    return json(res, 200, {
      boardId,
      revision: writeResult.revision,
      asset: imported.asset,
      document: writeResult.document,
    })
  }

  const match = url.pathname.match(/^\/xindong-canvas\/boards\/([^/]+)(?:\/(write|replace))?$/)
  if (!match) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Canvas route not found.' } })

  let boardId
  try { boardId = decodeURIComponent(match[1]) } catch { return json(res, 400, { error: { code: 'BAD_BOARD_ID', message: 'Malformed board id.' } }) }
  const action = match[2]

  if (!action && req.method === 'PATCH') {
    const body = await readJson(req)
    return json(res, 200, await ctx.canvas.renameBoard(boardId, body.name))
  }
  if (!action && req.method === 'DELETE') {
    return json(res, 200, await ctx.canvas.deleteBoard(boardId))
  }
  if (!action && req.method === 'GET') {
    const document = await ctx.canvas.snapshot(boardId)
    const pendingFocus = ctx.canvas.focusRequests?.get(boardId)
    const focusRequest = pendingFocus?.expiresAt > Date.now() ? pendingFocus : undefined
    return json(res, 200, { boardId, revision: document.revision, document, focusRequest })
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
  return methodNotAllowed(res, action === 'replace' ? ['PUT'] : action === 'write' ? ['POST'] : ['GET', 'PATCH', 'DELETE'])
}

async function readJson(req, optional = false) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new TypeError(`request body exceeds ${MAX_BODY_BYTES} bytes`)
    chunks.push(chunk)
  }
  if (size === 0) {
    if (optional) return {}
    throw new TypeError('request body is required')
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('request body must be an object')
  return body
}

async function readRaw(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new TypeError(`request body exceeds ${MAX_BODY_BYTES} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function decodeSafe(value) {
  try { return decodeURIComponent(value) } catch { return null }
}

function randomId() {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `asset-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function inferKind(mimeType, fileName) {
  const normalized = mimeType.toLowerCase()
  if (normalized.startsWith('image/')) return 'image'
  if (normalized.startsWith('video/')) return 'video'
  if (normalized.startsWith('audio/')) return 'audio'
  const extension = fileName.split('.').pop()?.toLowerCase() || ''
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'].includes(extension)) return 'image'
  if (['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(extension)) return 'video'
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(extension)) return 'audio'
  return 'file'
}

function finiteParam(url, name, fallback) {
  const raw = url.searchParams.get(name)
  if (raw === null || raw === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

/** Any finite number — canvas coordinates are unbounded in both directions. */
function numberParam(url, name, fallback) {
  const raw = url.searchParams.get(name)
  if (raw === null || raw === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

/**
 * Mirrors the site's fitNode(): clamp intrinsic media dimensions to a
 * MAX_NODE_EDGE (320) footprint without ever upscaling.
 */
function fitIntrinsicSize(width, height) {
  const MAX_NODE_EDGE = 320
  const safeWidth = width > 0 ? width : MAX_NODE_EDGE
  const safeHeight = height > 0 ? height : MAX_NODE_EDGE
  const scale = Math.min(MAX_NODE_EDGE / safeWidth, MAX_NODE_EDGE / safeHeight, 1)
  return { width: Math.round(safeWidth * scale), height: Math.round(safeHeight * scale) }
}

/**
 * Intrinsic pixel size of an image buffer, read from its header (PNG, GIF,
 * JPEG, WebP). Returns null for anything else or malformed input.
 */
function readImageSize(buffer) {
  if (!buffer || buffer.length < 16) return null
  // PNG: 8-byte signature, then IHDR width/height as big-endian uint32.
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 && buffer.length >= 24) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  // GIF: logical screen descriptor, little-endian uint16.
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
  }
  // JPEG: walk the marker segments to the first SOF frame header.
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue }
      const marker = buffer[offset + 1]
      const size = buffer.readUInt16BE(offset + 2)
      if (size < 2) return null
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
      }
      offset += 2 + size
    }
    return null
  }
  // WebP: RIFF container with VP8X (extended), VP8 (lossy) or VP8L (lossless).
  if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const format = buffer.toString('ascii', 12, 16)
    if (format === 'VP8X') {
      const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16))
      const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16))
      return { width, height }
    }
    if (format === 'VP8 ') {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
    }
    if (format === 'VP8L' && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
  }
  return null
}

function positiveParam(url, name, fallback) {
  const raw = url.searchParams.get(name)
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
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
