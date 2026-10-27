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
const MISSING_PREVIEW_SOURCE_ERROR = '未找到可预览的原始文件，请重新导入。'
export function getPreviewTextureEpoch(assetId) { return textureEpochs.get(assetId) ?? textureEpochBase }

/** Called by the existing texture loader after image decode and Texture.from. */
export function reportPreviewTextureReady(assetId, variant = 'preview') {
  const key = `${assetId}:${variant}`
  const reports = textureTimings.get(key)
  textureTimings.delete(key)
  for (const report of reports || []) report()
  for (const collect of textureCollectors) collect()
}

function isOriginalAssetRef(ref) {
  return Boolean(ref?.assetId) && (ref.variant === undefined || ref.variant === 'original')
}

function previewSourceAssetId(node) {
  const refs = node.assetRefs || {}
  // Prefer an explicit original reference over a derived preview. Some legacy
  // nodes still carry a preview variant on `primary`; repairing that ref is
  // safe only after checking the other original refs first.
  return (isOriginalAssetRef(refs.primary) ? refs.primary.assetId : undefined) ??
    (isOriginalAssetRef(refs.original) ? refs.original.assetId : undefined) ??
    Object.entries(refs).find(([name, ref]) => !name.startsWith('_') && isOriginalAssetRef(ref))?.[1]?.assetId ??
    refs.primary?.assetId ?? refs.original?.assetId ?? refs.preview?.assetId ??
    Object.entries(refs).find(([name, ref]) => !name.startsWith('_') && ref?.assetId)?.[1]?.assetId
}

function ensureOriginalAssetRef(board, node) {
  const assetId = previewSourceAssetId(node)
  const primary = node.assetRefs?.primary
  if (!assetId || primary?.assetId === assetId && primary.variant === 'original') return { node, repaired: false }
  board.nodes.update(node.id, { assetRefs: { ...(node.assetRefs || {}),
    primary: { assetId, variant: 'original' } } })
  return { node: board.nodes.get(node.id) || node, repaired: true }
}

