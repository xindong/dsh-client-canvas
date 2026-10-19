import { getCanvasSettings } from './settings.js'
// Viewport is browser UI state, separate from the shared/agent-owned document.
// Session storage survives iframe/tab-view remounts and page refreshes.
const PREFIX = 'dsh-canvas:viewport:v1:'
const memory = new Map()
function limits() { const c = getCanvasSettings().canvas; return { min: c.minZoom / 100, max: c.maxZoom / 100 } }
function limitViewport(viewport, host) {
  if (!valid(viewport)) return viewport
  const scale = Math.max(limits().min, Math.min(limits().max, viewport.scale))
  if (scale === viewport.scale) return viewport
  const center = { x: (host?.clientWidth || 0) / 2, y: (host?.clientHeight || 0) / 2 }
  const ratio = scale / viewport.scale
  return { ...viewport, scale, offset: {
    x: center.x - (center.x - viewport.offset.x) * ratio,
    y: center.y - (center.y - viewport.offset.y) * ratio
  } }
}


function valid(value) {
  return value && Number.isFinite(value.scale) && value.scale > 0
    && Number.isFinite(value.offset?.x) && Number.isFinite(value.offset?.y)
}

function screen(host) {
  const width = host?.clientWidth
  const height = host?.clientHeight
  return width > 0 && height > 0 ? { width, height } : undefined
}

function read(id) {
  if (!id) return undefined
  if (memory.has(id)) return memory.get(id)
  try {
    const saved = JSON.parse(globalThis.sessionStorage?.getItem(PREFIX + id) ?? 'null')
    if (valid(saved?.viewport)) { memory.set(id, saved); return saved }
  } catch { /* Storage may be unavailable or contain an obsolete value. */ }
  return undefined
}

export function rememberViewport(board, id, host) {
  if (!id) return
  const viewport = board.viewport.get()
  if (!valid(viewport)) return
  const saved = { viewport, screen: screen(host) }
  memory.set(id, saved)
  try { globalThis.sessionStorage?.setItem(PREFIX + id, JSON.stringify(saved)) } catch {}
}

function savedViewport(id, host) {
  const saved = read(id)
  if (!saved) return undefined
  const viewport = structuredClone(saved.viewport)
  const current = screen(host)
  // Keep the same world point centered when a different conversation/sidebar
  // gives this iframe a different size. Scale remains unchanged.
  if (current && saved.screen?.width > 0 && saved.screen?.height > 0) {
    viewport.offset.x += (current.width - saved.screen.width) / 2
    viewport.offset.y += (current.height - saved.screen.height) / 2
  }
  return viewport
}

// Initialize the SDK camera before its first renderer pass. Keep the server
// document untouched: this camera belongs only to the local browser view.
export function documentWithViewport(document, id, host) {
  const viewport = savedViewport(id, host)
  const limited = limitViewport(viewport || document.viewport, host)
  return limited ? { ...document, viewport: limited } : document
}

export function restoreViewport(board, id, host) {
  const viewport = savedViewport(id, host)
  if (!viewport) return false
  board.viewport.set(viewport)
  return true
}

export function fitInitialViewport(board, id, host, bounds) {
  if (!restoreViewport(board, id, host)) board.viewport.fitBounds(bounds)
}

export function attachViewportPersistence(board, getBoardId, host) {
  const viewport = board.viewport
  const originalSet = viewport.set.bind(viewport)
  const originalZoom = viewport.zoomAt.bind(viewport)
  const originalFit = viewport.fitBounds.bind(viewport)
  viewport.set = value => originalSet(limitViewport(value, host))
  viewport.zoomAt = (point, factor) => {
    if (!Number.isFinite(factor) || factor <= 0) return originalZoom(point, factor)
    const current = viewport.get().scale
    const next = Math.max(limits().min, Math.min(limits().max, current * factor))
    return originalZoom(point, next / current)
  }
  viewport.fitBounds = (...args) => {
    const result = originalFit(...args)
    viewport.set(viewport.get())
    return result
  }
  viewport.set(viewport.get())
  let displayedId = getBoardId()
  let restoring = false
  const events = globalThis.window
  const save = () => rememberViewport(board, displayedId, host)
  restoreViewport(board, displayedId, host)

  board.on('viewport:change', () => {
    // document.load emits viewport:change synchronously. Do not mistake its
    // old/default camera for a user pan, or attribute it to the outgoing board.
    if (!restoring && displayedId === getBoardId()) save()
  })
  const previousLoad = board.document.load
  board.document.load = function (input, options) {
    board.document.validate?.(input)
    save()
    const nextId = getBoardId()
    restoring = true
    try {
      const work = previousLoad.call(this, input, options)
      // SDK core load mutates synchronously, before its renderer promise.
      // Restore here, without waiting for media decoding or another frame.
      displayedId = nextId
      restoreViewport(board, displayedId, host)
      viewport.set(viewport.get())
      return work
    } finally { restoring = false }
  }
  if (events) {
    events.__dshCanvasRememberViewport = save
    events.addEventListener('pagehide', save)
  }
}
