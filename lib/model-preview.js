import { unzipSync } from 'fflate'

// Mirrors mivo-model-viewer 0.7.0 node/formats.mjs, plus its archive input format.
export const MODEL_FORMATS = new Set([
  'glb', 'gltf', 'fbx', 'obj', 'stl', 'ply', 'dae', '3mf', '3ds',
  'wrl', 'vrml', 'step', 'stp', 'zip',
])

/** Inspect entry names only. Do not inflate arbitrary archives to classify them. */
export async function zipContainsModel(bytes) {
  let containsModel = false
  unzipSync(bytes, { filter(entry) {
    const parts = entry.name.replaceAll('\\', '/').split('/')
    const extension = parts.at(-1).split('.').pop().toLowerCase()
    if (extension !== 'zip' && MODEL_FORMATS.has(extension) &&
        !parts.some(part => part === '__MACOSX' || part.startsWith('._'))) containsModel = true
    return false
  } })
  return containsModel
}

function failure(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code, ...(cause?.details === undefined ? {} : { details: cause.details }),
  })
}

/** Lazy persistent isolated worker; no loader or GPU initialization in the host. */
export function createModelPreviewRenderer(runtimeOptions = {}) {
  let pending
  let closed = false
  let closing

  function processor() {
    if (closed) return Promise.reject(failure('PREVIEW_DISPOSED', '模型预览服务已关闭'))
    if (!pending) {
      const loading = (async () => {
        let createModelPreviewProcessor
        try { ({ createModelPreviewProcessor } = await import('mivo-model-viewer/node')) } catch (error) {
          throw failure('PREVIEW_MODEL_UNAVAILABLE', '无法加载模型预览依赖，请安装 mivo-model-viewer@0.7.0 及其运行依赖', error)
        }
        if (closed) throw failure('PREVIEW_DISPOSED', '模型预览服务已关闭')
        return createModelPreviewProcessor(runtimeOptions)
      })()
      pending = loading
      loading.catch(() => { if (pending === loading) pending = undefined })
    }
    return pending
  }

  async function render({ bytes, fileName, resources, width, height, signal, timeout = 90 }) {
    try {
      if (signal?.aborted) throw signal.reason || failure('PREVIEW_CANCELLED', '模型预览已取消')
      const instance = await processor()
      if (signal?.aborted) throw signal.reason || failure('PREVIEW_CANCELLED', '模型预览已取消')
      const result = await instance.renderModelImages({ bytes, fileName, resources }, {
        format: 'png', width, height, view: 'none', projection: 'orthographic',
        background: '#e8edf3', showGrid: false, allowNetwork: false, signal, timeout,
      })
      if (signal?.aborted) throw signal.reason || failure('PREVIEW_CANCELLED', '模型预览已取消')
      const output = result?.outputs?.find(item => item.format === 'png' && item.bytes instanceof Uint8Array)
      if (result?.ok === false && result.error) {
        throw Object.assign(new Error(result.error.message || '模型预览失败'), {
          code: result.error.code, details: result.error.details,
        })
      }
      if (result?.ok !== true || !output) throw failure('PREVIEW_MODEL_INVALID_OUTPUT', '模型预览没有返回 PNG 图片')
      const png = Buffer.from(output.bytes)
      if (png.length < 33 || png.length > 64 * 1024 * 1024 ||
          png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
          png.readUInt32BE(8) !== 13 || png.subarray(12, 16).toString('ascii') !== 'IHDR' ||
          png.readUInt32BE(16) < 1 || png.readUInt32BE(20) < 1 ||
          png.readUInt32BE(16) > 8192 || png.readUInt32BE(20) > 8192 ||
          png.readUInt32BE(16) * png.readUInt32BE(20) > 16777216) {
        throw failure('PREVIEW_MODEL_INVALID_OUTPUT', '模型预览 PNG 无效')
      }
      const warnings = (result.warnings || []).map(warning =>
        `[${warning.code || 'MODEL_WARNING'}] ${warning.message || '模型预览警告'}${warning.resource ? ` (${warning.resource})` : ''}`)
      return { png, warnings, timings: result.data?.timings }
    } catch (error) {
      if (signal?.aborted) throw signal.reason || failure('PREVIEW_CANCELLED', '模型预览已取消', error)
      if (error?.code?.startsWith('PREVIEW_')) throw error
      throw failure('PREVIEW_MODEL_RENDER_FAILED',
        `模型预览失败${error?.code ? ` [${error.code}]` : ''}：${String(error?.message || error).slice(0, 400)}`, error)
    }
  }

  function dispose() {
    if (closing) return closing
    closed = true
    closing = (async () => {
      const instance = await pending?.catch(() => undefined)
      await instance?.close()
    })()
    return closing
  }

  return { render, dispose }
}
