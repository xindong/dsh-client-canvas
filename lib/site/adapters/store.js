/** HTTP-only project storage. Memory below is a merge baseline, never a second database. */
export const API_BASE = '/xindong-canvas'
export let activeBoardId
let sharedStore
let pendingMedia = 0
let pageHiding = false
const mediaIdle = new Set()
const activeListeners = new Set()

export class CanvasHttpError extends Error {
  constructor(response, payload) {
    super(payload?.error?.message || payload?.message || `Canvas request failed (${response.status})`)
    this.name = 'CanvasHttpError'
    this.status = response.status
    this.code = payload?.error?.code
    this.payload = payload
  }
}

/** JSON by default; raw request bodies and Blob responses use the same transport. */
export async function transport(path, options = {}) {
  const { json, raw = false, allowNotFound = false, ...init } = options
  const headers = new Headers(init.headers)
  if (json !== undefined) {
    headers.set('content-type', 'application/json')
    init.body = JSON.stringify(json)
  }
  // Best effort only; final unmount saves must be transferred to the parent
  // through __dshCanvasBeforeUnmount. A child GET callback may never run after
  // its iframe is removed, even if the GET itself used keepalive.
  if (pageHiding && init.keepalive === undefined) {
    const bytes = init.body === undefined ? 0
      : typeof init.body === 'string' ? new TextEncoder().encode(init.body).byteLength
        : init.body instanceof Blob ? init.body.size : Infinity
    if (bytes <= 60 * 1024) init.keepalive = true
  }
  const response = await fetch(`${API_BASE}${path}`, {
    ...init, headers, credentials: 'same-origin', cache: 'no-store',
  })
  if (allowNotFound && response.status === 404) return undefined
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined)
    throw new CanvasHttpError(response, payload)
  }
  if (raw) return response.blob()
  if (response.status === 204) return undefined
  const text = await response.text()
  return text ? JSON.parse(text) : undefined
}

export const boardPath = (id) => `/boards/${encodeURIComponent(id)}`
const clone = (value) => value === undefined ? undefined : structuredClone(value)
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

function equal(a, b) {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keys = Object.keys(a).filter((key) => a[key] !== undefined)
  const other = Object.keys(b).filter((key) => b[key] !== undefined)
  return keys.length === other.length && keys.every((key) => own(b, key) && equal(a[key], b[key]))
}

/** Core revisions are server-owned, not evidence of a local edit. */
export function sameDocument(a, b) {
  if (!a || !b) return a === b
  const { revision: _a, ...left } = a
  const { revision: _b, ...right } = b
  return equal(left, right)
}