/** Explicit reset actions change only preview state, never the camera. */
export function requestDocumentPreview(board, nodeId, options = {}) {
  let node = board.nodes.get(nodeId)
  if (!isPreviewNode(node)) return Promise.resolve()
  node = ensureOriginalAssetRef(board, node).node
  const assetId = previewSourceAssetId(node)
  if (!assetId) return Promise.resolve()
  // A watcher may already have admitted this import; dispatch the same request.
  if (options.reason === 'import' && node.props.previewStatus === 'pending' && node.props.previewRequestId) {
    return controllers.get(board)?.submit(nodeId) ?? Promise.resolve()
  }
  const spec = createPreviewSpec(node, options)
  const requestId = crypto.randomUUID()
  const patch = {
    props: { ...node.props, previewStatus: 'pending', previewRequestId: requestId,
      previewSpec: spec, previewJobId: null, previewError: null },
  }
  board.nodes.update(nodeId, patch)
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
    return generation === entry.generation && activeBoardId === entry.boardId &&
      node?.props.previewRequestId === entry.requestId && previewSourceAssetId(node) === entry.assetId ? node : undefined
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
      if (!stopped && retryCounts.get(entry.key) === attempt && current(entry)?.props.previewStatus === 'pending') {
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
    node = ensureOriginalAssetRef(board, node).node
    const assetId = previewSourceAssetId(node)
    if (!assetId) return Promise.resolve()
    let requestId = node.props.previewRequestId
    if (!requestId) {
      requestId = crypto.randomUUID()
      board.nodes.update(nodeId, { props: { ...node.props, previewRequestId: requestId } })
      node = board.nodes.get(nodeId)
    }
    const key = JSON.stringify([activeBoardId, nodeId, requestId])
    if (inFlight.has(key)) return inFlight.get(key).promise
    if (submitted.has(key)) return Promise.resolve()
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
    if (!node || node.props.previewRequestId !== event.job.requestId || previewSourceAssetId(node) !== event.job.assetId) return
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
      if (stopped || generation !== receivedGeneration || event.job.boardId !== activeBoardId ||
          current?.props.previewRequestId !== event.job.requestId || previewSourceAssetId(current) !== event.job.assetId) return
      const textureReadyMs = performance.now() - started
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const currentNode = board.nodes.get(event.nodePatch.id)
        if (stopped || generation !== receivedGeneration || event.job.boardId !== activeBoardId ||
            currentNode?.props.previewRequestId !== event.job.requestId || previewSourceAssetId(currentNode) !== event.job.assetId) return
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
    let opens = 0
    events = new EventSource(`${API_BASE}/boards/${encodeURIComponent(activeBoardId)}/preview-events`)
    events.addEventListener('open', () => {
      if (stopped || connectedGeneration !== generation) return
      const opened = ++opens
      if (opened > 1) {
        for (const timer of retryTimers) clearTimeout(timer)
        retryTimers.clear()
        retryCounts.clear()
        const pending = [...inFlight.values()]
        submitted.clear()
        // A batch already saving or posting is guarded by inFlight; rescan it
        // after settlement in case the old server accepted it before restarting.
        if (pending.length) void Promise.all(pending.map(entry => entry.promise)).then(() => {
          if (stopped || connectedGeneration !== generation || opened !== opens) return
          for (const entry of pending) submitted.delete(entry.key)
          schedule()
        })
        // Events emitted while disconnected are not replayed. Kick the normal
        // guarded poll so terminal preview/media changes are recovered. It only
        // merges into a clean, unchanged document and never overwrites local edits.
        store.bridge?.scheduleSync?.()
      }
      schedule()
    })
    events.addEventListener('preview', event => {
      if (connectedGeneration !== generation) return
      try {
        const payload = JSON.parse(event.data)
        // Serialize before tracking epochs, not just inside the store bridge.
        eventQueue = eventQueue.then(() => connectedGeneration === generation ? receive(payload) : undefined)
          .catch(error => console.warn('[dsh-canvas] preview event', error))
      } catch (error) { console.warn('[dsh-canvas] malformed preview event', error) }
    })
    events.addEventListener('media', event => {
      if (connectedGeneration !== generation) return
      let payload
      try { payload = JSON.parse(event.data) } catch (error) {
        console.warn('[dsh-canvas] malformed media event', error)
        return
      }
      eventQueue = eventQueue.then(async () => {
        if (connectedGeneration !== generation || stopped) return
        const result = await store.bridge?.applyMedia?.(payload)
        if (!result?.applied || connectedGeneration !== generation || stopped) return
        // A video poster and an image preview share the `preview` variant;
        // audio uses `waveform`. Node and asset references now point at the
        // new immutable derivative, so only these mutable legacy leases need
        // invalidation. Older content-addressed variants can stay for other
        // consumers until the texture GC observes they are unused.
        for (const variant of new Set(['preview', ...(result.variants || [])])) {
          site.textureCache?.delete?.(`${payload.assetId}:${variant}`)
          site.mediaLibrary?.invalidateVariant?.(payload.assetId, variant)
        }
        textureEpochs.set(payload.assetId, ++textureEpoch)
        schedule()
      }).catch(error => console.warn('[dsh-canvas] media event', error))
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
    const repairs = new Map()
    // Repairing a missing primary changes the board. Do not replace the node
    // during iteration; collect the stable mutation first, then scan the
    // committed nodes so every later branch observes the same document.
    const repairSources = () => {
      for (const node of board.nodes.list()) {
        if (!isPreviewNode(node)) continue
        if (ensureOriginalAssetRef(board, node).repaired) repairs.set(node.id, node)
      }
    }
    if (typeof board.transaction === 'function') {
      board.transaction('Recover document preview sources', repairSources)
    } else repairSources()
    for (const node of board.nodes.list()) {
      if (!isPreviewNode(node)) continue
      const legacyZipWithoutModel = node.type === 'model' && /\.zip$/i.test(node.props.name || node.name || '') &&
        node.props.previewStatus === 'error' && /ZIP_NO_MODEL/.test(node.props.previewError || '')
      const repairedPrimary = repairs.has(node.id)
      // Primary is the immutable source reference for every document preview.
      // A missing primary is recoverable when a preview/original ref remains;
      // only an asset-less node is uninitialized.
      const hasSource = repairedPrimary || Boolean(previewSourceAssetId(node))
      const missingSourceState = !hasSource && [undefined, 'pending', 'ready'].includes(node.props.previewStatus)
      if (missingSourceState) {
        board.nodes.update(node.id, { props: {
          ...node.props, previewStatus: 'error', previewError: MISSING_PREVIEW_SOURCE_ERROR,
        } })
        continue
      }
      if (!hasSource) continue
      // Legacy Agent nodes can carry a valid original ref with no preview state.
      // requestDocumentPreview writes pending + requestId synchronously, so the
      // next scan sees a pending request instead of admitting it again.
      const uninitializedPreview = node.props.previewStatus === undefined
      const interruptedPending = node.props.previewStatus === 'pending' && !node.props.previewRequestId
      const repairableStaleError = repairedPrimary && node.props.previewStatus === 'error' &&
        /预览请求已失效|(?:原始|原文件|同画布|文档关联|关联资源).*?(?:改变|不存在|移除)/.test(node.props.previewError || '')
      const recoveredSource = repairedPrimary && node.props.previewStatus === 'error' &&
        node.props.previewError === MISSING_PREVIEW_SOURCE_ERROR
      if (legacyZipWithoutModel || uninitializedPreview || interruptedPending || repairableStaleError || recoveredSource) {
        void requestDocumentPreview(board, node.id)
      } else if (node.props.previewStatus === 'pending') void submit(node.id)
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
        site.mediaLibrary?.invalidateVariant?.(match[1], match[2])
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
