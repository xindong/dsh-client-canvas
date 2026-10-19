import { createPreviewSpec } from '@pixi-board/core'
import { isPreviewNode } from '../upstream/apps/site/src/preview.ts'
import { API_BASE, activeBoardId, onActiveBoardChange, transport } from './store.js'

export {
  isDocumentNode, isPreviewNode, previewTypeLabel, classifyPreviewFile, documentPreviewImport,
} from '../upstream/apps/site/src/preview.ts'

const controllers = new WeakMap()
const textureTimings = new Map()
const textureEpochs = new Map()
const textureCollectors = new Set()
let textureEpoch = 0
let textureEpochBase = 0
export function getPreviewTextureEpoch(assetId) { return textureEpochs.get(assetId) ?? textureEpochBase }

/** Called by the existing texture loader after image decode and Texture.from. */
export function reportPreviewTextureReady(assetId, variant = 'preview') {
  const key = `${assetId}:${variant}`
  const reports = textureTimings.get(key)
  textureTimings.delete(key)
  for (const report of reports || []) report()
  for (const collect of textureCollectors) collect()
}

/** Explicit reset actions change only preview state, never the camera. */
export function requestDocumentPreview(board, nodeId, options = {}) {
  const node = board.nodes.get(nodeId)
  if (!isPreviewNode(node)) return Promise.resolve()
  // A watcher may already have admitted this import; dispatch the same request.
  if (options.reason === 'import' && node.props.previewStatus === 'pending' && node.props.previewRequestId) {
    return controllers.get(board)?.submit(nodeId) ?? Promise.resolve()
  }
  const spec = createPreviewSpec(node, options)
  const requestId = crypto.randomUUID()
  board.nodes.update(nodeId, {
    props: { ...node.props, previewStatus: 'pending', previewRequestId: requestId,
      previewSpec: spec, previewJobId: null, previewError: null },
  })
  return controllers.get(board)?.submit(nodeId) ?? Promise.resolve()
}

/** Batch admission shares one save; SSE applies committed preview patches without
 * waiting for the whole document to become idle. Store polling remains recovery. */
