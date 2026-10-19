import { createHash, randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { readdir, readFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { createPdfPreviewRenderer } from './pdf-preview.js'
import { createPreviewScheduler } from './preview-scheduler.js'
import { createPreviewByteCache } from './preview-cache.js'
import { createPreviewJournal } from './preview-journal.js'
import { createModelPreviewRenderer, MODEL_FORMATS, zipContainsModel } from './model-preview.js'

const require = createRequire(import.meta.url)
const ORIGIN = 'https://canvas-preview.invalid'
const RENDER_VERSION = 'canvas-document-model-preview-v11'
const MAX_PIXELS = 8_000_000
const MAX_INPUT_BYTES = 64 * 1024 * 1024
const MAX_MODEL_RESOURCES = 256
const MAX_MODEL_BYTES = 128 * 1024 * 1024
const MODEL_RESOURCE_FORMATS = new Set(['bin', 'mtl', 'png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'bmp', 'tga', 'tif', 'tiff', 'dds', 'ktx', 'ktx2', 'basis', 'hdr', 'exr'])
const MAX_CACHE_BYTES = 512 * 1024 * 1024
const MAX_CACHE_ENTRIES = 256
const MAX_JOBS = 512
const MAX_QUEUE = 32
const CONCURRENCY = 3
const FONT_TTL = 60_000
const JOB_TIMEOUT = 90_000
const RESOURCE_TIMEOUT = 8_000
const CACHE_AGE = 7 * 24 * 60 * 60 * 1000
const OFFICE = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'])
const TEXT = new Set(['txt', 'text', 'log', 'xml', 'yaml', 'yml', 'js', 'ts', 'jsx', 'tsx', 'py', 'sh', 'sql', 'css', 'ini', 'toml'])

/** Dependencies are loaded only by the render lane which needs them. No HTTP routes are owned here. */
export function createPreviewService(ctx) {
  if (!ctx?.canvas) throw new TypeError('文档预览需要 canvas 服务')
  const cacheRoot = ctx.canvas.root ? join(ctx.canvas.root, 'previews') : join(homedir(), '.dsh', 'canvas-previews')
  const modelRenderer = createModelPreviewRenderer()
  const pdfRenderer = createPdfPreviewRenderer()
  const jobs = new Map()
  const dedup = new Map()
  const renderFlights = new Map()
  const officeFlights = new Map()
  const officeCache = createPreviewByteCache({ maxBytes: 32 * 1024 * 1024, maxEntries: 16, maxAge: CACHE_AGE })
  const assetLocks = new Map()
  const contexts = new Set()
  const listeners = new Set()
  const byteCache = createPreviewByteCache()
  const journal = createPreviewJournal({ root: cacheRoot, onError: error => diagnostic('保存预览性能日志失败', error) })
  const scheduler = createPreviewScheduler({ concurrency: CONCURRENCY, maxQueue: MAX_QUEUE,
    run: job => run(job).catch(error => diagnostic('任务处理异常', error)) })
  const active = scheduler.active
  const lifetime = new AbortController()
  let admitting = 0
  let disposed = false
  let disposal
  let browserPromise
  let fontPromise
  let fontValue
  let fontExpires = 0
  let pdfFilesPromise
  let cleanupPromise
  let cleanupAgain = false
  let cleanupCursor = ''

  function diagnostic(message, error) {
    try { ctx.logger?.warn?.(`[canvas-preview] ${message}`, error) } catch { /* logging cannot fail a job */ }
  }

  function recordPerformance(job) {
    journal.record({ jobId: job.id, boardId: job.input.boardId, nodeId: job.input.nodeId,
      assetId: job.input.assetId, lane: job.lane, status: job.status, cache: job.cache || null,
      quality: job.input.quality, timings: job.timings,
      ...(job.error?.code ? { error: { code: job.error.code } } : {}) })
  }

  function reportVisibility(metrics) {
    if (disposed || !metrics || typeof metrics.jobId !== 'string') return false
    const job = jobs.get(metrics.jobId)
    if (!job || job.status !== 'ready') return false
    let changed = false
    for (const key of ['deliveryMs', 'applyMs', 'textureReadyMs', 'frameMs']) {
      const value = metrics[key]
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > CACHE_AGE || job.timings[key] !== undefined) continue
      job.timings[key] = value
      changed = true
    }
    if (changed) recordPerformance(job)
    return changed
  }

  function snapshot(job) {
    if (!job) return undefined
    return structuredClone({
      id: job.id, status: job.status, boardId: job.input.boardId,
      assetId: job.input.assetId, nodeId: job.input.nodeId, requestId: job.input.requestId, quality: job.input.quality,
      lane: job.lane, timings: job.timings, cache: job.cache,
      ...(job.status === 'ready' && job.previewVariant ? { previewVariant: job.previewVariant } : {}),
      result: job.result, ...(job.error ? { error: job.error } : {}),
    })
  }

  async function target(input, job) {
    const document = await ctx.canvas.snapshot(input.boardId)
    const node = document.nodes?.find(item => item.id === input.nodeId)
    const asset = document.assets?.find(item => item.id === input.assetId)
    if (!node || !asset || node.props?.previewRequestId !== input.requestId ||
        !Object.entries(node.assetRefs || {}).some(([key, ref]) => key !== 'preview' && !key.startsWith('_documentPreview') && ref?.assetId === input.assetId)) {
      throw failure('PREVIEW_STALE_REQUEST', '预览请求已失效：节点、原始资产或请求标记已经改变')
    }
    if (job?.sourceDigest && digest(resourceManifest([asset])) !== job.sourceDigest) throw failure('PREVIEW_STALE_REQUEST', '原始资产记录已改变，请重新请求预览')
    if (job?.contentHash && asset.metadata?.contentHash && asset.metadata.contentHash !== job.contentHash) {
      throw failure('PREVIEW_STALE_REQUEST', '原始文件已改变，请重新请求预览')
    }
    if (job?.resourceDigest && digest(resourceManifest(job.resourceKind === 'model'
      ? selectedModelAssets(document.assets, input.assetId, job.resourceReferences) : document.assets)) !== job.resourceDigest) {
      throw failure('PREVIEW_STALE_REQUEST', '同画布资源已改变，请重新请求预览')
    }
    // Re-read versions at publication: a snapshot and binary lookup are separate operations.
    const checks = new Map((job?.modelResourceChecks || []).map(item => [item.assetId, item]))
    for (const [assetId, version] of job?.versions || []) checks.set(assetId, { assetId, contentHash: version.contentHash })
    for (const resource of checks.values()) {
      const signal = job.signal || lifetime.signal
      const version = ctx.canvas.getBinaryVersion
        ? await abortable(ctx.canvas.getBinaryVersion(input.boardId, resource.assetId, 'original'), signal, RESOURCE_TIMEOUT) : null
      const binary = !ctx.canvas.getBinaryVersion ? await abortable(ctx.canvas.getBinary(input.boardId, resource.assetId, 'original'), signal, RESOURCE_TIMEOUT) : null
      const hash = ctx.canvas.getBinaryVersion ? version?.contentHash || null : binary?.data ? sha(Buffer.from(binary.data)) : null
      if (hash !== resource.contentHash) {
        throw failure('PREVIEW_STALE_REQUEST', '模型原文件或关联资源已改变，请重新请求预览')
      }
    }
    return { document, node, asset }
  }

  async function request(raw) {
    const started = Date.now()
    const input = normalizeInput(raw)
    if (disposed) throw failure('PREVIEW_DISPOSED', '文档预览服务已关闭')
    if (admitting >= MAX_QUEUE * 5) throw failure('PREVIEW_QUEUE_FULL', '预览队列已满，请稍后重试')
    admitting++
    try {
      const { document, asset } = await target(input)
      const name = asset.metadata?.fileName || asset.metadata?.name || asset.metadata?.relativePath || `${asset.id}.bin`
      const kind = classify(name, asset.metadata?.mimeType)
      // Document text must be readable on import, before selection requests detail.
      if (kind && kind !== 'model') input.quality = 'detail'
      const lane = ['model', 'pdf', 'office', 'html'].includes(kind) ? kind : 'light'
      const fontKey = kind === 'model' ? '' : await fontsFingerprint()
      const fingerprint = digest({ input, assets: resourceManifest(document.assets), version: RENDER_VERSION,
        office: ctx.officeToPdf?.config || {}, fonts: fontKey })
      const previous = jobs.get(dedup.get(fingerprint))
      // Only in-flight deduplication: terminal jobs must pass current dependency validation again.
      if (previous && ['queued', 'running'].includes(previous.status)) return snapshot(previous)
      if (disposed) throw failure('PREVIEW_DISPOSED', '文档预览服务已关闭')
      await target(input)
      if (disposed) throw failure('PREVIEW_DISPOSED', '文档预览服务已关闭')
      pruneJobs(MAX_JOBS - 1)
      if (jobs.size >= MAX_JOBS) throw failure('PREVIEW_QUEUE_FULL', '预览任务已满，请稍后重试')
      const job = {
        id: randomUUID(), input, fingerprint, fontKey, lane, status: 'queued', createdAt: started,
        admittedAt: Date.now(), controller: new AbortController(), timings: { admission: Date.now() - started, queue: 0, prepare: 0, cache: 0, render: 0, publish: 0, total: 0 },
        result: { width: input.width, height: input.height, layoutWidth: input.width, layoutHeight: input.height, pageCount: 0, warnings: [], cacheKey: '' },
      }
      const superseded = [...jobs.values()].filter(previous => previous.input.boardId === input.boardId &&
        previous.input.nodeId === input.nodeId && previous.input.requestId !== input.requestId && ['queued', 'running'].includes(previous.status))
      if (!scheduler.enqueue(job, superseded)) throw failure('PREVIEW_QUEUE_FULL', '该预览通道队列已满，请稍后重试')
      for (const previous of superseded) {
        const wasQueued = previous.status === 'queued'
        previous.status = 'superseded'
        previous.timings.total = Date.now() - previous.createdAt
        scheduler.cancel(previous)
        if (wasQueued) recordPerformance(previous)
        previous.controller.abort(failure('PREVIEW_SUPERSEDED', '预览请求已被新请求替代'))
        if (dedup.get(previous.fingerprint) === previous.id) dedup.delete(previous.fingerprint)
      }
      jobs.set(job.id, job)
      dedup.set(fingerprint, job.id)
      pruneJobs()
      return snapshot(job)
    } finally { admitting-- }
  }

  function emit(event) {
    for (const listener of listeners) {
      try { listener(structuredClone(event)) } catch (error) { diagnostic('预览事件订阅失败', error) }
    }
  }

  function pruneJobs(limit = MAX_JOBS) {
    for (const [id, job] of jobs) {
      if (['queued', 'running'].includes(job.status)) continue
      if (jobs.size <= limit && Date.now() - job.createdAt < CACHE_AGE) continue
      jobs.delete(id)
      if (dedup.get(job.fingerprint) === id) dedup.delete(job.fingerprint)
    }
  }

  async function run(job) {
    if (job.status === 'superseded') return
    job.status = 'running'
    job.timings.queue = Date.now() - job.admittedAt
    const prepareStarted = Date.now()
    let prepareComplete = false
    const finishPrepare = () => {
      if (prepareComplete) return
      job.timings.prepare += Math.max(0, Date.now() - prepareStarted - job.timings.cache)
      prepareComplete = true
    }
    const controller = job.controller
    job.signal = controller.signal
    const cancel = () => controller.abort(lifetime.signal.reason)
    lifetime.signal.addEventListener('abort', cancel, { once: true })
    if (lifetime.signal.aborted) cancel()
    const timer = setTimeout(() => controller.abort(failure('PREVIEW_TIMEOUT', '文档预览超时，请减少内容或稍后重试')), JOB_TIMEOUT)
    timer.unref?.()
    try {
      const { document, asset } = await target(job.input, job)
      job.sourceDigest = digest(resourceManifest([asset]))
      const metadataName = asset.metadata?.fileName || asset.metadata?.name || asset.metadata?.relativePath || `${asset.id}.bin`
      const metadataKind = classify(metadataName, asset.metadata?.mimeType)
      const early = await metadataCache(job, document, asset, metadataName, metadataKind)
      if (early) {
        finishPrepare()
        job.result = { ...early.result, warnings: [...early.result.warnings] }
        await finishPublish(job, early.png, metadataName, controller.signal)
        return
      }
      // A failed metadata lookup must not retain the old sidecar's dependency selection.
      if (job.versions) job.versions = new Map([...job.versions].filter(([id]) => id === asset.id))
      delete job.resourceDigest
      delete job.resourceReferences
      delete job.resourceKind
      job.modelResourceChecks = []
      check(controller.signal)
      const original = await abortable(resourceBinary(job.input.boardId, asset), controller.signal)
      if (!original?.data) throw failure('PREVIEW_ORIGINAL_MISSING', '原始文件不存在，请重新上传')
      const bytes = Buffer.from(original.data)
      if (bytes.length > MAX_INPUT_BYTES) throw failure('PREVIEW_INPUT_TOO_LARGE', '原始文件超过 64 MB，暂时无法生成预览')
      const name = asset.metadata?.fileName || asset.metadata?.name || asset.metadata?.relativePath || original.fileName || `${asset.id}.bin`
      const kind = classify(name, asset.metadata?.mimeType || original.mimeType)
      if (!kind) {
        job.result.warnings.push('此文件格式暂不支持文档预览，保留原有卡片')
        finishPrepare()
        const started = Date.now()
        try { await updateNode(job, 'unsupported', controller.signal) } finally { job.timings.publish += Date.now() - started }
        check(controller.signal)
        job.status = 'unsupported'
        return
      }
      const contentHash = sha(bytes)
      if (job.versions?.has(asset.id) && job.versions.get(asset.id).contentHash !== contentHash) throw failure('PREVIEW_STALE_REQUEST', '原始文件已改变，请重新请求预览')
      job.contentHash = contentHash
      if (asset.metadata?.contentHash && asset.metadata.contentHash !== contentHash) {
        throw failure('PREVIEW_STALE_REQUEST', '原始文件与上传记录不一致，请重新请求预览')
      }
      if (extname(name).toLowerCase() === '.zip') {
        job.detectedNodeType = await zipContainsModel(bytes) ? 'model' : 'file'
        if (job.detectedNodeType === 'file') {
          job.result.warnings.push('压缩包中没有支持预览的模型文件')
          finishPrepare()
          const started = Date.now()
          try { await updateNode(job, 'unsupported', controller.signal) } finally { job.timings.publish += Date.now() - started }
          check(controller.signal)
          job.status = 'unsupported'
          return
        }
      }
      const hasResources = ['html', 'markdown', 'model'].includes(kind)
      const modelResources = kind === 'model'
        ? await collectModelResources(job, document.assets || [], bytes, asset.metadata?.relativePath || name, controller.signal) : undefined
      if (hasResources) {
        job.resourceKind = kind
        job.resourceDigest = digest(resourceManifest(kind === 'model'
          ? selectedModelAssets(document.assets, job.input.assetId, job.resourceReferences) : document.assets))
      }
      job.modelResourceChecks = modelResources?.checks || []
      for (const item of job.modelResourceChecks) {
        const version = job.versions?.get(item.assetId)
        if (version && version.contentHash !== item.contentHash) throw failure('PREVIEW_STALE_REQUEST', '关联资源已改变，请重新请求预览')
      }
      // Unhashed uploads always retain byte verification, including HTML dependencies.
      for (const resource of [asset, ...(!modelResources && hasResources ? document.assets.filter(item => item.id !== asset.id) : [])]) {
        if (resource.metadata?.contentHash) continue
        const binary = resource.id === asset.id ? original : await abortable(resourceBinary(job.input.boardId, resource), controller.signal, RESOURCE_TIMEOUT)
        const hash = binary?.data ? sha(Buffer.from(binary.data)) : null
        if (job.versions?.has(resource.id) && job.versions.get(resource.id).contentHash !== hash) throw failure('PREVIEW_STALE_REQUEST', '关联资源已改变，请重新请求预览')
        job.modelResourceChecks.push({ assetId: resource.id, contentHash: hash })
      }
      await target(job.input, job)
      check(controller.signal)
      await resolveVersions(job, hasResources ? (kind === 'model'
        ? [asset, ...selectedModelAssets(document.assets, job.input.assetId, job.resourceReferences)] : document.assets) : [asset])
      await target(job.input, job)
      const baseKey = buildKey(job, asset, name, kind, contentHash,
        kind === 'model' ? selectedModelAssets(document.assets, job.input.assetId, job.resourceReferences) : hasResources ? document.assets : [],
        modelResources?.manifest.contents || job.modelResourceChecks)
      finishPrepare()
      const rendered = await abortable(sharedRender(job, baseKey, signal => renderDocument({
        job, bytes, name, relativePath: asset.metadata?.relativePath, kind, contentHash, assets: document.assets || [],
        modelResources, signal, baseKey,
      })), controller.signal)
      job.result = { ...rendered.result, warnings: [...rendered.result.warnings] }
      if (rendered.timings) job.timings.renderer = { ...rendered.timings }
      if (kind === 'model' && job.contentHash) {
        const started = Date.now()
        await writeDependencies(job, asset, name).catch(error => diagnostic('保存模型依赖清单失败', error))
        job.timings.cache += Date.now() - started
      }
      await finishPublish(job, rendered.png, name, controller.signal)
    } catch (error) {
      finishPrepare()
      if (job.status === 'superseded' || error?.code === 'PREVIEW_SUPERSEDED') {
        job.status = 'superseded'
        return
      }
      job.status = 'error'
      job.error = { code: error?.code || 'PREVIEW_RENDER_FAILED', message: friendlyError(error) }
      diagnostic(`${job.id} ${job.input.assetId}: ${job.error.message}`, error)
      // updateNode rechecks the token; even a changed resource gets a useful error on
      // a still-matching node, while a reset/reimport can never receive this status.
      if (!disposed) {
        const started = Date.now()
        try { await updateNode(job, 'error', lifetime.signal) } catch (writeError) {
          if (writeError?.code !== 'PREVIEW_STALE_REQUEST') diagnostic('写入预览错误状态失败', writeError)
        } finally { job.timings.publish += Date.now() - started }
      }
    } finally {
      clearTimeout(timer)
      lifetime.signal.removeEventListener('abort', cancel)
      delete job.signal
      job.timings.total = Date.now() - job.createdAt
      if (job.committedPatch?.props?.previewStatus === job.status && job.status !== 'superseded') {
        const previewVariant = job.committedPatch.assetRefs?.preview?.variant
        const event = { job: snapshot(job), nodePatch: job.committedPatch,
          ...(previewVariant ? { previewVariant } : {}),
          ...(job.committedAsset ? { asset: job.committedAsset } : {}),
          ...(job.committedRevision !== undefined ? { revision: job.committedRevision } : {}), emittedAt: Date.now() }
        job.terminalEvent = structuredClone(event)
        emit(event)
      }
      recordPerformance(job)
      pruneJobs()
    }
  }

  async function finishPublish(job, png, name, signal) {
    check(signal)
    const started = Date.now()
    try { await withAssetLock(job.input, () => publish(job, png, name, signal)) }
    finally { job.timings.publish += Date.now() - started }
    check(signal)
    job.status = 'ready'
    cleanupCache()
  }

  async function sharedRender(job, key, render) {
    let flight = renderFlights.get(key)
    const shared = Boolean(flight)
    if (!flight) {
      const controller = new AbortController()
      const cancel = () => controller.abort(lifetime.signal.reason)
      lifetime.signal.addEventListener('abort', cancel, { once: true })
      if (lifetime.signal.aborted) cancel()
      const timer = setTimeout(() => controller.abort(failure('PREVIEW_TIMEOUT', '文档预览超时')), JOB_TIMEOUT)
      timer.unref?.()
      flight = { controller, consumers: 0, done: false }
      flight.promise = (async () => {
        const started = Date.now()
        const cached = await readCache(key)
        flight.cacheMs = Date.now() - started
        check(controller.signal)
        if (cached) { flight.cache = 'disk'; return cached }
        flight.cache = 'miss'
        const renderStarted = Date.now()
        let value
        try { value = await abortable(render(controller.signal), controller.signal) }
        finally { flight.renderMs = Date.now() - renderStarted }
        check(controller.signal)
        const cacheStarted = Date.now()
        await writeCache(key, value).catch(error => diagnostic('预览磁盘缓存写入失败', error))
        flight.cacheMs += Date.now() - cacheStarted
        return value
      })().finally(() => {
        flight.done = true
        clearTimeout(timer)
        lifetime.signal.removeEventListener('abort', cancel)
        if (renderFlights.get(key) === flight) renderFlights.delete(key)
      })
      renderFlights.set(key, flight)
    }
    flight.consumers++
    const started = Date.now()
    try { return await abortable(flight.promise, job.signal) }
    finally {
      job.cache = shared ? 'shared' : flight.cache || 'miss'
      if (shared) job.timings.render += Date.now() - started
      else { job.timings.cache += flight.cacheMs || 0; job.timings.render += flight.renderMs || 0 }
      if (--flight.consumers === 0 && !flight.done) {
        flight.controller.abort(failure('PREVIEW_CANCELLED', '预览已取消'))
        if (renderFlights.get(key) === flight) renderFlights.delete(key)
      }
    }
  }

  async function withAssetLock(input, operation) {
    const key = JSON.stringify([input.boardId, input.assetId])
    const previous = assetLocks.get(key) || Promise.resolve()
    const work = previous.catch(() => {}).then(operation)
    assetLocks.set(key, work)
    try { return await work } finally { if (assetLocks.get(key) === work) assetLocks.delete(key) }
  }

  async function publish(job, png, name, signal) {
    check(signal)
    await target(job.input, job)
    if (!/^[a-f0-9]{64}$/.test(job.result.cacheKey)) throw failure('PREVIEW_INVALID_CACHE_KEY', '预览产物缓存标识无效')
    const variant = `preview-${job.result.cacheKey}`
    job.previewVariant = variant
    const existing = await abortable(ctx.canvas.getBinary(job.input.boardId, job.input.assetId, variant), signal)
    check(signal)
    if (existing?.data) {
      // An artifact is immutable once present. Reuse it even if a fresh render's
      // PNG encoding differs; never replace bytes already referenced by nodes.
      const bytes = Buffer.from(existing.data)
      if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
          bytes.readUInt32BE(16) !== job.result.width || bytes.readUInt32BE(20) !== job.result.height) {
        throw failure('PREVIEW_ARTIFACT_CONFLICT', '已有预览产物与缓存尺寸不一致，请重新请求预览')
      }
    } else {
      await target(job.input, job)
      check(signal)
      await ctx.canvas.putBinary(job.input.boardId, job.input.assetId, variant, png, {
        mimeType: 'image/png', fileName: `${name}.${variant}.png`, size: png.length,
      })
    }
    check(signal)
    const { asset } = await target(job.input, job)
    check(signal)
    const record = { ...asset, metadata: { ...asset.metadata,
      preview: { ...job.result, variant, spec: renderSpec(job.input) } } }
    // Node refs are the authoritative artifact identity; metadata is only a
    // last-published summary. Commit both through the host's revision CAS.
    // Legacy hosts can CAS the node alone: avoid a non-atomic metadata write
    // and rollback that could erase another node's publication.
    await updateNode(job, 'ready', signal, typeof ctx.canvas.publishPreview === 'function' ? record : undefined)
    // A failed CAS leaves an unreferenced, reusable artifact. No binary rollback
    // or asset-wide deletion is safe here; original and every other variant stay intact.
  }

  async function updateNode(job, status, signal, atomicAsset) {
    for (let attempt = 0; attempt < 3; attempt++) {
      check(signal)
      const { document, node, asset } = await target(job.input, status === 'ready' ? job : undefined)
      check(signal)
      const props = { previewStatus: status, previewError: status === 'error' ? job.error?.message || '文档预览失败' : null }
      const patch = { id: node.id, props, ...(job.detectedNodeType && job.detectedNodeType !== node.type ? { type: job.detectedNodeType } : {}) }
      if (job.detectedNodeType) props.fileExtension = 'zip'
      if (status === 'ready') {
        const { layoutWidth: width, layoutHeight: height, pageCount, warnings, cacheKey } = job.result
        const oldWidth = Number(node.props?.intrinsicWidth ?? node.intrinsicWidth)
        const oldHeight = Number(node.props?.intrinsicHeight ?? node.intrinsicHeight)
        const oldAspect = oldWidth > 0 && oldHeight > 0 ? oldHeight / oldWidth : null
        // Compare the latest size, not the size captured when the job was admitted.
        if (job.input.mode !== 'fixed-viewport' && oldAspect && node.width > 0 && Math.abs(node.height / node.width - oldAspect) <= Math.max(0.001, oldAspect * 0.005)) {
          patch.height = node.width * height / width
        }
        Object.assign(props, { previewQuality: job.input.quality, previewSpec: renderSpec(job.input), previewKey: cacheKey,
          intrinsicWidth: 320, intrinsicHeight: 320 * height / width, pageCount, previewWarnings: [...warnings] })
        const refs = Object.fromEntries(Object.entries(node.assetRefs || {}).filter(([key]) => key !== 'preview' && !key.startsWith('_documentPreview')))
        const variant = job.previewVariant
        if (variant !== `preview-${cacheKey}`) throw failure('PREVIEW_INVALID_CACHE_KEY', '预览产物引用与缓存标识不一致')
        refs.preview = { assetId: job.input.assetId, variant }
        refs[`_documentPreview${job.input.requestId}`] = { assetId: job.input.assetId, variant }
        patch.assetRefs = refs
      } else if (status === 'unsupported') { props.previewWarnings = [...job.result.warnings]; props.previewError = job.detectedNodeType === 'file'
        ? '压缩包中没有支持预览的模型文件，按 ZIP 文件保存。' : '此格式暂未提供内容预览，原文件已保存。' }
      try {
        const record = atomicAsset ? { ...asset, metadata: { ...asset.metadata, preview: atomicAsset.metadata.preview } } : undefined
        const written = record
          ? await ctx.canvas.publishPreview(job.input.boardId, { assetId: job.input.assetId, requestId: job.input.requestId,
            nodeId: job.input.nodeId, expectedRevision: document.revision, asset: record, patch })
          : await ctx.canvas.write(job.input.boardId, { expectedRevision: document.revision, operations: [{ type: 'update', nodes: [patch] }] })
        if (record) job.committedAsset = written?.asset || record
        job.committedPatch = structuredClone(patch)
        job.committedRevision = written?.revision ?? written?.document?.revision
        return
      } catch (error) {
        if (error?.code !== 'CANVAS_REVISION_CONFLICT' || attempt === 2) throw error
      }
    }
  }

  async function fontsFingerprint() {
    if (fontValue && Date.now() < fontExpires) return fontValue
    if (!fontPromise) fontPromise = (async () => {
      const roots = [...new Set([join(homedir(), 'Library', 'Fonts'), '/Library/Fonts', '/System/Library/Fonts',
        '/usr/share/fonts', '/usr/local/share/fonts', join(homedir(), '.fonts'), join(homedir(), '.local/share/fonts')])]
      const entries = []
      let visited = 0
      async function walk(directory, depth) {
        if (depth > 5 || visited >= 4096) return
        const children = await readdir(directory, { withFileTypes: true }).catch(() => [])
        children.sort((a, b) => a.name.localeCompare(b.name))
        for (const child of children) {
          if (++visited > 4096) break
          const path = join(directory, child.name)
          if (child.isDirectory()) await walk(path, depth + 1)
          else if (child.isFile() && /\.(ttf|otf|ttc|woff2?)$/i.test(child.name)) {
            const info = await stat(path).catch(() => null)
            if (info) entries.push([path, info.size, info.mtimeMs])
          }
        }
      }
      for (const root of roots) await walk(root, 0)
      return digest({ entries, platform: process.platform, fontConfig: process.env.FONTCONFIG_FILE || '',
        officeConfig: ctx.officeToPdf?.config || {} })
    })().finally(() => { fontPromise = undefined })
    const value = await fontPromise
    fontValue = value
    fontExpires = Date.now() + FONT_TTL
    return value
  }

  async function browser() {
    if (!browserPromise) {
      const pending = (async () => {
        let chromium
        try { ({ chromium } = await import('playwright')) } catch (error) {
          throw failure('PREVIEW_BROWSER_UNAVAILABLE', '未安装 Playwright，请由主项目安装预览依赖和 Chromium', error)
        }
        let instance
        try {
          instance = await chromium.launch({ headless: true, timeout: 20_000, args: [
            '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-pings',
            '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
          ] })
        } catch (error) { throw failure('PREVIEW_BROWSER_UNAVAILABLE', 'Chromium 启动失败，请确认主项目已安装浏览器', error) }
        if (disposed) { await instance.close(); throw failure('PREVIEW_DISPOSED', '文档预览服务已关闭') }
        instance.on('disconnected', () => { if (browserPromise === pending) browserPromise = undefined })
        return instance
      })()
      browserPromise = pending
      pending.catch(() => { if (browserPromise === pending) browserPromise = undefined })
    }
    return browserPromise
  }

  async function pdfFiles() {
    if (!pdfFilesPromise) pdfFilesPromise = (async () => {
      try {
        const modulePath = require.resolve('pdfjs-dist/build/pdf.mjs')
        const root = dirname(dirname(modulePath))
        return { root, module: await readFile(modulePath), worker: await readFile(join(dirname(modulePath), 'pdf.worker.mjs')) }
      } catch (error) { throw failure('PREVIEW_PDF_UNAVAILABLE', '未安装 PDF.js，请由主项目安装 pdfjs-dist', error) }
    })().catch(error => { pdfFilesPromise = undefined; throw error })
    return pdfFilesPromise
  }

  async function resolveVersions(job, assets) {
    if (typeof ctx.canvas.getBinaryVersion !== 'function') return
    job.versions ||= new Map()
    for (const asset of assets) {
      if (job.versions.has(asset.id)) continue
      const version = await abortable(ctx.canvas.getBinaryVersion(job.input.boardId, asset.id, 'original'), job.signal || lifetime.signal, RESOURCE_TIMEOUT)
      job.versions.set(asset.id, version || { contentHash: null })
      if (asset.metadata?.contentHash && asset.metadata.contentHash !== version?.contentHash) {
        throw failure('PREVIEW_STALE_REQUEST', '原始文件与上传记录不一致，请重新请求预览')
      }
    }
  }

  function keyManifest(job, assets) {
    return resourceManifest(assets).map(item => ({ ...item, contentHash: item.contentHash || job.versions?.get(item.assetId)?.contentHash || '' }))
  }

  async function resourceBinary(boardId, asset) {
    const version = typeof ctx.canvas.getBinaryVersion === 'function'
      ? await ctx.canvas.getBinaryVersion(boardId, asset.id, 'original') : null
    const hash = version?.contentHash || asset.metadata?.contentHash
    if (asset.metadata?.contentHash && version && asset.metadata.contentHash !== version.contentHash) {
      throw failure('PREVIEW_STALE_REQUEST', '原始文件与上传记录不一致，请重新请求预览')
    }
    return byteCache.get(hash ? JSON.stringify([boardId, asset.id, hash]) : null, async () => {
      const binary = await ctx.canvas.getBinary(boardId, asset.id, 'original')
      if (hash && binary?.data && sha(Buffer.from(binary.data)) !== hash) {
        throw failure('PREVIEW_STALE_REQUEST', '读取过程中原始文件已改变，请重新请求预览')
      }
      return binary
    })
  }

  function buildKey(job, asset, name, kind, contentHash, resources, legacyContents) {
    return digest({ version: RENDER_VERSION, contentHash, name, relativePath: asset.metadata?.relativePath || '', kind,
      spec: renderSpec(job.input), fonts: job.fontKey, resources: keyManifest(job, resources),
      legacyContents: resources.some(item => !item.metadata?.contentHash && !job.versions?.has(item.id)) ? legacyContents : undefined,
      boardId: ['html', 'markdown', 'model'].includes(kind) ? job.input.boardId : undefined,
      officeConfig: kind === 'office' ? ctx.officeToPdf?.config || {} : undefined })
  }

  function dependencyKey(job, asset, name) {
    return digest({ version: RENDER_VERSION, boardId: job.input.boardId, assetId: asset.id,
      hash: job.contentHash || asset.metadata?.contentHash, name, relativePath: asset.metadata?.relativePath || '' })
  }

  async function metadataCache(job, document, asset, name, kind) {
    if (!kind || (!asset.metadata?.contentHash && !ctx.canvas.getBinaryVersion)) return null
    const started = Date.now()
    try {
      await resolveVersions(job, [asset])
      job.contentHash = asset.metadata?.contentHash || job.versions?.get(asset.id)?.contentHash
      if (!job.contentHash) return null
      let resources = ['html', 'markdown'].includes(kind) ? document.assets || [] : []
      if (kind === 'model') {
        const path = join(cacheRoot, `${dependencyKey(job, asset, name)}.deps.json`)
        const info = await stat(path).catch(() => null)
        if (!info || info.size > 128 * 1024 || Date.now() - info.mtimeMs > CACHE_AGE) return null
        let dependencies
        try { dependencies = JSON.parse(await readFile(path, 'utf8')) } catch { return null }
        if (dependencies.references !== null && (!Array.isArray(dependencies.references) ||
            dependencies.references.length > 4096 || dependencies.references.some(ref => !Array.isArray(ref) || ref.length !== 2 || ref.some(value => typeof value !== 'string')))) return null
        resources = selectedModelAssets(document.assets, asset.id, dependencies.references)
        await resolveVersions(job, resources)
        if (digest(keyManifest(job, resources)) !== dependencies.digest) return null
        job.resourceReferences = dependencies.references
        if (extname(name).toLowerCase() === '.zip') job.detectedNodeType = 'model'
      }
      await resolveVersions(job, resources)
      if (resources.some(item => !item.metadata?.contentHash && !job.versions?.get(item.id)?.contentHash)) return null
      job.modelResourceChecks = [asset, ...resources].filter(item => job.versions?.get(item.id)?.contentHash).map(item => ({
        assetId: item.id, contentHash: job.versions.get(item.id).contentHash }))
      if (['html', 'markdown', 'model'].includes(kind)) {
        job.resourceKind = kind
        job.resourceDigest = digest(resourceManifest(resources))
      }
      const key = buildKey(job, asset, name, kind, job.contentHash, resources)
      const value = await readCache(key)
      if (value) { job.cache = 'metadata-disk'; await target(job.input, job) }
      return value
    } finally { job.timings.cache += Date.now() - started }
  }

  async function writeDependencies(job, asset, name) {
    // The digest captures the exact selection used for rendering, never a newer snapshot.
    await mkdir(cacheRoot, { recursive: true })
    const path = join(cacheRoot, `${dependencyKey(job, asset, name)}.deps.json`)
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ references: job.resourceReferences, digest: job.dependencyDigest }))
      await rename(temporary, path)
    } finally { await rm(temporary, { force: true }).catch(() => {}) }
  }

  async function collectModelResources(job, assets, source, name, signal) {
    const candidates = assets.filter(asset => asset.id !== job.input.assetId)
    const extension = extname(name).toLowerCase()
    const references = new Set()
    const pending = []
    const add = (reference, parent) => {
      const path = resolveModelReference(reference, parent)
      if (!path) return
      let fallback
      try { fallback = normalizeName(decodeURIComponent(reference.split(/[?#]/)[0])) } catch { fallback = normalizeName(reference) }
      const key = JSON.stringify([path, fallback])
      if (!references.has(key)) { references.add(key); pending.push({ path, fallback }) }
      if (references.size > 4096) throw failure('PREVIEW_MODEL_RESOURCE_LIMIT', '模型引用数量超过限制')
    }
    let precise = ['.gltf', '.glb', '.obj'].includes(extension)
    if (extension === '.gltf' || extension === '.glb') {
      let text = source.toString('utf8')
      if (extension === '.glb') {
        if (source.length < 20 || source.readUInt32LE(0) !== 0x46546c67) throw failure('PREVIEW_MODEL_INVALID_INPUT', 'GLB 文件头无效')
        let found = false
        for (let offset = 12; offset + 8 <= source.length;) {
          const length = source.readUInt32LE(offset)
          if (offset + 8 + length > source.length) throw failure('PREVIEW_MODEL_INVALID_INPUT', 'GLB JSON 数据越界')
          if (source.readUInt32LE(offset + 4) === 0x4e4f534a) { text = source.subarray(offset + 8, offset + 8 + length).toString('utf8').replace(/\0+$/, ''); found = true; break }
          offset += 8 + length
        }
        if (!found) throw failure('PREVIEW_MODEL_INVALID_INPUT', 'GLB 缺少 JSON 数据')
      }
      const json = JSON.parse(text)
      const visit = value => {
        if (!value || typeof value !== 'object') return
        for (const [key, child] of Object.entries(value)) {
          if (key === 'uri' && typeof child === 'string') add(child, name)
          else if (child && typeof child === 'object') visit(child)
        }
      }
      visit(json)
    } else if (extension === '.obj') {
      for (const line of source.toString('utf8').split(/\r?\n/)) {
        const match = /^\s*mtllib\s+(.+?)\s*$/i.exec(line)
        if (!match) continue
        const full = match[1].replace(/\s+#.*$/, '').replace(/^"|"$/g, '')
        const path = resolveModelReference(full, name)
        if (path && matchingModelAssets(candidates, { path, fallback: normalizeName(full) }).length) add(full, name)
        else for (const token of full.match(/"[^"]+"|\S+/g) || []) add(token.replace(/^"|"$/g, ''), name)
      }
    }
    const data = new Map(), manifest = [], checks = [], warnings = []
    let total = source.length
    const selected = new Map()
    const materialContexts = new Set()
    async function load(asset, requestedPath) {
      if (!asset) return
      const material = extname(asset.metadata?.relativePath || asset.metadata?.fileName || asset.metadata?.name || '').toLowerCase() === '.mtl'
      const context = JSON.stringify([asset.id, requestedPath || ''])
      const alreadyLoaded = selected.has(asset.id)
      if (alreadyLoaded && (!material || materialContexts.has(context))) return
      materialContexts.add(context)
      selected.set(asset.id, asset)
      if (selected.size > MAX_MODEL_RESOURCES) throw failure('PREVIEW_MODEL_RESOURCE_LIMIT', '模型关联资源数量超过限制')
      check(signal)
      const resource = await abortable(resourceBinary(job.input.boardId, asset), signal, RESOURCE_TIMEOUT)
      if (!resource?.data) {
        warnings.push(`同画布资源缺少原文件：${asset.metadata?.relativePath || asset.metadata?.name || asset.id}`)
        manifest.push({ assetId: asset.id, missing: true })
        checks.push({ assetId: asset.id, contentHash: null })
        return
      }
      const bytes = Buffer.from(resource.data)
      if (!alreadyLoaded) total += bytes.length
      if (bytes.length > MAX_INPUT_BYTES || total > MAX_MODEL_BYTES) throw failure('PREVIEW_MODEL_RESOURCE_LIMIT', '模型与关联资源合计不能超过 128 MB，单个资源不能超过 64 MB')
      const contentHash = sha(bytes)
      if (job.versions?.has(asset.id) && job.versions.get(asset.id).contentHash !== contentHash) throw failure('PREVIEW_STALE_REQUEST', '模型关联资源已改变，请重新请求预览')
      if (asset.metadata?.contentHash && asset.metadata.contentHash !== contentHash) throw failure('PREVIEW_STALE_REQUEST', '模型关联资源与上传记录不一致，请重新请求预览')
      if (!alreadyLoaded && !asset.metadata?.contentHash) checks.push({ assetId: asset.id, contentHash })
      data.set(asset.id, bytes)
      if (!alreadyLoaded) manifest.push({ assetId: asset.id, contentHash })
      if (precise && material) {
        const parent = requestedPath || asset.metadata?.relativePath || asset.metadata?.fileName || asset.metadata?.name
        for (const line of bytes.toString('utf8').split(/\r?\n/)) {
          const match = /^\s*(?:map_\w+|bump|disp|decal|norm|refl)\s+(.+?)\s*$/i.exec(line)
          if (!match) continue
          // Standard MTL option arities. Unknown syntax falls back to conservative candidates.
          const tokens = match[1].replace(/\s+#.*$/, '').match(/"[^"]+"|\S+/g) || []
          let i = 0
          while (tokens[i]?.startsWith('-')) {
            const option = tokens[i++].toLowerCase()
            if (['-o', '-s', '-t'].includes(option)) {
              let n = 0
              while (n < 3 && i < tokens.length && Number.isFinite(Number(tokens[i]))) { i++; n++ }
            } else if (option === '-mm') i += 2
            else if (['-blendu', '-blendv', '-boost', '-bm', '-cc', '-clamp', '-imfchan', '-texres', '-type', '-colorspace'].includes(option)) i++
            else { precise = false; break }
          }
          if (precise) add(tokens.slice(i).join(' ').replace(/^"|"$/g, ''), parent)
        }
      }
    }
    if (precise) {
      for (let i = 0; i < pending.length; i++) {
        const reference = pending[i]
        const matches = matchingModelAssets(candidates, reference)
        if (!matches.length) warnings.push(`缺少模型引用资源：${reference.path}`)
        for (const asset of matches) await load(asset, reference.path)
      }
    }
    if (!precise) for (const asset of modelResourceAssets(assets, job.input.assetId)) await load(asset)
    job.resourceReferences = precise ? [...references].sort().map(key => JSON.parse(key)) : null
    const selectedAssets = selectedModelAssets(assets, job.input.assetId, job.resourceReferences)
    await resolveVersions(job, selectedAssets)
    job.dependencyDigest = digest(keyManifest(job, selectedAssets))
    const resources = Object.create(null)
    for (const asset of selected.values()) {
      const path = normalizeName(asset.metadata?.relativePath || asset.metadata?.fileName || asset.metadata?.name)
      if (!path || !data.has(asset.id)) continue
      if (Object.keys(resources).some(key => key.toLowerCase() === path.toLowerCase())) {
        throw failure('PREVIEW_MODEL_INVALID_INPUT', `模型资源路径重复：${path}`)
      }
      resources[path] = data.get(asset.id)
    }
    manifest.sort((a, b) => String(a.assetId).localeCompare(String(b.assetId)))
    return { resources, manifest: { contents: manifest }, checks, warnings }
  }

  async function convertedOfficePdf(job, bytes, name, contentHash, signal) {
    if (!ctx.officeToPdf?.convert) throw failure('PREVIEW_OFFICE_UNAVAILABLE', 'Office 转 PDF 服务未启用，暂时无法预览此文件')
    const extension = extname(name).slice(1).toLowerCase()
    const key = digest({ version: RENDER_VERSION, contentHash, extension,
      officeConfig: ctx.officeToPdf.config || {}, fonts: job.fontKey })
    let flight = officeFlights.get(key)
    if (flight?.controller.signal.aborted) {
      await abortable(flight.promise.catch(() => {}), signal)
      check(signal)
      return convertedOfficePdf(job, bytes, name, contentHash, signal)
    }
    if (!flight) {
      const controller = new AbortController()
      const cancel = () => controller.abort(lifetime.signal.reason)
      lifetime.signal.addEventListener('abort', cancel, { once: true })
      if (lifetime.signal.aborted) cancel()
      const timer = setTimeout(() => controller.abort(failure('PREVIEW_TIMEOUT', 'Office 转 PDF 超时')), JOB_TIMEOUT)
      timer.unref?.()
      flight = { controller, consumers: 0, done: false }
      flight.promise = officeCache.get(key, async () => {
        const converted = await abortable(ctx.officeToPdf.convert({ extension, priority: 'foreground', source: {
          key: JSON.stringify(['canvas', job.input.boardId, job.input.assetId]), version: contentHash, bytes: bytes.length,
          read: async (readSignal, maxBytes) => {
            check(readSignal)
            check(controller.signal)
            if (Number.isFinite(maxBytes) && bytes.length > maxBytes) throw failure('PREVIEW_INPUT_TOO_LARGE', '文件超出 Office 转换服务的大小限制')
            return { bytes: new Uint8Array(bytes), version: contentHash }
          },
        } }, controller.signal), controller.signal)
        check(controller.signal)
        if (!converted?.pdf?.length) throw failure('PREVIEW_OFFICE_FAILED', 'Office 转换服务没有返回有效 PDF')
        if (converted.pdf.length > 100 * 1024 * 1024) throw failure('PREVIEW_OUTPUT_TOO_LARGE', '转换后的 PDF 过大，暂时无法预览')
        const data = Buffer.from(converted.pdf)
        return { data, contentHash: sha(data), missingFonts: [...new Set((converted.missingFonts || []).slice(0, 64).map(font => String(font).slice(0, 512)))].sort() }
      }).finally(() => {
        flight.done = true
        clearTimeout(timer)
        lifetime.signal.removeEventListener('abort', cancel)
        if (officeFlights.get(key) === flight) officeFlights.delete(key)
      })
      officeFlights.set(key, flight)
    }
    flight.consumers++
    try { return await abortable(flight.promise, signal) }
    finally {
      if (--flight.consumers === 0 && !flight.done) {
        flight.controller.abort(failure('PREVIEW_CANCELLED', 'Office 转换已取消'))
        // Keep the rejected cache load registered until its finally removes pending.
      }
    }
  }

  async function renderDocument(options) {
    const { job, name, kind, contentHash, signal, baseKey } = options
    let bytes = options.bytes
    const warnings = new Set()
    let key = baseKey
    let pdf
    if (kind === 'model') {
      const dimensions = outputSize(job.input.width, job.input.height, job.input.quality)
      const rendered = await modelRenderer.render({ bytes, fileName: normalizeName(options.relativePath || name),
        resources: options.modelResources.resources, width: dimensions.width, height: dimensions.height,
        signal, timeout: JOB_TIMEOUT / 1000 })
      for (const warning of [...options.modelResources.warnings, ...rendered.warnings]) warn(warnings, warning)
      return { png: rendered.png, timings: rendered.timings, result: { ...dimensions, layoutWidth: job.input.width, layoutHeight: job.input.height,
        pageCount: 1, warnings: [...warnings], cacheKey: key } }
    }
    if (kind === 'office') {
      const converted = await convertedOfficePdf(job, bytes, name, contentHash, signal)
      bytes = converted.data
      for (const font of converted.missingFonts) warn(warnings, `缺少字体：${font}，排版可能与原文档不同`)
      key = digest({ baseKey, pdf: converted.contentHash, missingFonts: converted.missingFonts })
    }
    if (kind === 'pdf' || kind === 'office') {
      try {
        const rendered = await pdfRenderer.render({ bytes, width: job.input.width, height: job.input.height,
          page: job.input.page, quality: job.input.quality, mode: job.input.mode, signal, timeout: JOB_TIMEOUT })
        check(signal)
        for (const warning of rendered.warnings || []) warn(warnings, warning)
        return { png: rendered.png, timings: rendered.timings, result: { width: rendered.width, height: rendered.height,
          ...pdfLayout(job.input, rendered), pageCount: rendered.pageCount,
          warnings: [...warnings], cacheKey: key } }
      } catch (error) {
        // Never reinterpret a corrupt/password-protected document or a worker crash as a dependency failure.
        if (!['PREVIEW_PDF_UNAVAILABLE', 'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(error?.code)) throw error
        check(signal)
        warn(warnings, '原生 PDF 渲染依赖不可用，使用浏览器渲染')
        pdf = await pdfFiles()
      }
    }
    const html = pdf ? pdfShell() : await documentHtml(bytes.toString('utf8'), kind)
    check(signal)
    const instance = await abortable(browser(), signal)
    // External requests are fulfilled through public, DNS-pinned IPs. HTTPS IP requests need this
    // because certificates name the original host; no cookies or credentials leave this context.
    // All browser-rendered documents retain text detail without changing CSS layout.
    const crispDocument = !pdf
    const maxDocumentHeight = job.input.mode === 'fixed-viewport' ? job.input.height
      : Math.max(1, Math.min(job.input.width * 5, Math.floor(MAX_PIXELS / job.input.width)))
    const rasterScale = crispDocument ? Math.min(2, Math.sqrt((MAX_PIXELS - job.input.width - maxDocumentHeight) / (job.input.width * maxDocumentHeight))) : 1
    const context = await instance.newContext({ viewport: { width: job.input.width, height: job.input.height },
      deviceScaleFactor: rasterScale, javaScriptEnabled: true, serviceWorkers: 'block', acceptDownloads: false,
      ignoreHTTPSErrors: true, reducedMotion: 'reduce', colorScheme: 'light' })
    contexts.add(context)
    const close = () => { void context.close().catch(() => {}) }
    signal.addEventListener('abort', close, { once: true })
    try {
      check(signal)
      const page = await context.newPage()
      page.setDefaultTimeout(12_000)
      page.setDefaultNavigationTimeout(15_000)
      page.on('popup', popup => { void popup.close().catch(() => {}) })
      page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}) })
      page.on('console', message => { if (message.type() === 'warning' && /font/i.test(message.text())) warn(warnings, message.text()) })
      page.on('pageerror', error => warn(warnings, `页面脚本错误：${error.message}`))
      page.on('requestfailed', req => warn(warnings, `资源加载失败：${safeResource(req.url())}`))
      const rootPath = '/' + encodePath(normalizeName(options.relativePath || name) || 'document.html')
      const resources = indexResources(options.assets)
      const dnsCache = new Map()
      let resourceCount = 0
      await context.route('**/*', async route => {
        const req = route.request()
        try {
          check(signal)
          const url = new URL(req.url())
          if (!['GET', 'HEAD'].includes(req.method())) return await route.abort('blockedbyclient')
          if (req.isNavigationRequest() && (req.frame() !== page.mainFrame() || url.origin !== ORIGIN || url.pathname !== rootPath)) {
            warn(warnings, '已阻止文档跳转或嵌入其他页面')
            return await route.abort('blockedbyclient')
          }
          if (++resourceCount > 256) { warn(warnings, '资源数量超过预览限制'); return await route.abort('blockedbyclient') }
          if (url.origin === ORIGIN) {
            if (url.pathname === rootPath && req.isNavigationRequest()) return await route.fulfill({ contentType: 'text/html; charset=utf-8', body: html })
            if (pdf && url.pathname.startsWith('/__preview_pdf__/')) {
              const relative = decodeURIComponent(url.pathname.slice('/__preview_pdf__/'.length))
              if (relative === 'pdf.mjs') return await route.fulfill({ contentType: 'text/javascript', body: pdf.module })
              if (relative === 'pdf.worker.mjs') return await route.fulfill({ contentType: 'text/javascript', body: pdf.worker })
              if (relative === 'source.pdf') return await route.fulfill({ contentType: 'application/pdf', body: bytes })
              if (/^(cmaps|standard_fonts|wasm)\/[\w.-]+$/.test(relative)) {
                const file = join(pdf.root, relative)
                const info = await stat(file)
                const body = await byteCache.get(JSON.stringify([file, info.size, info.mtimeMs]), () => readFile(file))
                return await route.fulfill({ contentType: relative.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream', body })
              }
              return await route.fulfill({ status: 404, body: '' })
            }
            const path = normalizeName(decodeURIComponent(url.pathname))
            const asset = resources.get(path) || resources.get(path.split('/').pop())
            if (!asset) { warn(warnings, `缺少本地资源：${path}`); return await route.fulfill({ status: 404, body: '' }) }
            const resource = await abortable(resourceBinary(job.input.boardId, asset), signal, RESOURCE_TIMEOUT)
            if (!resource?.data) { warn(warnings, `本地资源不存在：${path}`); return await route.fulfill({ status: 404, body: '' }) }
            if (resource.data.length > MAX_INPUT_BYTES) { warn(warnings, `本地资源过大：${path}`); return await route.abort('blockedbyclient') }
            return await route.fulfill({ contentType: resourceMime(resource.mimeType, path), body: resource.data })
          }
          if (pdf) return await route.abort('blockedbyclient')
          const address = await publicAddress(url, dnsCache, signal)
          const pinned = new URL(url)
          pinned.hostname = address.includes(':') ? `[${address}]` : address
          const headers = { ...req.headers(), host: url.host }
          for (const key of Object.keys(headers)) {
            if (/cookie|authorization|^proxy-|^x-dsh|^x-api-key/i.test(key)) delete headers[key]
          }
          const response = await route.fetch({ url: pinned.href, headers, timeout: RESOURCE_TIMEOUT, maxRedirects: 0, maxRetries: 0 })
          const responseHeaders = response.headers()
          delete responseHeaders['set-cookie']
          if (Number(responseHeaders['content-length']) > MAX_INPUT_BYTES) return await route.abort('blockedbyclient')
          if (response.status() >= 400) warn(warnings, `外部资源返回 ${response.status()}：${safeResource(url.href)}`)
          // The browser follows redirects at the original URL; every redirected request is checked again.
          return await route.fulfill({ response, headers: responseHeaders })
        } catch (error) {
          if (!signal.aborted) warn(warnings, `资源无法加载：${safeResource(req.url())}（${error?.message || '加载失败'}）`)
          await route.abort('blockedbyclient').catch(() => {})
        }
      })
      // Block WebSockets as well as HTTP: HTML scripts cannot reach a local DSH service.
      if (typeof context.routeWebSocket === 'function') await context.routeWebSocket(/.*/, socket => socket.close())
      else await context.addInitScript(() => {
        globalThis.WebSocket = class { constructor() { throw new Error('预览中禁用 WebSocket') } }
      })
      await context.addInitScript(() => {
        try { delete globalThis.RTCPeerConnection; delete globalThis.webkitRTCPeerConnection } catch { /* no WebRTC networking */ }
      })
      await page.goto(`${ORIGIN}${rootPath}`, { waitUntil: 'domcontentloaded' })
      let width = job.input.width
      let height = job.input.height
      let layoutWidth = width
      let layoutHeight = height
      let pageCount = 1
      if (pdf) {
        ;({ width, height } = outputSize(width, height, job.input.quality))
        const rendered = await page.evaluate(async ({ width, height, layoutWidth, layoutHeight, page, fixed }) => {
          const pdfjs = await import('/__preview_pdf__/pdf.mjs')
          pdfjs.GlobalWorkerOptions.workerSrc = '/__preview_pdf__/pdf.worker.mjs'
          const loading = pdfjs.getDocument({ url: '/__preview_pdf__/source.pdf',
            cMapUrl: '/__preview_pdf__/cmaps/', cMapPacked: true,
            standardFontDataUrl: '/__preview_pdf__/standard_fonts/', wasmUrl: '/__preview_pdf__/wasm/',
            isEvalSupported: false, maxImageSize: 8_000_000, stopAtErrors: false })
          const document = await loading.promise
          try {
            if (page > document.numPages) throw new Error(`PDF 只有 ${document.numPages} 页，无法预览第 ${page} 页`)
            const selected = await document.getPage(page)
            const natural = selected.getViewport({ scale: 1 })
            const scale = Math.min(width / natural.width, height / natural.height, Math.sqrt(8_000_000 / (natural.width * natural.height)))
            if (!(scale > 0) || !Number.isFinite(scale)) throw new Error('PDF 页面尺寸无效')
            const viewport = selected.getViewport({ scale })
            const canvas = documentElementCanvas()
            canvas.width = fixed ? width : Math.max(1, Math.floor(viewport.width))
            canvas.height = fixed ? height : Math.max(1, Math.floor(viewport.height))
            const transform = fixed ? [1, 0, 0, 1, (width - viewport.width) / 2, (height - viewport.height) / 2] : undefined
            await selected.render({ canvasContext: canvas.getContext('2d'), viewport, transform, background: '#ffffff' }).promise
            const layoutScale = Math.min(layoutWidth / natural.width, layoutHeight / natural.height)
            return { width: canvas.width, height: canvas.height,
              layoutWidth: fixed ? layoutWidth : Math.max(1, Math.floor(natural.width * layoutScale)),
              layoutHeight: fixed ? layoutHeight : Math.max(1, Math.floor(natural.height * layoutScale)), pageCount: document.numPages }
          } finally { await document.destroy() }
          function documentElementCanvas() { return globalThis.document.getElementById('pdf-preview') }
        }, { width, height, layoutWidth, layoutHeight, page: job.input.page, fixed: job.input.mode === 'fixed-viewport' })
        ;({ width, height, layoutWidth, layoutHeight, pageCount } = rendered)
        await page.setViewportSize({ width, height })
      } else {
        await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}html{scroll-behavior:auto!important}' })
        const readiness = await page.evaluate(async () => {
          const bounded = (promise, ms) => Promise.race([promise.then(() => true, () => false), new Promise(resolve => setTimeout(() => resolve(false), ms))])
          const [fontsReady, imagesReady] = await Promise.all([
            document.fonts ? bounded(document.fonts.ready, 3000) : Promise.resolve(true),
            bounded(Promise.all([...document.images].map(image => image.complete ? Promise.resolve() :
              new Promise(resolve => { image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', resolve, { once: true }) }))), 3000),
          ])
          for (const animation of document.getAnimations()) { try { animation.pause() } catch { /* ignore */ } }
          await new Promise(resolve => setTimeout(resolve, 200))
          const root = document.documentElement
          const body = document.body
          // Bounding the content rather than scrollHeight lets short text produce a natural thumbnail.
          const range = document.createRange()
          if (body) range.selectNodeContents(body)
          const bounds = range.getBoundingClientRect()
          const naturalHeight = Math.max(bounds.bottom + (body ? parseFloat(getComputedStyle(body).paddingBottom) || 0 : 0),
            body?.getBoundingClientRect().bottom || 0, root.scrollHeight > innerHeight ? root.scrollHeight : 0)
          return { fontsReady, imagesReady, naturalHeight }
        })
        if (!readiness.fontsReady) warn(warnings, '字体加载超时，预览可能使用替代字体')
        if (!readiness.imagesReady) warn(warnings, '部分图片加载超时')
        if (job.input.mode !== 'fixed-viewport' && readiness.naturalHeight > 0) height = Math.min(maxDocumentHeight, Math.max(1, Math.ceil(readiness.naturalHeight)))
        // Chromium must expose the entire requested clip, not the initial short viewport.
        // Otherwise it can return a short raster while layout metadata describes a tall one.
        await page.setViewportSize({ width, height })
      }
      check(signal)
      let png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height }, captureBeyondViewport: true, animations: 'disabled', timeout: 12_000 })
      if (!pdf) {
        layoutWidth = width
        layoutHeight = height
        const actualWidth = png.readUInt32BE(16)
        const actualHeight = png.readUInt32BE(20)
        if (Math.abs(actualWidth - layoutWidth * rasterScale) > 1 ||
            Math.abs(actualHeight - layoutHeight * rasterScale) > 1) {
          throw failure('PREVIEW_CAPTURE_SIZE_MISMATCH', '预览截图尺寸与文档尺寸不一致，请重试')
        }
        width = actualWidth
        height = actualHeight
      }
      return { png, result: { width, height, layoutWidth, layoutHeight, pageCount, warnings: [...warnings], cacheKey: key } }
    } finally {
      signal.removeEventListener('abort', close)
      await context.close().catch(error => diagnostic('关闭预览浏览器上下文失败', error))
      contexts.delete(context)
    }
  }

  async function readCache(key) {
    try {
      const info = await stat(join(cacheRoot, `${key}.json`))
      if (Date.now() - info.mtimeMs > CACHE_AGE || info.size > 128 * 1024) return null
      const result = JSON.parse(await readFile(join(cacheRoot, `${key}.json`), 'utf8'))
      if (!Number.isInteger(result.layoutWidth) || !Number.isInteger(result.layoutHeight) || result.layoutWidth < 1 || result.layoutHeight < 1 ||
          result.layoutWidth * result.layoutHeight > MAX_PIXELS || !Number.isInteger(result.width) || !Number.isInteger(result.height) || result.width < 1 || result.height < 1 ||
          result.width * result.height > MAX_PIXELS || !Number.isInteger(result.pageCount) || result.pageCount < 1 ||
          !/^[a-f0-9]{64}$/.test(result.cacheKey) || !Array.isArray(result.warnings)) return null
      const pngInfo = await stat(join(cacheRoot, `${key}.png`))
      if (pngInfo.size > MAX_INPUT_BYTES) return null
      const png = await readFile(join(cacheRoot, `${key}.png`))
      if (png.length < 24 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
          png.readUInt32BE(16) !== result.width || png.readUInt32BE(20) !== result.height) return null
      return { png, result }
    } catch (error) {
      if (error?.code !== 'ENOENT') diagnostic('忽略无效预览缓存', error)
      return null
    }
  }

  async function writeCache(key, value) {
    await mkdir(cacheRoot, { recursive: true })
    const temporary = join(cacheRoot, `${key}.${randomUUID()}`)
    try {
      await writeFile(`${temporary}.png.tmp`, value.png)
      await writeFile(`${temporary}.json.tmp`, JSON.stringify(value.result))
      await rename(`${temporary}.png.tmp`, join(cacheRoot, `${key}.png`))
      await rename(`${temporary}.json.tmp`, join(cacheRoot, `${key}.json`))
    } finally {
      await Promise.allSettled([rm(`${temporary}.png.tmp`, { force: true }), rm(`${temporary}.json.tmp`, { force: true })])
    }
  }

  function cleanupCache() {
    if (cleanupPromise) { cleanupAgain = true; return }
    cleanupPromise = (async () => {
      const allNames = (await readdir(cacheRoot).catch(() => [])).sort()
      let start = allNames.findIndex(name => name > cleanupCursor)
      if (start < 0) start = 0
      const names = allNames.slice(start, start + 2048)
      cleanupCursor = names.at(-1) || ''
      const entries = []
      const dependencies = []
      for (const name of names) {
        if (/^[a-f0-9]{64}\.[a-f0-9-]+\.(png|json)\.tmp$/.test(name)) {
          const info = await stat(join(cacheRoot, name)).catch(() => null)
          if (info && Date.now() - info.mtimeMs > JOB_TIMEOUT * 2) await rm(join(cacheRoot, name), { force: true })
          continue
        }
        if (/^[a-f0-9]{64}\.deps\.json$/.test(name)) {
          const info = await stat(join(cacheRoot, name)).catch(() => null)
          if (info) dependencies.push({ name, time: info.mtimeMs })
          continue
        }
        if (/^[a-f0-9]{64}\.deps\.json\.[a-f0-9-]+\.tmp$/.test(name)) {
          const info = await stat(join(cacheRoot, name)).catch(() => null)
          if (info && Date.now() - info.mtimeMs > JOB_TIMEOUT * 2) await rm(join(cacheRoot, name), { force: true })
          continue
        }
        if (!/^[a-f0-9]{64}\.png$/.test(name)) continue
        const key = name.slice(0, -4)
        const [png, json] = await Promise.all([stat(join(cacheRoot, name)).catch(() => null), stat(join(cacheRoot, `${key}.json`)).catch(() => null)])
        if (png) entries.push({ key, size: png.size + (json?.size || 0), time: json?.mtimeMs || png.mtimeMs, incomplete: !json })
      }
      dependencies.sort((a, b) => b.time - a.time)
      for (const [index, entry] of dependencies.entries()) {
        if (index >= MAX_CACHE_ENTRIES || Date.now() - entry.time > CACHE_AGE) await rm(join(cacheRoot, entry.name), { force: true })
      }
      entries.sort((a, b) => a.time - b.time)
      let bytes = entries.reduce((total, entry) => total + entry.size, 0)
      let count = entries.length
      for (const entry of entries) {
        if (renderFlights.has(entry.key)) continue
        if (!entry.incomplete && Date.now() - entry.time <= CACHE_AGE && count <= MAX_CACHE_ENTRIES && bytes <= MAX_CACHE_BYTES) continue
        await Promise.all([rm(join(cacheRoot, `${entry.key}.png`), { force: true }), rm(join(cacheRoot, `${entry.key}.json`), { force: true })])
        bytes -= entry.size
        count--
      }
    })().catch(error => diagnostic('清理预览缓存失败', error)).finally(() => {
      cleanupPromise = undefined
      if (cleanupAgain && !disposed) { cleanupAgain = false; cleanupCache() }
    })
  }

  function dispose() {
    if (disposal) return disposal
    disposed = true
    lifetime.abort(failure('PREVIEW_DISPOSED', '文档预览服务已关闭'))
    emit({ type: 'closed', emittedAt: Date.now() })
    listeners.clear()
    for (const job of scheduler.close()) {
      if (job.status === 'superseded') continue
      job.status = 'error'
      job.error = { code: 'PREVIEW_DISPOSED', message: '文档预览服务已关闭' }
      job.timings.total = Date.now() - job.createdAt
      recordPerformance(job)
    }
    disposal = (async () => {
      await Promise.allSettled([modelRenderer.dispose().catch(error => diagnostic('关闭模型预览处理器失败', error)),
        pdfRenderer.dispose().catch(error => diagnostic('关闭 PDF 预览处理器失败', error)),
        ...[...contexts].map(context => context.close())])
      const instance = await browserPromise?.catch(() => undefined)
      await instance?.close().catch(error => diagnostic('关闭预览浏览器失败', error))
      await Promise.allSettled([...active, ...[...renderFlights.values(), ...officeFlights.values()].map(flight => flight.promise), ...assetLocks.values(), ...(cleanupPromise ? [cleanupPromise] : [])])
      contexts.clear()
      byteCache.clear()
      officeCache.clear()
      await journal.close()
    })()
    return disposal
  }

  return { request, status: id => snapshot(jobs.get(id)), dispose, reportVisibility,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('预览订阅必须是函数')
      if (disposed) { listener({ type: 'closed', emittedAt: Date.now() }); return () => {} }
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    recent(boardId) {
      pruneJobs()
      return [...jobs.values()].filter(job => job.input.boardId === boardId && job.terminalEvent)
        .map(job => structuredClone(job.terminalEvent))
    },
  }
}

function normalizeInput(input) {
  if (!input || typeof input !== 'object') throw new TypeError('预览请求必须是对象')
  const result = {}
  for (const key of ['boardId', 'assetId', 'nodeId', 'requestId']) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 1024) throw new TypeError(`预览请求缺少有效的 ${key}`)
    result[key] = input[key]
  }
  const dimension = (value, fallback) => {
    if (value === undefined || value === null) return fallback
    const number = Number(value)
    if (!Number.isFinite(number) || number <= 0) throw new TypeError('预览宽高必须为正数')
    return Math.max(1, Math.min(4096, Math.round(number)))
  }
  result.width = dimension(input.width, 1024)
  result.height = dimension(input.height, 704)
  if (result.width * result.height > MAX_PIXELS) {
    const scale = Math.sqrt(MAX_PIXELS / (result.width * result.height))
    result.width = Math.max(1, Math.floor(result.width * scale))
    result.height = Math.max(1, Math.floor(result.height * scale))
  }
  result.quality = input.quality ?? 'thumbnail'
  if (!['thumbnail', 'detail'].includes(result.quality)) throw new TypeError('预览 quality 必须为 thumbnail 或 detail')
  result.priority = [0, 1, 2].includes(input.priority) ? input.priority : 1
  result.page = input.page === undefined ? 1 : Number(input.page)
  if (!Number.isSafeInteger(result.page) || result.page < 1) throw new TypeError('预览页码必须为正整数')
  result.mode = input.mode === undefined ? 'viewport' : input.mode
  if (typeof result.mode !== 'string' || !result.mode || result.mode.length > 64) throw new TypeError('预览 mode 必须是有效字符串')
  return result
}

function renderSpec(input) { return { width: input.width, height: input.height, page: input.page, mode: input.mode, quality: input.quality } }
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function digest(value) { return sha(JSON.stringify(value)) }
function failure(code, message, cause) { return Object.assign(new Error(message, cause ? { cause } : undefined), { code }) }
function check(signal) { if (signal.aborted) throw signal.reason || failure('PREVIEW_CANCELLED', '预览已取消') }
function abortable(promise, signal, timeout) {
  return new Promise((resolve, reject) => {
    let timer
    const cancel = () => done(reject, signal.reason || failure('PREVIEW_CANCELLED', '预览已取消'))
    function done(settle, value) { clearTimeout(timer); signal.removeEventListener('abort', cancel); settle(value) }
    signal.addEventListener('abort', cancel, { once: true })
    Promise.resolve(promise).then(value => done(resolve, value), error => done(reject, error))
    if (timeout) { timer = setTimeout(() => done(reject, failure('PREVIEW_RESOURCE_TIMEOUT', '资源加载超时')), timeout); timer.unref?.() }
    if (signal.aborted) cancel()
  })
}
function warn(warnings, value) { if (warnings.size < 64) warnings.add(String(value).slice(0, 512)) }
function friendlyError(error) {
  if (error?.code?.startsWith('PREVIEW_')) return error.message
  if (error?.code === 'CANVAS_REVISION_CONFLICT') return '画布持续变化，预览保存失败，请重试'
  const messages = { 'input-too-large': 'Office 文件过大', 'output-too-large': '转换结果过大', 'invalid-document': 'Office 文件损坏或无法解析',
    'unsupported-format': 'Office 文件格式不受支持', 'invalid-output': 'Office 转换结果无效', timeout: 'Office 转换超时',
    unavailable: 'Office 转换服务不可用', busy: 'Office 转换服务繁忙', 'source-changed': '原始文件已经改变，请重试' }
  if (messages[error?.code]) return messages[error.code]
  return `文档预览失败：${String(error?.message || error).slice(0, 400)}`
}
function normalizeName(value) {
  const parts = String(value || '').normalize('NFC').replaceAll('\\', '/').split('/')
  const clean = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') clean.pop()
    else clean.push(part)
  }
  return clean.join('/')
}
function encodePath(value) { return value.split('/').map(encodeURIComponent).join('/') }
function resourceManifest(assets = []) {
  return assets.map(asset => ({ assetId: asset.id, contentHash: asset.metadata?.contentHash || '',
    mimeType: asset.metadata?.mimeType || '', fileName: asset.metadata?.fileName || asset.metadata?.name || '', relativePath: asset.metadata?.relativePath || '', size: asset.metadata?.size || 0 }))
    .sort((a, b) => String(a.assetId).localeCompare(String(b.assetId)))
}
function modelResourceAssets(assets = [], originalId) {
  // Videos, documents and other model originals cannot be textures/materials.
  // They must not consume this model's resource budget or invalidate its cache.
  return assets.filter(asset => asset.id !== originalId && MODEL_RESOURCE_FORMATS.has(
    extname(asset.metadata?.relativePath || asset.metadata?.fileName || asset.metadata?.name || '').slice(1).toLowerCase()))
}
function indexResources(assets) {
  const result = new Map()
  const aliases = new Map()
  for (const asset of [...assets].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const value = asset.metadata?.relativePath || asset.metadata?.fileName || asset.metadata?.name
    if (!value) continue
    const name = normalizeName(value)
    if (!name) continue
    if (!result.has(name)) result.set(name, asset)
    else if (result.get(name)?.id !== asset.id) result.set(name, null)
    const basename = name.split('/').pop()
    if (!aliases.has(basename)) aliases.set(basename, asset)
    else if (aliases.get(basename)?.id !== asset.id) aliases.set(basename, null)
  }
  for (const [name, asset] of result) if (!asset) result.delete(name)
  for (const [name, asset] of aliases) {
    // A bare name is an alias only when exactly one asset owns that basename.
    if (asset && !result.has(name)) result.set(name, asset)
  }
  return result
}
function classify(name, mime = '') {
  const extension = extname(name).slice(1).toLowerCase()
  if (MODEL_FORMATS.has(extension)) return 'model'
  if (OFFICE.has(extension)) return 'office'
  if (extension === 'pdf' || mime.split(';')[0] === 'application/pdf') return 'pdf'
  if (['html', 'htm'].includes(extension) || mime.startsWith('text/html')) return 'html'
  if (['md', 'markdown'].includes(extension) || mime.startsWith('text/markdown')) return 'markdown'
  if (extension === 'json' || mime.includes('application/json')) return 'json'
  if (extension === 'csv' || mime.startsWith('text/csv')) return 'csv'
  if (TEXT.has(extension) || mime.startsWith('text/plain')) return 'text'
  return null
}
function resourceMime(mime, name) {
  const types = { css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', svg: 'image/svg+xml', png: 'image/png',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf' }
  return (!mime || mime === 'application/octet-stream') ? types[extname(name).slice(1).toLowerCase()] || 'application/octet-stream' : mime
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])) }
async function documentHtml(text, kind) {
  if (kind === 'html') return text
  let body
  if (kind === 'markdown') {
    let MarkdownIt
    try { ({ default: MarkdownIt } = await import('markdown-it')) } catch (error) {
      throw failure('PREVIEW_MARKDOWN_UNAVAILABLE', '未安装 Markdown 渲染依赖，请由主项目安装 markdown-it', error)
    }
    body = new MarkdownIt({ html: false, linkify: false, typographer: false }).render(text)
  } else if (kind === 'csv') {
    const rows = parseCsv(text)
    body = '<table>' + rows.map((row, index) => `<tr>${row.map(cell => `<${index ? 'td' : 'th'}>${escapeHtml(cell)}</${index ? 'td' : 'th'}>`).join('')}</tr>`).join('') + '</table>'
  } else {
    if (kind === 'json') { try { text = JSON.stringify(JSON.parse(text), null, 2) } catch { /* invalid JSON remains readable */ } }
    body = `<pre><code>${escapeHtml(text)}</code></pre>`
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>html{background:#fff;color:#202124}body{margin:0;padding:24px;font:16px/1.6 system-ui,-apple-system,"Noto Sans CJK SC",sans-serif;overflow-wrap:anywhere}pre{white-space:pre-wrap;margin:0}code{font:14px/1.6 ui-monospace,monospace}img{max-width:100%;height:auto}table{border-collapse:collapse;max-width:100%;font-size:14px}td,th{border:1px solid #ddd;padding:8px 12px;text-align:left}th{background:#f5f5f5}h1,h2,h3{line-height:1.25}blockquote{border-left:3px solid #ddd;padding-left:16px;color:#666}</style></head><body>${body}</body></html>`
}
function parseCsv(text) {
  const rows = []
  let row = [], cell = '', quoted = false
  const pushCell = () => { if (row.length < 128) row.push(cell); cell = '' }
  for (let index = 0; index < text.length && rows.length < 2000; index++) {
    const character = text[index]
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { if (cell.length < 8192) cell += '"'; index++ }
      else if (quoted || !cell) quoted = !quoted
      else if (cell.length < 8192) cell += character
    } else if (!quoted && character === ',') pushCell()
    else if (!quoted && (character === '\n' || character === '\r')) {
      pushCell(); rows.push(row); row = []
      if (character === '\r' && text[index + 1] === '\n') index++
    } else if (cell.length < 8192) cell += character
  }
  if (rows.length < 2000 && (cell || row.length)) { pushCell(); rows.push(row) }
  return rows
}
function pdfShell() { return '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff;overflow:hidden}canvas{display:block}</style></head><body><canvas id="pdf-preview"></canvas></body></html>' }
function safeResource(value) {
  try { const url = new URL(value); return `${url.origin}${url.pathname}`.slice(0, 240) } catch { return '未知资源' }
}
async function publicAddress(url, cache, signal) {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) {
    throw new Error('只允许公共 HTTP/HTTPS 资源')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home|invalid)$/.test(host) || !host.includes('.') && !isIP(host)) {
    throw new Error('禁止访问本机或私有网络')
  }
  if (!cache.has(host)) {
    cache.set(host, (async () => {
      const addresses = isIP(host) ? [{ address: host }] : await abortable(lookup(host, { all: true, verbatim: true }), signal, RESOURCE_TIMEOUT)
      if (!addresses.length || addresses.some(({ address }) => !isPublicIp(address))) throw new Error('禁止访问本机或私有网络')
      return addresses[0].address
    })())
  }
  return abortable(cache.get(host), signal)
}
function isPublicIp(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
      a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19].includes(b) ||
      a === 192 && b === 0 && [0, 2].includes(c) || a === 192 && b === 88 && c === 99 || a === 198 && b === 51 && c === 100 || a === 203 && b === 0 && c === 113)
  }
  // Only native global-unicast IPv6; excludes mapped IPv4, ULA, link-local, multicast and transition ranges.
  if (isIP(address) === 6) {
    const lower = address.toLowerCase()
    const groups = lower.split(':')
    const first = parseInt(groups[0], 16)
    const second = parseInt(groups[1] || '0', 16)
    return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 && first !== 0x3fff &&
      !(first === 0x2001 && (second < 0x200 || second === 0xdb8))
  }
  return false
}

