import {
  transport, boardPath, getActiveBoardId, activeBoardId,
  getProjectStore, beginMediaOperation, onActiveBoardChange,
} from './store.js'

/** Compatibility configs only. No IndexedDB/OPFS database is opened. */
export class NativeIndexedDbPort {
  constructor(options = {}) { this.options = options }
}

export class NativeOpfsPort {
  constructor(options = {}) { this.options = options }
  async isAvailable() { return false }
}

export class NativeObjectUrlPort {
  constructor(url = globalThis.URL) { this.url = url }
  create(blob) { return this.url.createObjectURL(blob) }
  revoke(url) { this.url.revokeObjectURL(url) }
}

const clone = (value) => value === undefined ? undefined : structuredClone(value)
const variantOf = (options = {}) => options.variant ?? 'original'
const assetPath = (boardId, assetId, variant) => `${boardPath(boardId)}/assets/${encodeURIComponent(assetId)}${variant === undefined ? '' : `/${encodeURIComponent(variant)}`}`

function abortError(message = 'Canvas asset operation was cancelled') {
  return new DOMException(message, 'AbortError')
}

function checkSignal(signal) {
  if (signal?.aborted) throw signal.reason ?? abortError()
}

function inferKind(mimeType) {
  const type = mimeType.split('/')[0]
  return ['image', 'video', 'audio', 'text'].includes(type) ? type : 'file'
}

function entryFor(boardId, record, variant = 'original', blob) {
  const metadata = record.metadata ?? {}
  record = { ...record, metadata: { ...metadata, name: metadata.name ?? metadata.fileName ?? '' } }
  const binary = {
    variant,
    mimeType: blob?.type || metadata.mimeType || 'application/octet-stream',
    size: blob?.size ?? metadata.size ?? 0,
    storage: { kind: 'http', key: assetPath(boardId, record.id, variant) },
  }
  return {
    id: record.id, boardId, record: clone(record), variant,
    binaries: { [variant]: binary },
    createdAt: metadata.createdAt ?? 0,
    updatedAt: metadata.updatedAt ?? 0,
  }
}

/** Same MediaLibrary-facing API as the browser adapter, backed exclusively by core HTTP. */
export class BrowserPersistenceAdapter {
  constructor(options = {}) {
    this.options = options
    this.objectUrls = options.objectUrls ?? new NativeObjectUrlPort()
    this.leases = new Map()
    this.epoch = 0
    this.abortController = new AbortController()
    this.cleanupErrors = []
    // Scoped keys plus invalidation cover direct adapter users too. The site's
    // own unscoped caches are cleared by store.onActiveChange before switching.
    this.unsubscribeActive = onActiveBoardChange(() => this.revokeAll())
  }

  get signal() { return this.abortController.signal }
  get destroyed() { return false }

  async run(options, operation) {
    checkSignal(options?.signal)
    const finish = beginMediaOperation()
    try {
      const boardId = options?.boardId ?? await getActiveBoardId()
      checkSignal(options?.signal)
      const result = await operation(boardId)
      checkSignal(options?.signal)
      return result
    } finally { finish() }
  }

  async capabilities() {
    return {
      persistence: true, indexedDb: false, opfs: false, blobFallback: true,
      import: ['file', 'blob', 'text', 'url'], objectUrl: true,
      download: this.options.download !== undefined, desktopFileSystem: false,
    }
  }

  async load(options = {}) { return (await this.loadDocument(options))?.snapshot ?? null }
  async save(snapshot, options = {}) { await this.saveDocument({ snapshot }, options) }

  async loadDocument(options = {}) {
    return this.run(options, async (boardId) => {
      const project = await getProjectStore().get(boardId)
      return project ? {
        snapshot: project.document, metadata: {},
        savedAt: project.updatedAt, revision: project.revision,
      } : null
    })
  }

  async saveDocument(input, options = {}) {
    return this.run(options, async (boardId) => {
      // There is one document: the project's core snapshot. Never write a
      // separate "media document" when the upstream legacy API is called.
      await getProjectStore().save(boardId, input.snapshot, { signal: options.signal })
    })
  }

  async readRecord(boardId, id, signal) {
    const result = await transport(boardPath(boardId), { signal, allowNotFound: true })
    return result?.document?.assets?.find((record) => record.id === id)
  }