export function attachDocumentPreviews(site) {
  const board = site.activeBoard
  const store = site.projectStore
  const waiting = new Map()
  const inFlight = new Map()
  const submitted = new Set()
  const delivered = new Set()
  const detailAttempted = new Set()
  const retryTimers = new Set()
  const retryCounts = new Map()
  const disposers = []
  const controller = new AbortController()
  let stopped = false
  let scheduled = false
  let batching = false
  let generation = 0
  let collecting = false
  let events
  let eventQueue = Promise.resolve()

  function current(entry) {
    const node = board.nodes.get(entry.nodeId)
    return generation === entry.generation && activeBoardId === entry.boardId && node?.props.previewRequestId === entry.requestId ? node : undefined
  }
  function fail(entry, error) {
    const node = current(entry)
    if (!node || node.props.previewStatus !== 'pending') return
    board.nodes.update(node.id, { props: { ...node.props, previewStatus: 'error', previewError: error?.message || String(error) } })
  }
  function retry(entry) {
    if (stopped || !current(entry)) return
    const attempt = (retryCounts.get(entry.key) || 0) + 1
    retryCounts.set(entry.key, attempt)
    const timer = setTimeout(() => {
      retryTimers.delete(timer)
      if (!stopped && current(entry)?.props.previewStatus === 'pending') {
        submitted.delete(entry.key)
        void submit(entry.nodeId)
      }
    }, Math.min(30_000, 1200 * 2 ** Math.min(attempt - 1, 5)))
    retryTimers.add(timer)
  }
  function submit(nodeId) {
    if (stopped || !activeBoardId) return Promise.resolve()
    let node = board.nodes.get(nodeId)
    if (!isPreviewNode(node) || node.props.previewStatus !== 'pending') return Promise.resolve()
    let requestId = node.props.previewRequestId
    if (!requestId) {
      requestId = crypto.randomUUID()
      board.nodes.update(nodeId, { props: { ...node.props, previewRequestId: requestId } })
      node = board.nodes.get(nodeId)
    }
    const key = JSON.stringify([activeBoardId, nodeId, requestId])
    if (inFlight.has(key)) return inFlight.get(key).promise
    if (submitted.has(key)) return Promise.resolve()
    const assetId = node.assetRefs?.primary?.assetId ?? node.assetRefs?.preview?.assetId
    if (!assetId) return Promise.resolve()
    let resolve
    const promise = new Promise(done => { resolve = done })
    const entry = { key, generation, boardId: activeBoardId, nodeId, requestId, assetId, promise, resolve }
    inFlight.set(key, entry)
    waiting.set(key, entry)
    queueMicrotask(flush)
    return promise
  }
  async function flush() {
    if (stopped || batching || !waiting.size) return
    batching = true
    const boardId = activeBoardId
    const batch = [...waiting.values()].filter(entry => current(entry)).slice(0, 16)
    for (const entry of waiting.values()) {
      if (!current(entry)) { waiting.delete(entry.key); if (inFlight.get(entry.key) === entry) inFlight.delete(entry.key); entry.resolve() }
    }
    for (const entry of batch) { waiting.delete(entry.key); submitted.add(entry.key) }
    try {
      if (!batch.length) return
      const saveBatch = store.bridge?.savePreviewBatch?.bind(store.bridge) || store.save.bind(store)
      await saveBatch(boardId, board.document.toJSON(), { signal: controller.signal })
      if (stopped || activeBoardId !== boardId) return
      const selected = new Set(board.selection.get())
      const requests = batch.filter(entry => current(entry)?.props.previewStatus === 'pending').map(entry => ({
        nodeId: entry.nodeId, requestId: entry.requestId, assetId: entry.assetId,
        ...createPreviewSpec(current(entry)), priority: selected.has(entry.nodeId) ? 0 : 1,
      }))
      if (!requests.length) return
      const result = await transport(`/boards/${encodeURIComponent(boardId)}/previews`, {
        method: 'POST', signal: controller.signal, json: { requests },
      })
      const admitted = new Set()
      for (const item of result.jobs || []) {
        const entry = batch.find(candidate => candidate.nodeId === item.nodeId && candidate.requestId === item.requestId)
        if (!entry) continue
        admitted.add(entry.key)
        if (!item.error) retryCounts.delete(entry.key)
        if (['PREVIEW_QUEUE_FULL', 'PREVIEW_DISPOSED', 'PREVIEW_ADMISSION_FAILED'].includes(item.error?.code)) retry(entry)
        else if (item.error) fail(entry, item.error)
        // Terminal state may have arrived over SSE before this response. Never
        // write the admission response back over a newer committed node state.
      }
      for (const entry of batch) if (!admitted.has(entry.key)) retry(entry)
    } catch (error) {
      if (!stopped && error?.name !== 'AbortError') for (const entry of batch) {
        if (!error?.status || error.status >= 500 || [408, 409, 429].includes(error.status)) retry(entry)
        else fail(entry, error)
      }
    } finally {
      for (const entry of batch) { if (inFlight.get(entry.key) === entry) inFlight.delete(entry.key); entry.resolve() }
      batching = false
      if (!stopped && waiting.size) queueMicrotask(flush)
    }
  }

  async function receive(event) {
    if (stopped || !event?.nodePatch?.id || event.job?.boardId !== activeBoardId) return
    const node = board.nodes.get(event.nodePatch?.id)
    if (!node || node.props.previewRequestId !== event.job.requestId) return
    if (node.props.previewStatus !== 'pending' && node.props.previewStatus === event.job.status &&
        node.props.previewKey === event.nodePatch.props?.previewKey) return
    const key = `${event.job.id}:${event.job.status}`
    if (delivered.has(key)) return
    const started = performance.now()
    const previewVariant = event.nodePatch.assetRefs?.preview?.variant || 'preview'
    const textureAssetId = event.nodePatch.assetRefs?.preview?.assetId || event.job.assetId
    const textureKey = `${textureAssetId}:${previewVariant}`
    const receivedGeneration = generation
    const trackTexture = event.job.status === 'ready' ? () => {
      const current = board.nodes.get(event.nodePatch.id)
      if (stopped || generation !== receivedGeneration || event.job.boardId !== activeBoardId || current?.props.previewRequestId !== event.job.requestId) return
      const textureReadyMs = performance.now() - started
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (stopped || generation !== receivedGeneration || event.job.boardId !== activeBoardId ||
            board.nodes.get(event.nodePatch.id)?.props.previewRequestId !== event.job.requestId) return
        void transport('/preview-metrics', { method: 'POST', signal: controller.signal,
          json: { jobId: event.job.id, textureReadyMs, frameMs: performance.now() - started } }).catch(() => {})
      }))
    } : undefined
    if (trackTexture) {
      textureEpochs.set(textureAssetId, ++textureEpoch)
      const reports = textureTimings.get(textureKey) || new Set()
      reports.add(trackTexture)
      textureTimings.set(textureKey, reports)
      if (textureTimings.size > 256) textureTimings.delete(textureTimings.keys().next().value)
    }
    try {
      const result = await store.bridge?.applyPreview?.(event)
      if ((!result?.applied && !result?.deferred) || stopped || generation !== receivedGeneration) {
        textureTimings.get(textureKey)?.delete(trackTexture)
        if (!textureTimings.get(textureKey)?.size) textureTimings.delete(textureKey)
        return
      }
      if (result.applied && site.textureCache?.has(textureKey)) reportPreviewTextureReady(textureAssetId, previewVariant)
      delivered.add(key)
      if (delivered.size > 1024) delivered.delete(delivered.values().next().value)
      if (result.applied && !result.deferred) void transport('/preview-metrics', { method: 'POST', signal: controller.signal,
        json: { jobId: event.job.id, deliveryMs: event.emittedAt ? Math.max(0, Date.now() - event.emittedAt) : undefined,
          applyMs: performance.now() - started } }).catch(() => {})
      schedule()
    } catch (error) {
      textureTimings.get(textureKey)?.delete(trackTexture)
      if (!textureTimings.get(textureKey)?.size) textureTimings.delete(textureKey)
      console.warn('[dsh-canvas] preview event', error)
    }
  }
  function connectEvents() {
    events?.close()
    events = undefined
    if (!activeBoardId || typeof EventSource === 'undefined' || stopped) return
    const connectedGeneration = generation
    events = new EventSource(`${API_BASE}/boards/${encodeURIComponent(activeBoardId)}/preview-events`)
    events.addEventListener('open', schedule)
    events.addEventListener('preview', event => {
      if (connectedGeneration !== generation) return
      try {
        const payload = JSON.parse(event.data)
        // Serialize before tracking epochs, not just inside the store bridge.
        eventQueue = eventQueue.then(() => connectedGeneration === generation ? receive(payload) : undefined)
          .catch(error => console.warn('[dsh-canvas] preview event', error))
      } catch (error) { console.warn('[dsh-canvas] malformed preview event', error) }
    })
  }
  function requestSelectedDetails() {
    const selected = board.selection.get()
    if (document.hidden || selected.length !== 1 || !document.querySelector('#import-lock')?.hidden) return
    for (const id of selected) {
      const node = board.nodes.get(id)
      if (!isPreviewNode(node) || node.props.previewStatus !== 'ready' || node.props.previewQuality !== 'thumbnail') continue
      const key = JSON.stringify([activeBoardId, id, node.props.previewKey])
      if (detailAttempted.has(key)) continue
      detailAttempted.add(key)
      void requestDocumentPreview(board, id, { quality: 'detail' })
    }
  }
  function scan() {
    if (stopped || !document.querySelector('#import-lock')?.hidden) return
    for (const node of board.nodes.list()) {
      const legacyZipWithoutModel = node.type === 'model' && /\.zip$/i.test(node.props.name || node.name || '') &&
        node.props.previewStatus === 'error' && /ZIP_NO_MODEL/.test(node.props.previewError || '')
      if (legacyZipWithoutModel || (node.type === 'model' && !node.props.previewStatus)) {
        void requestDocumentPreview(board, node.id)
      } else if (isPreviewNode(node) && node.props.previewStatus === 'pending') void submit(node.id)
    }
    requestSelectedDetails()
  }
  function schedule() {
    if (stopped || scheduled) return
    scheduled = true
    queueMicrotask(() => { scheduled = false; scan() })
  }
  function collectTextures() {
    if (stopped || collecting) return
    collecting = true
    const expectedGeneration = generation
    requestAnimationFrame(() => requestAnimationFrame(() => {
      collecting = false
      if (stopped || expectedGeneration !== generation) return
      const referenced = new Set(board.nodes.list().flatMap(node =>
        Object.values(node.assetRefs || {}).map(ref => `${ref.assetId}:${ref.variant || 'original'}`)))
      const decodingAssets = new Set()
      for (const key of referenced) {
        const match = /^(.*):(preview-[a-f0-9]{64})$/.exec(key)
        if (match && !site.textureCache?.has(key)) decodingAssets.add(match[1])
      }
      const keys = new Set([...(site.textureCache?.keys() || []), ...(site.mediaLibrary?.leases?.keys() || [])])
      for (const key of keys) {
        const match = /^(.*):(preview-[a-f0-9]{64})$/.exec(key)
        if (!match || referenced.has(key) || decodingAssets.has(match[1])) continue
        // Keep GPU destruction with PixiGC: an earlier frame may still own it.
        site.textureCache?.delete(key)
        site.mediaLibrary?.revokeLease?.(match[1], match[2])
      }
    }))
  }
  textureCollectors.add(collectTextures)
  disposers.push(() => textureCollectors.delete(collectTextures))
  const importObserver = new MutationObserver(schedule)
  const importLock = document.querySelector('#import-lock')
  if (importLock) importObserver.observe(importLock, { attributes: true, attributeFilter: ['hidden'] })
  disposers.push(() => importObserver.disconnect(), board.on('change', schedule), board.on('selection:change', requestSelectedDetails))
  disposers.push(onActiveBoardChange(() => {
    generation++
    for (const timer of retryTimers) clearTimeout(timer)
    retryTimers.clear()
    retryCounts.clear()
    for (const entry of inFlight.values()) entry.resolve()
    waiting.clear()
    inFlight.clear()
    submitted.clear()
    delivered.clear()
    detailAttempted.clear()
    textureTimings.clear()
    textureEpochs.clear()
    textureEpochBase = ++textureEpoch
    connectEvents()
    schedule()
  }))
  function destroy() {
    if (stopped) return
    stopped = true
    controller.abort()
    events?.close()
    textureTimings.clear()
    for (const timer of retryTimers) clearTimeout(timer)
    retryCounts.clear()
    for (const entry of inFlight.values()) entry.resolve()
    waiting.clear()
    inFlight.clear()
    for (const dispose of disposers) dispose()
    window.removeEventListener('pagehide', destroy)
    if (controllers.get(board)?.submit === submit) controllers.delete(board)
  }
  window.addEventListener('pagehide', destroy)
  controllers.set(board, { submit, destroy })
  connectEvents()
  scan()
  return destroy
}
