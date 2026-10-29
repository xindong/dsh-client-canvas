// The host shows a themed loading cover from the moment the iframe mounts.
// Report readiness explicitly: iframe "load" can precede media/SDK bootstrap.
import { withDeadline } from './adapters/bootstrap.js'
import { connectSite, transport } from './adapters/store.js'

function reportLoadState(state) {
  window.__dshCanvasLoadState = state
  window.parent.postMessage({ type: 'dsh-canvas:load-state', state }, window.location.origin)
}

reportLoadState('loading')
function showRecovery(message) {
  const notice = document.createElement('div')
  notice.setAttribute('role', 'status')
  notice.textContent = message
  Object.assign(notice.style, { position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)',
    zIndex: '10000', maxWidth: 'min(600px, 80vw)', padding: '10px 16px', borderRadius: '8px',
    background: '#fff4d6', color: '#634600', font: '13px/1.5 sans-serif', boxShadow: '0 2px 12px #0002' })
  document.body.append(notice)
}

async function attachExtras(site, documentPreviews) {
  try {
    const [{ attachConnections }, { attachNodeAgent }] = await Promise.all([
      import('./adapters/connections.js'), import('./adapters/node-agent.js'),
    ])
    const connections = await withDeadline(attachConnections(site), 5000, '连线初始化超时')
    site.configureSiteConnections(connections.controller)
    attachNodeAgent(site, connections.controller)
  } catch (error) { console.warn('[dsh-canvas] connections unavailable', error) }
  try {
    const { attachCanvasSettings } = await import('./adapters/settings.js')
    attachCanvasSettings(site)
  } catch (error) { console.warn('[dsh-canvas] settings unavailable', error) }
  try { documentPreviews?.attachDocumentPreviews(site) }
  catch (error) { console.warn('[dsh-canvas] previews unavailable', error) }
}

try {
  // Load and configure preview dependencies before main starts importing files
  // or decoding textures. Host callbacks must call DSH implementations directly.
  let documentPreviews
  try {
    const [preview, previews] = await withDeadline(Promise.all([
      import('./upstream/apps/site/src/preview.ts'),
      import('./adapters/document-preview.js'),
    ]), 10_000, '预览模块加载超时')
    documentPreviews = previews
    preview.configureSitePreviewHost({
      requestPreview: documentPreviews.requestDocumentPreview,
      getTextureEpoch: documentPreviews.getPreviewTextureEpoch,
      onTextureReady: documentPreviews.reportPreviewTextureReady,
    })
  } catch (error) { console.warn('[dsh-canvas] preview bootstrap unavailable', error) }
  // Classification and import state use SDK defaults; wrapping those defaults
  // as host hooks would call back into the same SDK wrappers recursively.
  const site = await withDeadline(import('./upstream/apps/site/src/main.ts'), 15_000, '画布模块加载超时')
  await withDeadline(site.dshReady, 55_000, '画布初始化超时')
  if (!site.activeBoard) throw new Error('Canvas bootstrap did not produce a board')
  connectSite(site)
  void attachExtras(site, documentPreviews)
  if (site.projectStore.recovery) {
    showRecovery(site.projectStore.recovery.temporary
      ? '保存服务暂不可用，已打开临时画布。请在关闭页面前导出内容，媒体导入暂不可用。'
      : '原画布暂时无法读取，已打开新的恢复画布。原文件保留。')
  } else {
    void transport('/storage-settings', { timeout: 3000 }).then(settings => {
      if (settings?.recovery) showRecovery(settings.recovery.temporary
        ? `已使用系统临时目录：${settings.root}。重启后不会自动恢复，请先导出内容或备份该目录，再更换保存目录。`
        : `原保存目录不可用，已使用恢复目录：${settings.root}。可在设置中更换目录，原数据保留。`)
    }).catch(() => {})
  }
  // Let the initial canvas and overlays paint before removing the host cover.
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  reportLoadState('ready')
} catch (error) {
  console.error('[dsh-canvas] loading failed', error)
  reportLoadState('error')
}