/** Supply missing legacy v1 defaults without dropping unknown fields or props. */
export function normalizeDocument(input) {
  if (!object(input)) throw new TypeError('Canvas document must be an object')
  const document = clone(input)
  document.schemaVersion ??= 1
  document.revision ??= 0
  const assets = new Map((document.assets ?? []).map((record) => [record.id, record]))
  document.nodes = (document.nodes ?? []).map((node) => {
    const props = object(node.props) ? clone(node.props) : node.props ?? {}
    const next = { rotation: 0, zIndex: 0, ...node, typeVersion: node.typeVersion ?? 1, props }
    // Older canvas clients kept text/paint outside the SDK's props object.
    if (object(props) && node.type === 'text' && props.text === undefined) props.text = node.text ?? node.name ?? ''
    if (object(props) && node.type === 'rect' && props.fill === undefined) {
      const fill = node.fill ?? node.style?.fill
      if (typeof fill === 'number') props.fill = fill
      else if (typeof fill === 'string' && /^#[\da-f]{6}$/i.test(fill)) props.fill = Number.parseInt(fill.slice(1), 16)
    }
    if (object(props) && ['image', 'video', 'audio', 'model', 'html', 'markdown', 'text-file', 'file'].includes(node.type)) {
      const ref = Object.values(node.assetRefs ?? {})[0]
      const metadata = assets.get(ref?.assetId)?.metadata ?? {}
      props.name ??= props.fileName ?? metadata.name ?? metadata.fileName ?? node.name ?? ''
      props.mimeType ??= metadata.mimeType ?? ''
      props.size ??= metadata.size ?? 0
    }
    return next
  })
  document.assets ??= []
  return document
}

/* Apply only fields changed locally to the latest remote value. Node/asset arrays
 * are keyed by id, never replaced wholesale. rawBase protects concurrent edits
 * when a local deletion conflicts with a remotely modified entity. */
function mergeValue(base, local, remote, rawBase, key = '') {
  if (equal(base, local)) return clone(remote)
  if (['nodes', 'assets', 'connections'].includes(key) && (Array.isArray(base) || base === undefined) && Array.isArray(local) && Array.isArray(remote)) {
    base ??= []
    const before = new Map(base.map((item) => [item.id, item]))
    const after = new Map(local.map((item) => [item.id, item]))
    const raw = new Map((Array.isArray(rawBase) ? rawBase : base).map((item) => [item.id, item]))
    const result = []
    const remoteIds = new Set()
    for (const item of remote) {
      remoteIds.add(item.id)
      if (!before.has(item.id)) {
        result.push(after.has(item.id)
          ? mergeValue({}, after.get(item.id), item, {}) : clone(item))
      } else if (after.has(item.id)) {
        result.push(mergeValue(before.get(item.id), after.get(item.id), item, raw.get(item.id)))
      } else if (!equal(raw.get(item.id), item)) {
        // Concurrently modified records are safer to retain than silently erase.
        result.push(clone(item))
      }
    }
    for (const item of local) {
      if (!remoteIds.has(item.id) && !before.has(item.id)) result.push(clone(item))
      // A remote deletion of an existing entity wins over stale local edits.
    }
    return result
  }
  if ((object(base) || base === undefined) && object(local) && (object(remote) || remote === undefined)) {
    base ??= {}
    const result = clone(remote) ?? {}
    for (const field of new Set([...Object.keys(base), ...Object.keys(local)])) {
      if (key === '' && field === 'revision') continue
      if (equal(base[field], local[field])) continue
      if (!own(local, field) || local[field] === undefined) {
        if (equal(remote?.[field], rawBase && own(rawBase, field) ? rawBase[field] : base[field])) delete result[field]
      } else {
        result[field] = mergeValue(base[field], local[field], remote?.[field], rawBase?.[field], field)
      }
    }
    return result
  }
  return clone(local)
}

export function mergeDocuments(baseline, snapshot, latest, rawBaseline = baseline) {
  const merged = mergeValue(baseline, snapshot, latest, rawBaseline)
  merged.revision = latest.revision
  return merged
}

// These are the only node props owned by the preview service. In particular,
// previewRequestId and names remain owned by the current editor. Automatic
// height changes additionally require an explicit patch and unchanged geometry.
const PREVIEW_PROPS = ['previewStatus', 'previewError', 'previewSpec', 'previewKey',
  'pageCount', 'previewWarnings', 'intrinsicWidth', 'intrinsicHeight', 'fileExtension', 'previewQuality']
const PREVIEW_TERMINAL = new Set(['ready', 'error', 'failed', 'unsupported', 'cancelled', 'canceled'])
const previewRef = (key) => key === 'preview' || key.startsWith('_documentPreview')
function previewTarget(node, job) {
  return node?.props?.previewRequestId === job.requestId
    && (node.assetRefs?.preview?.assetId ?? node.assetRefs?.primary?.assetId) === job.assetId
}
function previewNodePatch(node, patch) {
  const props = { ...node.props }
  for (const key of PREVIEW_PROPS) if (own(patch.props, key)) props[key] = clone(patch.props[key])
  const result = { props }
  if (object(patch.assetRefs)) {
    const refs = Object.fromEntries(Object.entries(node.assetRefs ?? {}).filter(([key]) => !previewRef(key)))
    for (const [key, ref] of Object.entries(patch.assetRefs)) if (previewRef(key)) refs[key] = clone(ref)
    result.assetRefs = refs
  }
  return result
}
function previewHeight(event) {
  const patch = event.nodePatch
  return (patch.props.previewStatus ?? event.job.status) === 'ready'
    && patch.props.previewSpec?.mode !== 'fixed-viewport'
    && own(patch, 'height') && Number.isFinite(patch.height) && patch.height > 0
    ? patch.height : undefined
}
function canApplyPreviewHeight(node, event) {
  const before = event.geometryBaseline
  return previewHeight(event) !== undefined && before
    && node.props?.previewSpec?.mode !== 'fixed-viewport'
    && node.width === before.width && node.height === before.height
}
function previewAsset(asset, incoming) {
  // The service writes metadata.preview. A complete AssetRecord in an event
  // is not permission to acknowledge unrelated metadata or source changes.
  if (!incoming) return asset
  if (!asset) return clone(incoming)
  if (!own(incoming.metadata ?? {}, 'preview')) return asset
  return { ...asset, metadata: { ...asset.metadata, preview: clone(incoming.metadata.preview) } }
}
function patchPreviewDocument(document, event, server = false, baseline = false) {
  const node = document?.nodes?.find((item) => item.id === event.nodePatch.id)
  if (!previewTarget(node, event.job)) return
  const applyHeight = canApplyPreviewHeight(node, event)
  Object.assign(node, previewNodePatch(node, event.nodePatch))
  // A type transition waits for poll's safe full load. Keeping the old local
  // type baseline prevents autosave from treating that type as a user edit.
  if (server && event.nodePatch.type) node.type = event.nodePatch.type
  const height = previewHeight(event)
  // Both baselines acknowledge the actual server resize. A retained user size
  // must remain different from the local baseline so the next CAS preserves it.
  // Queued snapshots adopt the height only if they too have no local resize.
  if (height !== undefined && (server || baseline || applyHeight)) node.height = height
  const index = document.assets?.findIndex((asset) => asset.id === event.job.assetId) ?? -1
  if (index >= 0) document.assets[index] = previewAsset(document.assets[index], event.asset)
  else if (event.asset) (document.assets ??= []).push(clone(event.asset))
}

export function onActiveBoardChange(listener) {
  activeListeners.add(listener)
  return () => activeListeners.delete(listener)
}

function adoptActive(id) {
  const previous = activeBoardId
  activeBoardId = id
  if (previous !== id) for (const listener of activeListeners) listener(id, previous)
}

/** No implicit refresh after initialization: reading media must not switch boards. */
export async function getActiveBoardId() {
  if (activeBoardId) return activeBoardId
  const current = await transport('/current')
  if (!current?.boardId) throw new Error('The server did not return a current board')
  adoptActive(current.boardId)
  return current.boardId
}

/** Keep polling and board switching out of an asynchronous media import/write. */
export function beginMediaOperation() {
  pendingMedia += 1
  let finished = false
  return () => {
    if (finished) return
    finished = true
    pendingMedia -= 1
    if (!pendingMedia) {
      for (const resolve of mediaIdle) resolve()
      mediaIdle.clear()
    }
  }
}

async function waitForMedia() {
  while (pendingMedia) await new Promise((resolve) => mediaIdle.add(resolve))
}

export function getProjectStore() {
  return sharedStore ?? new SiteProjectStore()
}

export class SiteProjectStore {
  constructor(options = {}) {
    this.baselines = new Map()
    this.queues = new Map()
    this.previewSaves = new Set()
    this.pendingSaves = 0
    this.pendingSwitches = 0
    this.pendingMaintenance = 0
    this.maxSaveAttempts = options.maxSaveAttempts ?? 4
    this.onActiveChange = options.onActiveChange
    this.bridge = undefined
    this.switchQueue = Promise.resolve()
    sharedStore = this
  }

  async list() {
    const result = await transport('/boards')
    return (result?.boards ?? []).map(({ document: _document, ...board }) => ({
      ...board, id: board.id ?? board.boardId,
    })).sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt))
  }

  async all() {
    const summaries = await this.list()
    // Intentionally do not call get(): GC/enumeration must not move merge baselines.
    const projects = await Promise.all(summaries.map(async (summary) => {
      const result = await transport(boardPath(summary.id), { allowNotFound: true })
      return result ? this.project(result, summary) : undefined
    }))
    return projects.filter(Boolean)
  }

  project(result, summary = {}) {
    const id = result.boardId ?? result.id ?? summary.id
    return {
      ...summary, ...result, id,
      name: result.name ?? summary.name ?? result.document?.metadata?.name ?? '画布',
      createdAt: result.createdAt ?? summary.createdAt ?? 0,
      updatedAt: result.updatedAt ?? summary.updatedAt ?? 0,
      document: normalizeDocument(result.document),
      revision: result.revision ?? result.document.revision,
    }
  }

  remember(id, raw, local = normalizeDocument(raw), revision = raw.revision, needsRefresh = false) {
    this.baselines.set(id, { server: clone(raw), local: clone(local), revision, needsRefresh })
  }

  async loadActive(fallback) {
    const current = await transport('/current', { allowNotFound: true })
    if (current?.boardId && current.document) {
      const boards = await this.list()
      let summary = boards.find((board) => board.id === current.boardId)
      if (boards.length === 0) {
        // /current may return an in-memory default that has never been saved.
        // Persist that same ID so concurrent initial loads share one board.
        await transport('/boards', { method: 'POST', json: {
          boardId: current.boardId, name: '画布', document: current.document,
        } })
        summary = { id: current.boardId, name: '画布' }
      }
      if (activeBoardId !== current.boardId) await this.beforeActiveChange(current.boardId)
      adoptActive(current.boardId)
      const project = this.project(current, summary)
      this.remember(project.id, current.document, project.document, project.revision)
      return project
    }
    const [latest] = await this.list()
    if (latest) {
      const project = await this.get(latest.id)
      if (project) {
        await this.setActive(project.id)
        return project
      }
    }
    return this.create('画布', fallback())
  }

  async get(id) {
    const result = await transport(boardPath(id), { allowNotFound: true })
    if (!result) return undefined
    const summary = (await this.list()).find((board) => board.id === id)
    const project = this.project(result, summary)
    // Active-board inspection must not acknowledge unseen remote changes.
    if (id !== activeBoardId || !this.baselines.has(id)) {
      this.remember(id, result.document, project.document, project.revision)
    }
    return project
  }

  async create(name, document) {
    const result = await transport('/boards', { method: 'POST', json: { name, document: normalizeDocument(document) } })
    const id = result?.boardId ?? result?.id
    if (!id) throw new Error('Board creation did not return a boardId')
    const project = result.document ? this.project(result, { name }) : await this.get(id)
    if (!project) throw new Error(`Created board ${id} could not be loaded`)
    this.remember(id, result.document ?? project.document, project.document, project.revision)
    await this.setActive(id)
    return project
  }

  save(id, snapshot, options = {}) {
    const document = clone(snapshot)
    // Keep each caller's snapshot, promise and AbortSignal independent. Preview
    // acknowledgements must also reach snapshots queued before the SSE event.
    const previewSave = { id, document, events: [] }
    this.previewSaves.add(previewSave)
    const previous = this.queues.get(id) ?? Promise.resolve()
    this.pendingSaves += 1
    const work = previous.catch(() => {}).then(() => this.saveSnapshot(id, document, options, previewSave))
    this.queues.set(id, work)
    return work.finally(() => {
      this.pendingSaves -= 1
      this.previewSaves.delete(previewSave)
      if (this.queues.get(id) === work) this.queues.delete(id)
    })
  }

  /** The preview controller collects a scan's requests, takes ONE snapshot,
   * and awaits this once before submitting the jobs. No global save coalescing. */
  savePreviewBatch(id, snapshot, options = {}) {
    return this.save(id, snapshot, options)
  }

  async saveSnapshot(id, snapshot, options, previewSave) {
    const base = this.baselines.get(id)
    if (!base) throw new Error(`Refusing a blind overwrite of ${id}: load the board before saving`)
    // Upstream debounces change events from document.load as well. A load is not
    // a local edit and must never echo an old snapshot over the server.
    if (sameDocument(base.local, snapshot)) return
    const expected = mergeDocuments(base.local, snapshot, base.server, base.server)
    const rememberSaved = (raw, revision, previewVersion) => {
      const server = clone(raw)
      const local = clone(snapshot)
      // A terminal event may arrive while the CAS response is in flight. Only
      // replay its precise fields; never claim the event's whole revision.
      for (const event of previewSave?.events.slice(previewVersion) ?? []) {
        patchPreviewDocument(server, event, true)
        patchPreviewDocument(local, event, false, true)
      }
      this.remember(id, server, local, revision, base.needsRefresh || !sameDocument(expected, server))
    }
    let conflict
    for (let attempt = 0; attempt < this.maxSaveAttempts; attempt += 1) {
      const previewVersion = previewSave?.events.length
      const latest = await transport(boardPath(id), { signal: options.signal })
      // This GET may predate a preview commit already acknowledged locally.
      // Refetch rather than PUT a document that could erase the derivative.
      if (previewSave?.events.length !== previewVersion) continue
      const revision = latest.revision ?? latest.document.revision
      if (!Number.isSafeInteger(revision)) throw new Error('The server did not return a valid revision for CAS')
      const merged = mergeDocuments(base.local, snapshot, latest.document, base.server)
      if (sameDocument(merged, latest.document)) {
        rememberSaved(latest.document, revision, previewVersion)
        return
      }
      try {
        const result = await transport(`${boardPath(id)}/replace`, {
          method: 'PUT', signal: options.signal,
          json: { expectedRevision: revision, document: merged },
        })
        // Do not re-GET here: an agent may have written after our successful CAS.
        // That newer revision belongs to polling, not to this acknowledgement.
        const saved = result?.document ?? { ...merged, revision: result?.revision ?? revision + 1 }
        rememberSaved(saved, result?.revision ?? saved.revision, previewVersion)
        return
      } catch (error) {
        if (error.status !== 409) throw error
        conflict = error
      }
    }
    throw conflict ?? new Error('Canvas save exceeded its conflict retry limit')
  }

  async rename(id, name) {
    const result = await transport(boardPath(id), { method: 'PATCH', json: { name }, allowNotFound: true })
    if (!result) return undefined
    // Renaming does not acknowledge the document currently on the server.
    const fresh = await transport(boardPath(id), { allowNotFound: true })
    if (!fresh) return undefined
    const summary = (await this.list()).find((board) => board.id === id)
    return this.project(fresh, { ...summary, name })
  }

  async delete(id, _preserveActive = false) {
    this.pendingMaintenance += 1
    this.bridge?.onSwitch()
    try {
      await this.queues.get(id)?.catch(() => {})
      await transport(boardPath(id), { method: 'DELETE', allowNotFound: true })
      this.baselines.delete(id)
      // The core owns current-board fallback. Leave the local pointer intact
      // until upstream fetches the successor and explicitly calls setActive().
    } finally { this.pendingMaintenance -= 1 }
  }

  async beforeActiveChange(id) {
    await waitForMedia()
    await this.onActiveChange?.(id, activeBoardId)
  }

  setActive(id) {
    this.pendingSwitches += 1
    const work = this.switchQueue.catch(() => {}).then(async () => {
      if (id !== activeBoardId) await this.beforeActiveChange(id)
      await transport('/current', { method: 'PUT', json: { boardId: id } })
      adoptActive(id)
      this.bridge?.onSwitch()
    }).finally(() => { this.pendingSwitches -= 1 })
    this.switchQueue = work
    return work
  }

  async clear() {
    this.pendingMaintenance += 1
    this.bridge?.onSwitch()
    try {
      await Promise.allSettled([...this.queues.values()])
      await this.beforeActiveChange(undefined)
      for (const board of await this.list()) {
        await transport(boardPath(board.id), { method: 'DELETE', allowNotFound: true })
      }
      this.baselines.clear()
      adoptActive(undefined)
      this.bridge?.onSwitch()
    } finally { this.pendingMaintenance -= 1 }
  }
}

