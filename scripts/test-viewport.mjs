// Runtime regression checks; no frontend build or typecheck.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { adaptSource } from '../lib/site-server.js'

const storage = new Map()
globalThis.sessionStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
}
globalThis.window = new EventTarget()
const host = { clientWidth: 800, clientHeight: 600 }
function createBoard(initial) {
  const events = new EventEmitter()
  let viewport = structuredClone(initial)
  let resolveLoad
  const board = {
    on(event, fn) { events.on(event, fn); return () => events.off(event, fn) },
    viewport: {
      get: () => structuredClone(viewport),
      set(value) { viewport = structuredClone(value); events.emit('viewport:change', { viewport }) },
      fitBounds() { this.set({ scale: 0.25, offset: { x: 80, y: 90 } }) },
    },
    document: {
      validate(input) { if (input.invalid) throw new Error('Invalid document') },
      load(input) {
        board.viewport.set(input.viewport)
        return new Promise(resolve => { resolveLoad = resolve })
      },
    },
    finishLoad() { resolveLoad?.() },
  }
  return board
}
const identity = { scale: 1, offset: { x: 0, y: 0 } }
const desired = { scale: 2.5, offset: { x: -480, y: 210 } }
let adapter = await import('../lib/site/adapters/viewport.js?first')
let id = 'board-a'
let board = createBoard(identity)
adapter.attachViewportPersistence(board, () => id, host)
adapter.fitInitialViewport(board, id, host, {})
assert.equal(board.viewport.get().scale, 0.25, 'first visit can still fit all')
board.viewport.set(desired)
window.__dshCanvasRememberViewport()

// A fresh iframe has fresh module state. The persisted camera must win before
// async image/model loading completes, and remain stable once it completes.
adapter = await import('../lib/site/adapters/viewport.js?remount')
board = createBoard(identity)
adapter.attachViewportPersistence(board, () => id, host)
assert.deepEqual(board.viewport.get(), desired, 'tab remount restores pan and zoom')
adapter.fitInitialViewport(board, id, host, {})
assert.deepEqual(board.viewport.get(), desired, 'late startup fit must not snap')
const remoteLoad = board.document.load({ viewport: identity })
assert.deepEqual(board.viewport.get(), desired, 'remote load restores camera synchronously')
const duringLoad = { scale: 4, offset: { x: -20, y: 70 } }
board.viewport.set(duringLoad)
board.finishLoad()
await remoteLoad
assert.deepEqual(board.viewport.get(), duringLoad, 'late renderer completion must not rewind new pan/zoom')

