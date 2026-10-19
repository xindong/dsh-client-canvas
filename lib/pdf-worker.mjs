import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
let root
let createCanvas
let pdf
let ready = false
let busy = false
let stopping = false
let count = 0
class CanvasFactory {
  create(width, height) {
    const canvas = createCanvas(Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)))
    return { canvas, context: canvas.getContext('2d') }
  }
  reset(target, width, height) { target.canvas.width = width; target.canvas.height = height }
  destroy(target) { target.canvas.width = 1; target.canvas.height = 1; target.canvas = null; target.context = null }
}
async function render(input) {
  const started = performance.now()
  const loaded = performance.now()
  if (!Number.isSafeInteger(input.page) || input.page < 1 ||
      !Number.isFinite(input.width) || input.width <= 0 ||
      !Number.isFinite(input.height) || input.height <= 0) throw new Error('PDF 页码或预览尺寸无效')
  let canvas
  const loading = pdf.getDocument({ data: new Uint8Array(input.bytes),
    cMapUrl: join(root, 'cmaps/'), cMapPacked: true, standardFontDataUrl: join(root, 'standard_fonts/'),
    wasmUrl: join(root, 'wasm/'), CanvasFactory, isEvalSupported: false, useSystemFonts: false,
    isOffscreenCanvasSupported: false, isImageDecoderSupported: false, maxImageSize: 8_000_000, stopAtErrors: false })
  try {
    const document = await loading.promise
    if (input.page > document.numPages) throw new Error(`PDF 只有 ${document.numPages} 页，无法预览第 ${input.page} 页`)
    const selected = await document.getPage(input.page)
    const natural = selected.getViewport({ scale: 1 })
    const edge = input.quality === 'detail' ? 1024 : 384
    const factor = Math.min(1, edge / Math.max(input.width, input.height))
    const boxWidth = Math.max(1, Math.round(input.width * factor))
    const boxHeight = Math.max(1, Math.round(input.height * factor))
    const scale = Math.min(boxWidth / natural.width, boxHeight / natural.height)
    if (!Number.isFinite(scale) || scale <= 0) throw new Error('PDF 页面尺寸无效')
    const viewport = selected.getViewport({ scale })
    const fixed = input.mode === 'fixed-viewport'
    const width = fixed ? boxWidth : Math.max(1, Math.floor(viewport.width))
    const height = fixed ? boxHeight : Math.max(1, Math.floor(viewport.height))
    canvas = createCanvas(width, height)
    const parsed = performance.now()
    await selected.render({ canvas, canvasContext: canvas.getContext('2d'), viewport, background: '#ffffff',
      transform: fixed ? [1, 0, 0, 1, (width - viewport.width) / 2, (height - viewport.height) / 2] : undefined }).promise
    const rendered = performance.now()
    const png = await canvas.encode('png')
    return { png, width, height, pageCount: document.numPages, warnings: [],
      timings: { moduleMs: loaded - started, loadMs: parsed - loaded, renderMs: rendered - parsed,
        encodeMs: performance.now() - rendered, workerMs: performance.now() - started } }
  } finally {
    try { await loading.destroy() }
    finally { if (canvas) { canvas.width = 1; canvas.height = 1 } }
  }
}
process.on('message', async input => {
  if (!ready || busy || stopping) return
  busy = true
  let response
  try {
    const result = await render(input)
    response = { type: 'result', id: input.id, result, recycle: ++count >= 32 || process.memoryUsage().rss > 512 * 1024 * 1024 }
  } catch (error) {
    // Keep document/render failures separate from startup dependency failures.
    response = { type: 'result', id: input.id, error: { message: String(error?.message || error), code: 'PREVIEW_PDF_RENDER_FAILED' }, recycle: true }
  }
  stopping = response.recycle
  busy = false
  if (process.connected) process.send(response, error => { if (error) process.exit(1) })
})
process.on('disconnect', () => process.exit(0))

// No third-party static imports: even native binding/import failures reach the host
// as an explicit startup failure, without classifying arbitrary stderr as a PDF error.
// After sending it, let the host kill us: an early exit must not race the handshake.
try {
  const canvasModule = await import('@napi-rs/canvas')
  createCanvas = canvasModule.createCanvas
  for (const name of ['DOMMatrix', 'ImageData', 'Path2D']) if (!globalThis[name]) globalThis[name] = canvasModule[name]
  root = dirname(dirname(require.resolve('pdfjs-dist/build/pdf.mjs')))
  pdf = await import('pdfjs-dist/legacy/build/pdf.mjs')
  ready = true
  if (process.connected) process.send({ type: 'ready' })
} catch (error) {
  stopping = true
  if (process.connected) process.send({ type: 'startup-error', error: {
    code: 'PREVIEW_PDF_UNAVAILABLE', message: `PDF 渲染依赖无法加载：${String(error?.message || error)}`,
  } }, sendError => { if (sendError) process.exit(1) })
  else process.exit(1)
}