function timestamp(value) {
  return typeof value === 'number' ? value : Date.parse(value) || 0
}

/**
 * Call after await site.dshReady. Returns an idempotent disconnect function.
 * Only the already displayed board is polled: upstream's private activeProject
 * identity is changed by its own project switcher, never by this storage layer.
 */
export function connectSite(site, options = {}) {
  const store = site.projectStore ?? getProjectStore()
  const board = site.activeBoard
  if (!board?.document?.toJSON || !board?.document?.load) throw new Error('connectSite must run after dshReady')
  store.bridge?.disconnect()
  sharedStore = store
  const media = site.mediaLibrary
  const previousHook = store.onActiveChange
  const previousLoad = board.document.load
  let stopped = false
  let loading = 0
  let importing = 0
  let lastActivity = Date.now()
  let generation = 0
  let polling = false
  const appliedFocus = new Map()
  let unmounting = false
  let displayedBoardId = activeBoardId
  pageHiding = false
  const pointers = new Set()
  const disposers = []
  const cooldown = options.idleMs ?? 650
  const interval = Math.min(2000, Math.max(1000, options.intervalMs ?? 1500))
  const root = globalThis.document
  const events = globalThis.window

  async function clearMedia() {
    await media?.dispose?.()
    site.textureCache?.clear?.()
  }
  const activeHook = async (next, previous) => {
    generation += 1
    await previousHook?.(next, previous)
    await clearMedia()
  }
  store.onActiveChange = activeHook

  function acknowledgeLocal(id, raw, local) {
    if (id && raw) store.remember(id, raw, local, raw.revision)
  }
  const initial = store.baselines.get(activeBoardId)
  if (initial) acknowledgeLocal(activeBoardId, initial.server, board.document.toJSON())

  // Wrap only the document-storage boundary. No upstream input or UI logic changes.
  const load = async function (input, loadOptions) {
    const id = activeBoardId
    const normalized = normalizeDocument(input)
    loading += 1
    generation += 1
    try {
      // Core.load mutates synchronously; capture its canonical snapshot before
      // awaiting the renderer, so user edits during rendering remain dirty.
      // Validate before mutation so a rejected load cannot acknowledge the old
      // board as though it were this incoming document.
      board.document.validate?.(normalized)
      const previous = store.baselines.get(id)
      // Keep the original raw server version, not its legacy normalization.
      const raw = previous && sameDocument(normalizeDocument(previous.server), normalized)
        ? previous.server : input
      const work = previousLoad.call(board.document, normalized, loadOptions)
      const loaded = board.document.toJSON()
      // Acknowledge synchronously, before the renderer's asynchronous load
      // event can schedule upstream's 400ms autosave. Unknown/stripped props
      // consequently never become a spurious user deletion.
      if (id === activeBoardId) {
        displayedBoardId = id
        acknowledgeLocal(id, raw, loaded)
      }
      await work
    } finally {
      loading -= 1
      lastActivity = Date.now()
    }
  }
  board.document.load = load

  // Track the outer objectUrl call too: it populates MediaLibrary's cache
  // AFTER the adapter lease promise has fulfilled. Merely draining HTTP calls
  // would leave a microtask race which could cache a revoked old-board URL.
  const originalObjectUrl = media?.objectUrl
  const wrappedObjectUrl = originalObjectUrl && async function (...args) {
    if (store.pendingSwitches) await store.switchQueue
    const finish = beginMediaOperation()
    try { return await originalObjectUrl.apply(this, args) } finally { finish() }
  }
  if (wrappedObjectUrl) media.objectUrl = wrappedObjectUrl

  // Preview generation spans awaits between its read and write. Keep the
  // ENTIRE pipeline on the old board until it finishes, not just each fetch.
  const mediaWrappers = []
  for (const name of ['importFile', 'refreshPreview', 'updateVideoPreviewFromElement', 'clear']) {
    const original = media?.[name]
    if (typeof original !== 'function') continue
    const wrapped = async function (...args) {
      if (store.pendingSwitches) await store.switchQueue
      const finish = beginMediaOperation()
      importing += 1
      try { return await original.apply(this, args) } finally {
        importing -= 1
        finish()
        lastActivity = Date.now()
      }
    }
    media[name] = wrapped
    mediaWrappers.push({ name, original, wrapped })
  }

  if (board.on) {
    const off = board.on('change', (event) => {
      if ((event?.changeSet?.origin ?? event?.origin) !== 'load') {
        generation += 1
        lastActivity = Date.now()
      }
    })
    if (typeof off === 'function') disposers.push(off)
    const offViewport = board.on('viewport:change', () => { lastActivity = Date.now() })
    if (typeof offViewport === 'function') disposers.push(offViewport)
  }
  const listen = (type, handler) => {
    events?.addEventListener(type, handler, true)
    disposers.push(() => events?.removeEventListener(type, handler, true))
  }
  listen('pointerdown', (event) => { pointers.add(event.pointerId); lastActivity = Date.now() })
  listen('pointerup', (event) => { pointers.delete(event.pointerId); lastActivity = Date.now() })
  listen('pointercancel', (event) => { pointers.delete(event.pointerId); lastActivity = Date.now() })
  listen('blur', () => { pointers.clear(); lastActivity = Date.now() })
  listen('keydown', () => { lastActivity = Date.now() })
  listen('wheel', () => { lastActivity = Date.now() })
  listen('pagehide', () => { pageHiding = true })
  listen('pageshow', () => { pageHiding = false; unmounting = false })

  function busy() {
    const lock = root?.querySelector('#import-lock')
    const editor = root?.activeElement
    return stopped || unmounting || loading > 0 || importing > 0 || pendingMedia > 0 || store.pendingSaves > 0 || store.pendingSwitches > 0 || store.pendingMaintenance > 0 || pointers.size > 0
      || (lock && !lock.hidden) || editor?.isContentEditable
      || /^(INPUT|TEXTAREA|SELECT)$/.test(editor?.tagName ?? '')
      || Date.now() - lastActivity < cooldown || root?.visibilityState === 'hidden'
      || options.isBusy?.() === true
  }

  function applyRequestedFocus(id, request) {
    if (!request || request.expiresAt <= Date.now() || appliedFocus.get(id) === request.id) return
    if (id !== activeBoardId) return
    const host = document.querySelector('#board-host')
    const width = host?.clientWidth, height = host?.clientHeight
    if (!(width > 0 && height > 0)) return
    const current = board.viewport.get()
    const center = { x: width / 2, y: height / 2 }
    const action = request.action || 'fit'
    if (action === 'pan') board.viewport.panBy(request.dx, request.dy)
    else if (action === 'zoom') {
      board.viewport.zoomAt(center, request.factor ?? request.scale / current.scale)
    } else if (action === 'reset') board.viewport.set({ scale: 1, offset: { x: 0, y: 0 } })
    else {
      const b = request.bounds
      if (!b) return
      const padding = Math.min(request.padding ?? 72, Math.max(0, (Math.min(width, height) - 1) / 2))
      const scale = action === 'center' ? request.scale ?? current.scale : Math.min(
        Math.max(1, width - 2 * padding) / Math.max(1, b.maxX - b.minX),
        Math.max(1, height - 2 * padding) / Math.max(1, b.maxY - b.minY), request.scale ?? 1)
      board.viewport.set({ scale, offset: {
        x: center.x - (b.minX + (b.maxX - b.minX) / 2) * scale,
        y: center.y - (b.minY + (b.maxY - b.minY) / 2) * scale,
      } })
    }
    appliedFocus.set(id, request.id)
    while (appliedFocus.size > 64) appliedFocus.delete(appliedFocus.keys().next().value)
  }

  async function poll() {
    if (polling || busy()) return
    const id = activeBoardId
    const base = store.baselines.get(id)
    if (!id || !base) return
    const before = board.document.toJSON()
    if (!sameDocument(base.local, before)) return
    polling = true
    const version = generation
    try {
      const remote = await transport(boardPath(id), { allowNotFound: true })
      if (!remote?.document || busy() || version !== generation || id !== activeBoardId
        || !sameDocument(before, board.document.toJSON())) return
      if (equal(remote.document, base.server) && !base.needsRefresh) {
        applyRequestedFocus(id, remote.focusRequest)
        return
      }
      // A successful merge can contain remote nodes which the displayed board
      // has not seen yet, even when the server revision hasn't changed again.
      await clearMedia()
      if (busy() || version !== generation || id !== activeBoardId
        || !sameDocument(before, board.document.toJSON())) return
      await board.document.load(remote.document, { replaceHistory: true })
      if (version === generation && id === activeBoardId) applyRequestedFocus(id, remote.focusRequest)
    } catch (error) {
      if (options.onError) options.onError(error)
      else console.warn('Canvas remote refresh failed', error)
    } finally {
      polling = false
    }
  }
  const timer = setInterval(() => void poll(), interval)
  const previousBeforeUnmount = events?.__dshCanvasBeforeUnmount
  const beforeUnmount = () => {
    // Synchronous transfer only. The parent must own ALL subsequent fetches;
    // never return a promise or a callback that starts an iframe-side request.
    pageHiding = true
    unmounting = true
    const id = displayedBoardId
    const base = store.baselines.get(id)
    if (!id || !base) return undefined
    const snapshot = board.document.toJSON()
    if (sameDocument(base.local, snapshot)) return undefined
    return {
      boardId: id, snapshot: clone(snapshot), baseline: clone(base.local),
      rawBaseline: clone(base.server), mergeDocuments,
    }
  }
  if (events) events.__dshCanvasBeforeUnmount = beforeUnmount
  // Serialize only preview callbacks, never behind save, pointer or idle locks.
  let previewQueue = Promise.resolve()
  const appliedPreviews = new Map()
  function scheduleSync() {
    const base = store.baselines.get(displayedBoardId)
    if (base) base.needsRefresh = true
    // poll() owns all busy/dirty/generation guards, including type reloads.
    void poll()
  }
  async function applyPreviewEvent(input) {
    const { job, nodePatch, asset } = input ?? {}
    if (!object(job) || !object(nodePatch) || !object(nodePatch.props)
      || !job.boardId || !job.assetId || !job.requestId || !nodePatch.id) return { applied: false, reason: 'invalid-event' }
    if (stopped || unmounting || loading || job.boardId !== activeBoardId || job.boardId !== displayedBoardId
      || store.pendingSwitches || store.pendingMaintenance) return { applied: false, reason: 'inactive-board' }
    const node = board.nodes.get(nodePatch.id)
    if (!previewTarget(node, job)) return { applied: false, reason: 'stale-target' }
    if (asset && asset.id !== job.assetId) return { applied: false, reason: 'asset-mismatch' }
    if (object(nodePatch.assetRefs) && Object.entries(nodePatch.assetRefs).some(([key, ref]) =>
      previewRef(key) && ref?.assetId !== job.assetId)) return { applied: false, reason: 'asset-mismatch' }
    if (!store.baselines.has(job.boardId)) return { applied: false, reason: 'missing-baseline' }
    const key = JSON.stringify([job.boardId, nodePatch.id, job.assetId, job.requestId])
    const previous = appliedPreviews.get(nodePatch.id)
    const status = nodePatch.props.previewStatus ?? job.status
    if (PREVIEW_TERMINAL.has(node.props?.previewStatus) && !PREVIEW_TERMINAL.has(status)) {
      return { applied: false, reason: 'stale-status' }
    }
    if (previous?.key === key && PREVIEW_TERMINAL.has(previous.status)) return { applied: false, reason: 'already-terminal' }
    if (previous?.key === key && previous.status === 'running' && ['pending', 'queued'].includes(status)) {
      return { applied: false, reason: 'stale-status' }
    }
    const event = clone({ job, nodePatch, ...(asset ? { asset } : {}) })
    const before = store.baselines.get(job.boardId)?.local.nodes?.find((item) => item.id === node.id)
    if (previewTarget(before, job)) event.geometryBaseline = { width: before.width, height: before.height }
    const patch = previewNodePatch(node, event.nodePatch)
    if (canApplyPreviewHeight(node, event)) patch.height = previewHeight(event)
    const currentAsset = board.document.toJSON().assets?.find((item) => item.id === job.assetId)
    const nextAsset = previewAsset(currentAsset, event.asset)
    const typeChanged = Boolean(nodePatch.type && nodePatch.type !== node.type)
    // References, not the asset's summary metadata, select the derivative.
    // Immutable preview-<cacheKey> URLs/textures remain valid, including old
    // variants still shared by other nodes. Only a mutable legacy preview can
    // have stale bytes under the same key; invalidate it before rendering.
    const newVariants = new Set(Object.entries(patch.assetRefs ?? {})
      .filter(([name, ref]) => previewRef(name) && ref.assetId === job.assetId)
      .map(([, ref]) => ref.variant ?? 'original'))
    if (status === 'ready' && newVariants.has('preview')) {
      media?.revokeLease?.(job.assetId, 'preview')
      site.textureCache?.delete?.(`${job.assetId}:preview`)
    }
    try {
      if (board.capabilities?.nodes?.update) {
        // The facade's asset upsert lives on capabilities. This SDK operation
        // performs asset upsert + nodes.update in one synchronous transaction.
        await board.capabilities.nodes.update({ nodes: [{ id: node.id, patch,
          ...(nextAsset && !equal(currentAsset, nextAsset) ? { asset: nextAsset } : {}) }] }, { origin: 'preview' })
      } else if (!nextAsset || equal(currentAsset, nextAsset) || board.assets?.upsert) {
        board.transaction('Apply document preview', () => {
          if (nextAsset && !equal(currentAsset, nextAsset)) board.assets.upsert(nextAsset)
          board.nodes.update(node.id, patch)
        }, { origin: 'preview' })
      } else {
        scheduleSync()
        return { applied: false, reason: 'sdk-unavailable', deferred: true }
      }
    } catch (error) {
      scheduleSync()
      throw error
    }
    // Only these server fields are acknowledged. User edits elsewhere remain
    // dirty, and revision stays at the last full load/CAS acknowledgement.
    const base = store.baselines.get(job.boardId)
    if (PREVIEW_TERMINAL.has(status) && base) {
      patchPreviewDocument(base.server, event, true)
      // Record only an explicit automatic fit. Unchanged displayed/queued
      // geometry adopts it; retained user geometry stays dirty against it.
      patchPreviewDocument(base.local, event, false, true)
      for (const save of store.previewSaves) if (save.id === job.boardId) {
        patchPreviewDocument(save.document, event)
        save.events.push(event)
      }
    }
    if (typeChanged && base) base.needsRefresh = true
    appliedPreviews.set(nodePatch.id, { key, status })
    return { applied: true, deferred: typeChanged, nodeId: node.id, assetId: job.assetId }
  }
  const bridge = {
    /** Promise<{ applied, reason?, deferred? }>. Pass the service event directly;
     * terminal results are already persisted and must not trigger another save. */
    applyPreview(event) {
      const input = clone(event)
      const work = previewQueue.catch(() => {}).then(() => applyPreviewEvent(input))
      previewQueue = work
      return work
    },
    scheduleSync,
    savePreviewBatch(id, snapshot, saveOptions = {}) {
      return store.savePreviewBatch(id, snapshot, saveOptions)
    },
    onSwitch() { appliedPreviews.clear(); generation += 1; lastActivity = Date.now() },
    disconnect() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      for (const dispose of disposers) dispose()
      if (board.document.load === load) board.document.load = previousLoad
      for (const { name, original, wrapped } of mediaWrappers) {
        if (media?.[name] === wrapped) media[name] = original
      }
      if (media?.objectUrl === wrappedObjectUrl) media.objectUrl = originalObjectUrl
      if (events?.__dshCanvasBeforeUnmount === beforeUnmount) {
        if (previousBeforeUnmount === undefined) delete events.__dshCanvasBeforeUnmount
        else events.__dshCanvasBeforeUnmount = previousBeforeUnmount
      }
      if (store.onActiveChange === activeHook) store.onActiveChange = previousHook
      if (store.bridge === bridge) store.bridge = undefined
    },
  }
  store.bridge = bridge
  return bridge.disconnect
}