  async put(boardId, record, blob, options = {}) {
    const variant = variantOf(options)
    const metadata = record.metadata ?? {}
    const mimeType = blob.type || metadata.mimeType || 'application/octet-stream'
    const fileName = metadata.name || metadata.fileName || blob.name || `${record.id}.bin`
    const query = new URLSearchParams({ mimeType, fileName, kind: record.kind || inferKind(mimeType) })
    if (variant === 'original') query.set('assetRecord', JSON.stringify(record))
    const result = await transport(`${assetPath(boardId, record.id, variant)}?${query}`, {
      method: 'PUT', body: blob, signal: options.signal,
      headers: { 'content-type': mimeType },
    })
    this.revokeAsset(boardId, record.id, variant)
    return entryFor(boardId, result?.asset ?? result?.assetRecord ?? record, variant, blob)
  }

  async putAsset(record, blob, options = {}) {
    if (!record?.id) throw new TypeError('Asset record requires an id')
    return this.run(options, (boardId) => this.put(boardId, record, blob, options))
  }

  async putDerivative(assetId, variant, blob, options = {}) {
    if (variant === 'original') throw new TypeError('putDerivative requires a derivative variant')
    return this.run(options, async (boardId) => {
      const record = await this.readRecord(boardId, assetId, options.signal)
      if (!record) throw new Error(`Asset ${assetId} does not exist on board ${boardId}`)
      return this.put(boardId, record, blob, { ...options, variant })
    })
  }

  async getAsset(id, options = {}) {
    return this.run(options, async (boardId) => {
      const variant = variantOf(options)
      const [blob, record] = await Promise.all([
        transport(assetPath(boardId, id, variant), { raw: true, allowNotFound: true, signal: options.signal }),
        this.readRecord(boardId, id, options.signal),
      ])
      if (!blob) return null
      const resolved = record ?? { id, kind: inferKind(blob.type), metadata: { mimeType: blob.type, size: blob.size } }
      const entry = entryFor(boardId, resolved, variant, blob)
      return { blob, entry, variant, binary: entry.binaries[variant] }
    })
  }

  async resolveAsset(id, variant = 'original', options = {}) {
    return this.getAsset(id, { ...options, variant })
  }

  async listAssets(options = {}) {
    return this.run(options, async (boardId) => {
      const result = await transport(boardPath(boardId), { signal: options.signal, allowNotFound: true })
      return (result?.document?.assets ?? []).map((record) => entryFor(boardId, record))
        .sort((a, b) => a.id.localeCompare(b.id))
    })
  }

  async deleteAsset(id, options = {}) {
    return this.run(options, async (boardId) => {
      const result = await transport(assetPath(boardId, id), { method: 'DELETE', signal: options.signal, allowNotFound: true })
      this.revokeAsset(boardId, id)
      return result !== undefined
    })
  }

  async leaseObjectUrl(id, options = {}) {
    return this.run(options, async (boardId) => {
      const epoch = this.epoch
      const variant = variantOf(options)
      const asset = await this.getAsset(id, { ...options, boardId, variant })
      if (!asset) throw new Error(`Asset ${id}/${variant} does not exist on board ${boardId}`)
      if (epoch !== this.epoch || (activeBoardId && boardId !== activeBoardId)) throw abortError('The active canvas changed')
      const key = JSON.stringify([boardId, id, variant])
      const url = this.objectUrls.create(asset.blob)
      let revoked = false
      const lease = {
        boardId, assetId: id, variant, url,
        get revoked() { return revoked },
        revoke: () => {
          if (revoked) return
          revoked = true
          this.objectUrls.revoke(url)
          const entries = this.leases.get(key)
          entries?.delete(lease)
          if (entries?.size === 0) this.leases.delete(key)
        },
      }
      const entries = this.leases.get(key) ?? new Set()
      entries.add(lease)
      this.leases.set(key, entries)
      return lease
    })
  }

  revokeAsset(boardId, id, variant) {
    for (const entries of [...this.leases.values()]) {
      for (const lease of [...entries]) {
        if (lease.boardId === boardId && lease.assetId === id && (variant === undefined || lease.variant === variant)) lease.revoke()
      }
    }
  }

  revokeAll() {
    this.epoch += 1
    for (const entries of [...this.leases.values()]) for (const lease of [...entries]) lease.revoke()
  }

  /** Upstream reuses its MediaLibrary after project switching. This is a reset,
   * not a permanent shutdown; pending old leases cannot reappear afterward. */
  async destroy() { this.revokeAll() }

  async exportAsset(id, options = {}) {
    const asset = await this.getAsset(id, options)
    if (!asset) throw new Error(`Asset ${id} does not exist`)
    const metadata = asset.entry.record.metadata ?? {}
    return {
      assetId: id, variant: variantOf(options), blob: asset.blob,
      fileName: options.fileName ?? metadata.fileName ?? metadata.name ?? `${id}.bin`,
      mimeType: asset.blob.type,
    }
  }

