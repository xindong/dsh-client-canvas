import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { createNodeMediaProvider, MEDIA_PIPELINE_VERSION } from 'pixiboardjs/node-media-provider'

const MEDIA = new Set(['image', 'video', 'audio'])
const MAX_JOBS = 256

/** DSH owns durable assets/documents; SDK providers own decoding and derivatives. */
export function createMediaService(ctx) {
  const provider = createNodeMediaProvider({ sharp })
  const lifetime = new AbortController()
  const queued = new Map(), active = new Map(), rescans = new Map(), listeners = new Set()
  let stopped = false
  let recoveryRunning = false
  const diagnostic = error => { if (!stopped) ctx.logger?.warn?.('[canvas-media]', error) }
  const detachProcessor = ctx.canvas.setMediaProcessor?.({
    // Fast dimensions before initial layout. Video/audio probes run off the import path.
    probe: input => input.kind === 'image' ? provider.probe({ ...input, signal: lifetime.signal }) : {},
  })
  function emit(event) { for (const listener of listeners) { try { listener(structuredClone(event)) } catch (error) { diagnostic(error) } } }
  function enqueue(boardId, assetId, force = false) {
    if (stopped) return false
    const key = JSON.stringify([boardId, assetId])
    if (active.has(key)) { active.get(key).rerun = true; if (force) active.get(key).forceRerun = true; return true }
    if (!queued.has(key) && queued.size >= MAX_JOBS) return false
    queued.set(key, { boardId, assetId, force: force || queued.get(key)?.force })
    pump()
    return true
  }
  function pump() {
    while (!stopped && active.size < 2 && queued.size) {
      const [key, job] = queued.entries().next().value
      queued.delete(key); active.set(key, job)
      void process(job).catch(diagnostic).finally(() => {
        active.delete(key)
        if (job.rerun) enqueue(job.boardId, job.assetId, job.forceRerun)
        pump()
      })
    }
  }
  async function process(job) {
    lifetime.signal.throwIfAborted()
    const document = await ctx.canvas.snapshot(job.boardId)
    const asset = document.assets.find(item => item.id === job.assetId)
    if (!asset || !MEDIA.has(asset.kind)) return
    // Preparation starts only after a consumer exists, avoiding upload/save races.
    if (!document.nodes.some(node => MEDIA.has(node.type) && sourceId(node) === asset.id)) return
    const version = await ctx.canvas.getBinaryVersion(job.boardId, asset.id, 'original')
    if (!version) return
    const contentHash = version.contentHash
    const state = asset.metadata?.media
    const matches = state?.contentHash === contentHash && state?.pipelineVersion === MEDIA_PIPELINE_VERSION
    if (!job.force && matches && ['ready', 'error'].includes(state.status)) {
      // Also repairs newly-created consumers of an already prepared asset.
      const missing = document.nodes.some(node => sourceId(node) === asset.id && MEDIA.has(node.type) &&
        (node.props?.mediaContentHash !== contentHash || node.props?.mediaPreparationStatus !== state.status))
      if (missing) await publish(job, contentHash, state, asset.metadata?.derivatives || {})
      return
    }
    const pending = { ...(state?.contentHash === contentHash ? state : {}), version: 1, pipelineVersion: MEDIA_PIPELINE_VERSION, contentHash, status: 'pending', error: null }
    let admitted
    try { admitted = await publish(job, contentHash, pending, state?.contentHash === contentHash ? asset.metadata?.derivatives || {} : {}) }
    catch (error) {
      if (lifetime.signal.aborted) throw error
      await publishFailure(job, contentHash, error)
      return
    }
    if (!admitted?.applied) { job.rerun = true; return }
    let binary
    try { binary = await ctx.canvas.getBinary(job.boardId, asset.id, 'original') }
    catch (error) {
      if (lifetime.signal.aborted) throw error
      await publishFailure(job, contentHash, error)
      return
    }
    if (!binary) { await publishFailure(job, contentHash, new Error('原始媒体文件已不存在')); return }
    if (sha(binary.data) !== contentHash) { await publishFailure(job, contentHash, new Error('读取过程中原始媒体文件已改变')); return }
    let result
    try { result = await provider.prepare({ kind: asset.kind, data: binary.data, signal: lifetime.signal }) }
    catch (error) {
      if (lifetime.signal.aborted) throw error
      await publishFailure(job, contentHash, error)
      return
    }
    lifetime.signal.throwIfAborted()
    // Preparation can outlive the source it was started for. Fence every
    // derivative write so deleted/replaced/unreferenced sources stop the job
    // before it creates another content-addressed file.
    let target = await inspectTarget(job, contentHash)
    if (target.status !== 'current') { await abandon(job, contentHash, target); return }
    const derivatives = {}
    for (const [role, value] of Object.entries(result.derivatives)) {
      target = await inspectTarget(job, contentHash)
      if (target.status !== 'current') { await abandon(job, contentHash, target); return }
      const hash = sha(value.data)
      const variant = `preview-${hash}`
      try {
        await ctx.canvas.putBinary(job.boardId, asset.id, variant, value.data, { mimeType: value.mimeType,
          fileName: `${asset.metadata?.fileName || asset.id}.${role}.${value.mimeType.split('/')[1]}` })
      } catch (error) {
        if (lifetime.signal.aborted) throw error
        try {
          // putBinary can fail after the rename (for example while deriving its
          // sidecar). If the variant landed, reference it from the error state.
          if (await ctx.canvas.getBinary(job.boardId, asset.id, variant)) {
            derivatives[role] = { variant, contentHash: hash, mimeType: value.mimeType }
          }
        } catch { /* the original write error is the useful diagnosis */ }
        // Keep any derivatives that were written successfully referenced by
        // the error state; otherwise they would be orphaned with no cleanup API.
        await publishFailure(job, contentHash, error, derivatives)
        return
      }
      derivatives[role] = { variant, contentHash: hash, mimeType: value.mimeType }
    }
    target = await inspectTarget(job, contentHash)
    if (target.status !== 'current') { await abandon(job, contentHash, target); return }
    let completed
    try { completed = await publish(job, contentHash, { ...result.media, contentHash }, derivatives) }
    catch (error) {
      if (lifetime.signal.aborted) throw error
      await publishFailure(job, contentHash, error, derivatives)
      return
    }
    if (!completed?.applied) job.rerun = true
  }
  async function inspectTarget(job, contentHash) {
    try {
      const document = await ctx.canvas.snapshot(job.boardId)
      const asset = document.assets.find(item => item.id === job.assetId)
      if (!asset || !MEDIA.has(asset.kind)) return { status: 'missing' }
      if (!document.nodes.some(node => MEDIA.has(node.type) && sourceId(node) === job.assetId)) return { status: 'unused' }
      const version = await ctx.canvas.getBinaryVersion(job.boardId, job.assetId, 'original')
      if (!version || version.contentHash !== contentHash) return { status: 'stale' }
      return { status: 'current', asset }
    } catch (error) {
      return { status: 'unknown', error }
    }
  }
  async function abandon(job, contentHash, target) {
    if (target.status === 'stale') job.rerun = true
    else if (target.status === 'unknown') await publishFailure(job, contentHash, target.error)
  }
  async function publishFailure(job, contentHash, error, derivatives = {}) {
    if (stopped || !contentHash || lifetime.signal.aborted) return false
    const target = await inspectTarget(job, contentHash)
    if (target.status === 'missing' || target.status === 'unused') return false
    if (target.status === 'stale') { job.rerun = true; return false }
    try {
      const media = { version: 1, pipelineVersion: MEDIA_PIPELINE_VERSION, contentHash, status: 'error',
        error: String(error?.message || error || '媒体处理失败').slice(0, 400) }
      const result = await publish(job, contentHash, media, derivatives)
      if (!result?.applied) job.rerun = true
      return result?.applied === true
    } catch (publishError) {
      diagnostic(publishError)
      return false
    }
  }
  async function publish(job, contentHash, media, derivatives) {
    const result = await ctx.canvas.publishMedia(job.boardId, { assetId: job.assetId, contentHash, media, derivatives })
    if (result.applied) emit({ type: 'media', boardId: job.boardId, assetId: job.assetId, contentHash,
      status: media.status, asset: result.asset, nodePatches: result.nodePatches, revision: result.revision })
    return result
  }
  async function scan(boardId, force = false) {
    if (stopped) return Promise.resolve()
    const current = rescans.get(boardId)
    if (current) {
      // A board can change while its snapshot is being enumerated. Keep one
      // trailing scan instead of dropping the event behind the in-flight scan.
      current.rerun = true
      current.force ||= force
      return current.promise
    }
    const state = { rerun: false, force, promise: null }
    state.promise = (async () => {
      do {
        state.rerun = false
        const scanForce = state.force
        state.force = false
        try {
          const document = await ctx.canvas.snapshot(boardId)
          const ids = new Set(document.nodes.filter(node => MEDIA.has(node.type)).map(sourceId))
          for (const asset of document.assets) if (MEDIA.has(asset.kind) && ids.has(asset.id)) enqueue(boardId, asset.id, scanForce)
        } catch (error) { diagnostic(error) }
      } while (!stopped && state.rerun)
    })().finally(() => {
      if (rescans.get(boardId) !== state) return
      rescans.delete(boardId)
      // The event can arrive after the loop condition but before this finally
      // callback. Start the trailing scan instead of dropping that generation.
      if (!stopped && state.rerun) void scan(boardId, state.force)
    })
    rescans.set(boardId, state)
    return state.promise
  }
  const unsubscribe = ctx.canvas.subscribeAll?.(event => {
    if (event.type === 'media:ready' || stopped) return
    if (event.boardId) void scan(event.boardId)
  })
  async function recover() {
    if (recoveryRunning || stopped) return
    recoveryRunning = true
    try { for (const board of await ctx.canvas.listBoards()) await scan(board.id) }
    catch (error) { diagnostic(error) }
    finally { recoveryRunning = false }
  }
  void recover()
  // This also covers old hosts without subscribeAll and assets saved while a queue is full.
  const recoveryTimer = setInterval(() => void recover(), 30_000)
  recoveryTimer.unref?.()
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async request(boardId, assetId) {
      if (stopped) throw requestError('MEDIA_SERVICE_STOPPED', '媒体服务已关闭')
      const document = await ctx.canvas.snapshot(boardId)
      if (!document.assets.some(asset => asset.id === assetId && MEDIA.has(asset.kind))) throw new TypeError('找不到可处理的媒体资源')
      if (stopped) throw requestError('MEDIA_SERVICE_STOPPED', '媒体服务已关闭')
      if (!enqueue(boardId, assetId, true)) {
        if (stopped) throw requestError('MEDIA_SERVICE_STOPPED', '媒体服务已关闭')
        throw requestError('MEDIA_QUEUE_FULL', '媒体处理队列已满，请稍后重试')
      }
      return { status: 'pending', boardId, assetId }
    },
    async dispose() {
      stopped = true; clearInterval(recoveryTimer); lifetime.abort(new Error('媒体服务已关闭'))
      unsubscribe?.(); detachProcessor?.(); listeners.clear(); queued.clear()
    },
  }
}
function sourceId(node) { return node.assetRefs?.primary?.assetId ?? node.assetRefs?.original?.assetId ?? node.assetRefs?.poster?.assetId ?? node.assetRefs?.waveform?.assetId ?? node.assetRefs?.preview?.assetId }
function requestError(code, message) { const error = new TypeError(message); error.code = code; return error }
function sha(data) { return createHash('sha256').update(data).digest('hex') }