function outputSize(width, height, quality) {
  const scale = Math.min(1, (quality === 'detail' ? 1024 : 384) / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}
function resolveModelReference(reference, parent) {
  if (!reference || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(reference)) return null
  let value
  try { value = decodeURIComponent(reference.split(/[?#]/)[0]) } catch { value = reference }
  return normalizeName(value.startsWith('/') ? value : `${normalizeName(parent).split('/').slice(0, -1).join('/')}/${value}`)
}
function selectedModelAssets(assets = [], originalId, references) {
  if (!Array.isArray(references)) return modelResourceAssets(assets, originalId)
  const candidates = assets.filter(asset => asset.id !== originalId)
  return [...new Map(references.flatMap(([path, fallback]) => matchingModelAssets(candidates, { path, fallback }))
    .map(asset => [asset.id, asset])).values()]
}
function matchingModelAssets(assets, { path, fallback }) {
  const name = asset => normalizeName(asset.metadata?.relativePath || asset.metadata?.fileName || asset.metadata?.name).toLowerCase()
  for (const candidate of [path, fallback]) {
    const matches = assets.filter(asset => name(asset) === candidate.toLowerCase())
    if (matches.length) return matches
  }
  const basename = path.split('/').pop().toLowerCase()
  const matches = assets.filter(asset => name(asset).split('/').pop() === basename)
  const conventional = matches.filter(asset => ['textures', 'texture', 'maps', 'images', 'materials'].includes(name(asset).split('/').at(-2)))
  return conventional.length ? conventional : matches
}

// Native PDF exposes raster dimensions; fit their aspect into the requested layout box.
function pdfLayout(input, rendered) {
  if (input.mode === 'fixed-viewport') return { layoutWidth: input.width, layoutHeight: input.height }
  const scale = Math.min(input.width / rendered.width, input.height / rendered.height)
  return { layoutWidth: Math.max(1, Math.floor(rendered.width * scale)),
    layoutHeight: Math.max(1, Math.floor(rendered.height * scale)) }
}