  async downloadAsset(id, options = {}) {
    if (!this.options.download) throw new Error('No download port was configured')
    const result = await this.exportAsset(id, options)
    const url = this.objectUrls.create(result.blob)
    try {
      await this.options.download.download({ url, fileName: result.fileName, mimeType: result.mimeType })
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally { this.objectUrls.revoke(url) }
    return result
  }

  async prepareFile(file, options = {}) { return this.prepare('file', file, file.name, options) }
  async prepareBlob(blob, options = {}) { return this.prepare('blob', blob, options.name, options) }
  async prepareText(text, options = {}) {
    const mimeType = options.mimeType ?? 'text/plain;charset=utf-8'
    return this.prepare('text', new Blob([text], { type: mimeType }), options.name ?? 'untitled.txt', {
      ...options, mimeType, kind: options.kind ?? 'text',
    })
  }
  async prepareUrl(url, options = {}) {
    const response = await (this.options.fetch ?? fetch)(url, { ...options.request, signal: options.signal })
    if (!response.ok) throw new Error(`Asset import failed (${response.status})`)
    const name = options.name ?? decodeURIComponent(new URL(url).pathname.split('/').pop() || '')
    return this.prepare('url', await response.blob(), name, options, { sourceUrl: url })
  }
  prepare(sourceType, input, name, options, extraMetadata = {}) {
    checkSignal(options.signal)
    const id = options.assetId ?? this.options.idFactory?.() ?? crypto.randomUUID()
    const mimeType = options.mimeType ?? (input.type || 'application/octet-stream')
    const blob = input.type === mimeType ? input : input.slice(0, input.size, mimeType)
    const fileName = options.name ?? name ?? `${id}.bin`
    const asset = { id, kind: options.kind ?? inferKind(mimeType), metadata: {
      fileName, mimeType, size: blob.size, sourceType, ...extraMetadata, ...options.assetMetadata,
    } }
    return { sourceType, asset, blob, fileName }
  }
  async commitImport(prepared, options = {}) {
    if (!options.document) throw new TypeError('commitImport requires the previously loaded document')
    return this.run(options, async (boardId) => {
      const document = clone(options.document)
      const id = options.nodeId ?? `node-${this.options.idFactory?.() ?? crypto.randomUUID()}`
      if (document.nodes.some((node) => node.id === id)) throw new Error(`Node already exists: ${id}`)
      const asset = prepared.asset
      const node = {
        id, type: options.nodeType ?? (['image', 'video', 'audio', 'text'].includes(asset.kind) ? asset.kind : 'file'),
        typeVersion: 1, name: asset.metadata?.fileName ?? asset.id,
        x: options.x ?? 0, y: options.y ?? 0, width: options.width ?? 320,
        height: options.height ?? (asset.kind === 'text' ? 80 : 180), rotation: 0,
        zIndex: options.zIndex ?? document.nodes.length,
        assetRefs: { primary: { assetId: asset.id, variant: 'original' } },
        props: options.nodeProps ?? (asset.kind === 'text' ? { text: await prepared.blob.text() } : {}),
      }
      document.assets = [...document.assets.filter((record) => record.id !== asset.id), clone(asset)]
      document.nodes.push(node)
      document.revision += 1
      // The byte endpoint and document CAS are separate transactions. On a
      // failed save keep the durable asset rather than deleting a possible
      // concurrent writer's replacement; callers receive the save failure.
      const entry = await this.put(boardId, asset, prepared.blob, { ...options, variant: 'original' })
      await getProjectStore().save(boardId, document, { signal: options.signal })
      return { sourceType: prepared.sourceType, document, asset: clone(asset), node: clone(node), entry }
    })
  }
  async importFile(file, options = {}) { return this.commitImport(await this.prepareFile(file, options), options) }
  async importBlob(blob, options = {}) { return this.commitImport(await this.prepareBlob(blob, options), options) }
  async importText(text, options = {}) { return this.commitImport(await this.prepareText(text, options), options) }
  async importUrl(url, options = {}) { return this.commitImport(await this.prepareUrl(url, options), options) }

  async collectAssetGarbage(options = {}) {
    // There is no durable quarantine API. Do not invent another local database
    // or delete records whose concurrent/history roots we cannot prove absent.
    const roots = new Set()
    for (const key of ['assetIds', 'historyAssetIds', 'activeJobAssetIds', 'explicitLeaseAssetIds']) {
      for (const id of options[key] ?? []) roots.add(id)
    }
    const entries = await this.listAssets(options)
    return { roots: [...roots], retained: entries.map((entry) => entry.id), quarantined: [], restored: [], deleted: [] }
  }
}