// Execute the actual adapted upstream startup while model decoding is blocked.
// The canvas must be appended with the saved stage transform and HUD, and
// completing the slow preview work must not fit or rewind a new user camera.
const serverDocument = { viewport: identity, nodes: [] }
const initialDocument = adapter.documentWithViewport(serverDocument, id, host)
assert.deepEqual(initialDocument.viewport, duringLoad, 'SDK starts with saved camera')
assert.deepEqual(serverDocument.viewport, identity, 'server document stays untouched')
const upstream = await readFile(new URL('../lib/site/upstream/apps/site/src/main.ts', import.meta.url), 'utf8')
const site = stripTypeScriptTypes(adaptSource(upstream, '/apps/site/src/main.ts'))
const startup = site.slice(site.indexOf('  const board = await createPixiBoard({'), site.indexOf('\n}\n\n/**\n * Turns a document asset reference'))
const stageFunction = site.slice(site.indexOf('function wireStageTransform('), site.indexOf('\n// Selection outlines'))
const bindStage = new Function(stageFunction + '; return wireStageTransform;')()
let stageScale, stageOffset, startupBoard, appendedCamera, hudCamera
let finishPreview, previewStarted
const waitingForPreview = new Promise(resolve => { previewStarted = resolve })
const previewWork = new Promise(resolve => { finishPreview = resolve })
const application = {
  canvas: {},
  stage: {
    scale: { set(x) { stageScale = x } },
    position: { set(x, y) { stageOffset = { x, y } } },
  },
  render() {},
}
const startupHost = { ...host, appendChild() {
  appendedCamera = { scale: stageScale, offset: stageOffset }
} }
const noop = () => ({})
const deps = {
  createPixiBoard: async options => { startupBoard = createBoard(options.document.viewport); return startupBoard },
  host: startupHost, restored: { document: serverDocument }, activeProject: { id }, nodeTypes: {},
  documentWithViewport: adapter.documentWithViewport,
  attachViewportPersistence: adapter.attachViewportPersistence,
  fitInitialViewport: adapter.fitInitialViewport,
  wireStatus(board) {
    const update = () => { hudCamera = board.viewport.get() }
    board.on('viewport:change', update); update()
  },
  computeContentBounds: noop, padBounds: noop, wireStageTransform: bindStage, application,
  refreshModelPreviews() { previewStarted(); return previewWork },
  activeBoard: undefined, statusText: {},
  wireSelectionOverlay: noop, wireMediaBadges: noop, wireProjectMenu: noop,
  wirePointerInteractions: noop, wireMediaPlayerViewer: noop, wireSelectionActions: noop,
  wireClipboardAndContextMenu: noop, wireToolbar: noop, wireMediaUpload: noop, wirePersistence: noop,
}
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const starting = new AsyncFunction(...Object.keys(deps), startup)(...Object.values(deps))
await waitingForPreview
assert.deepEqual(appendedCamera, duringLoad, 'first visible Pixi frame uses saved camera')
assert.deepEqual(hudCamera, duringLoad, 'startup HUD matches saved camera')
const startupPan = { scale: 0.4, offset: { x: 270, y: -120 } }
startupBoard.viewport.set(startupPan)
finishPreview(); await starting
assert.deepEqual(startupBoard.viewport.get(), startupPan, 'preview completion cannot rewind camera')
assert.deepEqual({ scale: stageScale, offset: stageOffset }, startupPan, 'stage keeps camera after startup')
// Restore the original test board camera for the remaining project checks.
adapter.rememberViewport(board, id, host)

// Switching projects keeps distinct cameras and must not save incoming default
// viewport over the outgoing project's camera.
id = 'board-b'
let load = board.document.load({ viewport: identity })
adapter.fitInitialViewport(board, id, host, {})
const other = { scale: 0.7, offset: { x: 900, y: -630 } }
board.viewport.set(other)
board.finishLoad(); await load
id = 'board-a'
load = board.document.load({ viewport: identity })
assert.deepEqual(board.viewport.get(), duringLoad, 'project A retains its own camera')
adapter.fitInitialViewport(board, id, host, {})
board.finishLoad(); await load
assert.deepEqual(board.viewport.get(), duringLoad)
id = 'board-b'
load = board.document.load({ viewport: identity })
assert.deepEqual(board.viewport.get(), other, 'project B retains its own camera')
board.finishLoad(); await load

// Manual fit remains available, including saving its resulting viewport.
board.viewport.fitBounds({})
assert.equal(board.viewport.get().scale, 0.25, 'manual fit still works')
board.viewport.set(other)
host.clientWidth = 600; host.clientHeight = 400
adapter = await import('../lib/site/adapters/viewport.js?different-conversation')
board = createBoard(identity)
adapter.attachViewportPersistence(board, () => id, host)
assert.deepEqual(board.viewport.get(), { scale: 0.7, offset: { x: 800, y: -730 } }, 'different-sized view keeps same world center')
assert.throws(() => board.document.load({ invalid: true }), /Invalid document/)
assert.deepEqual(board.viewport.get(), { scale: 0.7, offset: { x: 800, y: -730 } }, 'failed load does not change camera')
console.log('Viewport runtime regression checks passed: first visible frame, slow preview startup, remount, delayed fit/load, separate projects, manual fit, resized host, invalid load.')
