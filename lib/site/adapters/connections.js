import { attachConnections as attachSdkConnections } from 'pixiboardjs/browser'
import { getCanvasSettings, subscribeCanvasSettings } from './settings.js'

// Only retain legacy relationship fields long enough for the SDK migration.
// New nodes and subsequent updates use metadata.connections as the sole source.
export function withConnections(definition) {
  const ids = value => Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string'))] : []
  return { ...definition, validate(value) {
    const result = definition.validate(value)
    for (const key of ['from', 'to']) {
      if (Array.isArray(value?.[key])) result[key] = ids(value[key])
    }
    return result
  } }
}

// DSH supplies its surface and browser-wide preferences; the SDK owns geometry,
// hit testing, relationship history, migration and all connection gestures.
export async function attachConnections(site) {
  const host = document.querySelector('#board-host')
  const { enabled, ...style } = getCanvasSettings().connections
  const controller = await attachSdkConnections(site.activeBoard, {
    surface: host, overlay: host.parentElement, enabled, style,
    interactionOverlays: [document.querySelector("#media-overlay")].filter(Boolean),
    migrateLegacy: true, persistSettings: false,
    canInteract: () => !host.classList.contains('is-space-panning')
      && !document.querySelector('dialog[open]')
      && document.querySelector('#import-lock')?.hidden !== false,
  })
  const unsubscribe = subscribeCanvasSettings(settings => {
    const { enabled, ...style } = settings.connections
    controller.setEnabled(enabled)
    controller.setStyle(style)
  })
  const destroy = () => { unsubscribe(); controller.destroy() }
  window.addEventListener('pagehide', destroy, { once: true })
  return { controller, destroy }
}
