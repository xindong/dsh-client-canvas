// The host shows a themed loading cover from the moment the iframe mounts.
// Report readiness explicitly: iframe "load" can precede media/SDK bootstrap.
function reportLoadState(state) {
  window.__dshCanvasLoadState = state
  window.parent.postMessage({ type: 'dsh-canvas:load-state', state }, window.location.origin)
}

reportLoadState('loading')
try {
  // Load and configure preview dependencies before main starts importing files
  // or decoding textures. Host callbacks must call DSH implementations directly.
  const [preview, documentPreviews] = await Promise.all([
    import('./upstream/apps/site/src/preview.ts'),
    import('./adapters/document-preview.js'),
  ])
  preview.configureSitePreviewHost({
    requestPreview: documentPreviews.requestDocumentPreview,
    getTextureEpoch: documentPreviews.getPreviewTextureEpoch,
    onTextureReady: documentPreviews.reportPreviewTextureReady,
  })
  // Classification and import state use SDK defaults; wrapping those defaults
  // as host hooks would call back into the same SDK wrappers recursively.
  const [site, { connectSite }, { attachNodeAgent }] = await Promise.all([
    import('./upstream/apps/site/src/main.ts'),
    import('./adapters/store.js'),
    import('./adapters/node-agent.js'),
  ])
  await site.dshReady
  if (!site.activeBoard) throw new Error('Canvas bootstrap did not produce a board')
  connectSite(site)
  const { attachConnections } = await import('./adapters/connections.js')
  const connections = await attachConnections(site)
  site.configureSiteConnections(connections.controller)
  attachNodeAgent(site, connections.controller)
  const { attachCanvasSettings } = await import('./adapters/settings.js')
  attachCanvasSettings(site)
  documentPreviews.attachDocumentPreviews(site)
  // Let the initial canvas and overlays paint before removing the host cover.
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  reportLoadState('ready')
} catch (error) {
  console.error('[dsh-canvas] loading failed', error)
  reportLoadState('error')
}
