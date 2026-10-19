import { rotatedRectBounds } from '@pixi-board/core'
import { loadPixiRuntime } from '@pixi-board/renderer-pixi'

// Two tiny shared textures, generated once; no per-node canvas or animation.
const gradientTextures = new Map()
function gradientTexture(pixi, palette) {
  if (gradientTextures.has(palette)) return gradientTextures.get(palette)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const context = canvas.getContext('2d')
  const pixels = context.createImageData(128, 128)
  const corners = {
    processing: [[177, 191, 242], [215, 185, 240], [194, 211, 247], [231, 203, 245]],
    failed: [[237, 170, 180], [245, 199, 187], [224, 181, 203], [245, 207, 202]],
    file: [[232, 210, 164], [245, 226, 187], [223, 206, 175], [244, 216, 170]],
    model: [[157, 213, 201], [190, 230, 211], [168, 206, 211], [213, 235, 210]],
    document: [[177, 206, 227], [206, 223, 237], [186, 214, 221], [216, 230, 236]],
  }[palette]

  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const u = x / 127, v = y / 127
    // A quiet pearl center, with color concentrated softly toward the corners.
    const pearl = Math.sin(Math.PI * u) * Math.sin(Math.PI * v) * 0.28
    for (let c = 0; c < 3; c++) {
      const top = corners[0][c] * (1 - u) + corners[1][c] * u
      const bottom = corners[2][c] * (1 - u) + corners[3][c] * u
      pixels.data[(y * 128 + x) * 4 + c] = (top * (1 - v) + bottom * v) * (1 - pearl) + 250 * pearl
    }
    pixels.data[(y * 128 + x) * 4 + 3] = 255
  }
  context.putImageData(pixels, 0, 0)
  const texture = pixi.Texture.from(canvas)
  gradientTextures.set(palette, texture)
  return texture
}

export const placeholderRenderer = {
  async create(_node, context) {
    const pixi = await loadPixiRuntime()
    const displayObject = context.display.createContainer()
    const background = new pixi.Sprite(gradientTexture(pixi, 'file'))
    const mask = new pixi.Graphics()
    background.mask = mask
    displayObject.addChild(background)
    displayObject.addChild(mask)
    return { displayObject, state: { background, mask, pixi, signature: '' } }
  },
  update(view, node) {
    const { background, mask, pixi } = view.state
    const failed = node.props?.status === 'failed' || ['error', 'failed'].includes(node.props?.previewStatus)
    const palette = failed ? 'failed' : node.type === 'processing' ? 'processing'
      : node.type === 'model' ? 'model' : node.type === 'file' ? 'file' : 'document'
    const width = Math.max(1, node.width), height = Math.max(1, node.height)
    Object.assign(view.displayObject, { x: node.x, y: node.y, rotation: node.rotation, zIndex: node.zIndex })
    const signature = `${width}:${height}:${palette}`
    if (signature === view.state.signature) return
    view.state.signature = signature
    background.texture = gradientTexture(pixi, palette)
    background.width = width
    background.height = height
    mask.clear().rect(0, 0, width, height).fill('#ffffff')
  },
  // Shared gradient textures outlive individual nodes; only destroy the views.
  destroy(view) { view.displayObject.destroy({ children: true }) },
}

export const processingNodeDefinition = {
  type: 'processing', version: 1,
  defaults: { title: '处理任务', label: '处理', message: '', status: 'running' },
  resize: { mode: 'free' },
  validate(value) {
    const props = value && typeof value === 'object' ? value : {}
    const status = props.status ?? 'running'
    if (!['running', 'failed'].includes(status)) throw new TypeError('processing status must be running or failed')
    return {
      title: typeof props.title === 'string' ? props.title : '处理任务',
      label: typeof props.label === 'string' ? props.label.slice(0, 24) : '处理',
      message: typeof props.message === 'string' ? props.message : '', status,
    }
  },
  getBounds: rotatedRectBounds,
  renderer: placeholderRenderer,
}

// Wrap the existing texture renderers, preserving real preview assets and their
// leases. Historical placeholder bitmaps no longer define the visible card.
export function registerPlaceholderRenderers(registry) {
  registry.register('processing', placeholderRenderer)
  for (const type of ['model', 'html', 'markdown', 'text-file', 'file']) {
    const original = registry.get(type)
    if (!original) continue
    registry.register(type, {
      async create(node, context) {
        const empty = await placeholderRenderer.create(node, context)
        const container = context.display.createContainer()
        container.addChild(empty.displayObject)
        return { displayObject: container, state: { empty, actual: undefined } }
      },
      async update(view, node, context) {
        const refs = Object.values(node.assetRefs || {})
        const real = node.props?.previewStatus === 'ready' || !!node.props?.previewQuality
          || refs.some(ref => ref.variant?.startsWith('preview-'))
        placeholderRenderer.update(view.state.empty, node)
        if (real && !view.state.actual) {
          const actual = await original.create(node, context)
          if (context.signal.aborted) { original.destroy(actual, context); return }
          view.state.actual = actual
          view.displayObject.addChild(actual.displayObject)
        }
        if (view.state.actual) await original.update(view.state.actual, node, context)
        view.state.empty.displayObject.visible = !view.state.actual
      },
      destroy(view, context) {
        if (view.state.actual) original.destroy(view.state.actual, context)
        placeholderRenderer.destroy(view.state.empty)
        view.displayObject.destroy()
      },
    }, { replace: true })
  }
  registerCardBackgrounds(registry)
}

// A presentation-only backing: never flattened into the source media/export.
function registerCardBackgrounds(registry) {
  for (const type of ['image', 'video', 'audio', 'model', 'html', 'markdown', 'text-file', 'file', 'processing']) {
    const original = registry.get(type)
    if (!original) continue
    registry.register(type, {
      async create(node, context) {
        const actual = await original.create(node, context)
        const container = context.display.createContainer()
        // Fixed child order: node zIndex belongs to the outer scene container.
        container.sortableChildren = false
        const backing = context.display.createRect(1, 1, '#eceae5')
        backing.alpha = 0.25
        container.addChild(backing)
        container.addChild(actual.displayObject)
        return { displayObject: container, state: { backing, actual } }
      },
      async update(view, node, context) {
        Object.assign(view.state.backing, { x: node.x, y: node.y, rotation: node.rotation,
          width: node.width, height: node.height })
        view.displayObject.zIndex = node.zIndex
        await original.update(view.state.actual, node, context)
      },
      destroy(view, context) {
        original.destroy(view.state.actual, context)
        view.state.backing.destroy()
        view.displayObject.destroy()
      },
    }, { replace: true })
  }
}
