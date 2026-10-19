import { fetchPromptSettings, renderNodePrompt } from './prompt-builder.js'
import { attachOverlayLayer, createNodeAgentController, resolveOverlayBounds } from 'pixiboardjs/browser'
import { activeBoardId, getActiveBoardId, onActiveBoardChange, sameDocument } from './store.js'

// The SDK owns element pooling, projection and wheel forwarding in the canvas
// document. Only prompt admission crosses into the DSH conversation host.
export function attachNodeAgent(site, connections) {
  const store = site.projectStore
  const origin = window.location.origin
  const host = document.querySelector('#board-host')
  const container = document.createElement('div')
  container.className = 'dsh-node-agent-overlay'
  host.parentElement.append(container)
  const disposers = []
  let boardDisposers = []
  let boundBoard, layer, tracked, agent
  let agentOptions = { enabled: true, context: { scope: 'node' } }
  let generation = 0
  let stopped = false

  function post(payload) {
    window.parent.postMessage({ type: 'dsh-canvas:node-agent', ...payload }, origin)
  }

  function close() {
    agent?.cancel()
    if (!tracked) return
    const previous = tracked
    tracked = undefined
    generation += 1
    layer?.refresh()
    if (previous.open) post({ action: 'close', boardId: previous.boardId, nodeId: previous.nodeId })
  }

  function currentNode(target) {
    if (stopped) throw new Error('节点 Agent 操作已关闭，请重新打开后提交。')
    if (site.activeBoard !== target.board || activeBoardId !== target.boardId
      || store.pendingSwitches || store.pendingMaintenance) {
      throw new Error('当前画布已切换或正在切换，请重新打开节点 Agent 操作。')
    }
    const node = target.board.nodes.get(target.nodeId)
    if (!node) throw new Error('节点已被删除，无法继续 Agent 操作。')
    const ids = target.board.selection.get()
    if (ids.length !== 1 || ids[0] !== target.nodeId) {
      throw new Error('选中的节点已切换，请重新打开节点 Agent 操作。')
    }
    return node
  }

  function validateTarget() {
    if (!tracked) return
    try { currentNode(tracked) } catch { close() }
  }

  function syncTheme() {
    const source = window.parent.getComputedStyle(window.parent.document.body)
    for (let i = 0; i < source.length; i += 1) {
      const name = source[i]
      if (name.startsWith('--dsw-') || name.startsWith('--dsh-')) {
        container.style.setProperty(name, source.getPropertyValue(name))
      }
    }
  }

  function renderEditor(element, target) {
    if (element.firstElementChild) return
    const form = document.createElement('form')
    form.className = 'selection-actions xindong-node-agent'
    form.setAttribute('aria-label', '节点 Agent 操作')
    const input = document.createElement('textarea')
    input.className = 'xindong-node-agent-input'
    input.rows = 2
    input.placeholder = '输入对这个节点的操作指令…'
    input.setAttribute('aria-label', '节点操作指令')
    const error = document.createElement('div')
    error.className = 'xindong-node-agent-error'
    error.setAttribute('role', 'alert')
    error.hidden = true
    const footer = document.createElement('div')
    footer.className = 'xindong-node-agent-footer'
    const send = document.createElement('button')
    send.type = 'submit'
    send.className = 'sp-button xindong-node-agent-send'
    send.setAttribute('aria-label', '发送节点指令')
    send.disabled = true
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', width: '18', height: '18',
      fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round',
      'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(name, value)
    const path = document.createElementNS(svg.namespaceURI, 'path')
    path.setAttribute('d', 'M12 19V5m-7 7 7-7 7 7')
    svg.append(path)
    send.append(svg)
    const preview = document.createElement('button')
    preview.type = 'button'
    preview.className = 'sp-button dsh-node-action-labeled xindong-node-agent-preview'
    preview.textContent = '预览提示词'
    preview.disabled = true
    const previewPanel = document.createElement('details')
    previewPanel.className = 'xindong-node-agent-prompt-preview'
    previewPanel.hidden = true
    const summary = document.createElement('summary')
    summary.textContent = '本次节点消息预览（发送时会重新读取最新上下文）'
    const previewText = document.createElement('pre')
    previewText.tabIndex = 0
    previewPanel.append(summary, previewText)
    footer.append(preview, send)
    form.append(input, error, footer, previewPanel)
    element.append(form)
    target.editor = { input, error, send, form }
    input.focus({ preventScroll: true })

    function fail(message) {
      if (tracked !== target) return
      target.pending = undefined
      input.disabled = false
      form.setAttribute('aria-busy', 'false')
      send.setAttribute('aria-label', '发送节点指令')
      send.disabled = !input.value.trim()
      preview.disabled = !input.value.trim()
      error.textContent = message
      error.hidden = false
      input.focus({ preventScroll: true })
    }
    target.fail = fail
    let preparingPreview = false
    let previewVersion = 0
    preview.addEventListener('click', async () => {
      if (tracked !== target || target.pending || preparingPreview || !input.value.trim()) return
      preparingPreview = true
      const version = ++previewVersion
      preview.disabled = true
      send.disabled = true
      preview.textContent = '正在生成…'
      error.hidden = true
      try {
        const request = await agent.prepare({ boardId: target.boardId, nodeId: target.nodeId }, input.value)
        if (tracked !== target || version !== previewVersion) return
        previewText.textContent = request.prompt
        previewPanel.hidden = false
        layer?.refresh()
        previewPanel.open = true
        layer?.refresh()
      } catch (failure) {
        if (tracked === target && version === previewVersion) {
          error.textContent = failure?.message ?? String(failure)
          error.hidden = false
        }
      } finally {
        preparingPreview = false
        if (tracked === target) {
          preview.textContent = '预览提示词'
          preview.disabled = !input.value.trim() || !!target.pending
          send.disabled = !input.value.trim() || !!target.pending
        }
      }
    })
    async function submit(event) {
      event?.preventDefault()
      if (tracked !== target || target.pending || preparingPreview || !input.value.trim()) return
      const instruction = input.value
      target.pending = crypto.randomUUID()
      preview.disabled = true
      input.disabled = true
      send.disabled = true
      send.setAttribute('aria-label', '正在发送')
      form.setAttribute('aria-busy', 'true')
      error.hidden = true
      try {
        const request = await agent.prepare({ boardId: target.boardId, nodeId: target.nodeId }, instruction)
        if (tracked !== target) return
        target.pending = request.requestId
        post({ action: 'submit', requestId: request.requestId, context: request.context,
          prompt: request.prompt, resources: request.resources, instruction })
      } catch (failure) {
        fail(failure?.message ?? String(failure))
      }
    }
    form.addEventListener('submit', submit)
    // Keep text editing clicks local. Never suppress pointermove/up: the site's
    // window gesture listeners must continue across this element. Middle/right
    // and space-panning are handled by the same capture handler as the bottom panel.
    form.addEventListener('pointerdown', event => event.stopPropagation())
    form.addEventListener('click', event => event.stopPropagation())
    input.addEventListener('input', () => {
      previewVersion += 1
      if (preparingPreview) agent?.cancel()
      previewPanel.hidden = true
      layer?.refresh()
      send.disabled = !input.value.trim() || preparingPreview || !!target.pending
      preview.disabled = !input.value.trim() || preparingPreview || !!target.pending
      error.hidden = true
    })
    form.addEventListener('keydown', event => {
      event.stopPropagation()
      if (event.key === 'Escape') { event.preventDefault(); close(); target.board.focus(); return }
      if (event.target === input && event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault()
        void submit()
      }
    })
  }

  function bindBoard(board) {
    if (board === boundBoard) return
    close()
    agent?.destroy()
    layer?.destroy()
    for (const dispose of boardDisposers) dispose()
    boundBoard = board
    agent = createNodeAgentController(board, {
      ...agentOptions,
      getNeighborIds: (nodeId, direction) => connections?.getNeighborIds(nodeId, direction) ?? [],
      validateTarget: target => {
        if (!tracked || tracked.nodeId !== target.nodeId || tracked.boardId !== target.boardId) {
          throw new Error('节点操作目标已切换')
        }
        currentNode(tracked)
      },
      beforeSubmit: target => prepare(target.boardId, target.nodeId),
      resolveAsset: (asset, target) => ({ assetId: asset.id,
        original_url: `${origin}/xindong-canvas/boards/${encodeURIComponent(target.boardId)}/assets/${encodeURIComponent(asset.id)}/original` }),
      buildPrompt: async input => renderNodePrompt(input, await fetchPromptSettings(input.signal)),
    })
    boardDisposers = [board.on('selection:change', validateTarget), board.on('change', validateTarget)]
    layer = attachOverlayLayer(board, {
      container,
      itemClassName: 'dsh-node-agent-item',
      wheelSurface: host,
      // Opt out of renderer culling for this single active editor so its draft
      // survives temporarily panning its node outside the viewport.
      candidates: () => tracked?.open ? [tracked.nodeId] : [],
      item: node => tracked?.open && tracked.nodeId === node.id
        ? { key: `${tracked.boardId}:${node.id}`, anchor: 'top', scale: 'screen', offset: { x: 0, y: -36 } }
        : undefined,
      render: ({ element, placement, node }) => {
        if (!tracked?.open) return
        renderEditor(element, tracked)
        const form = element.firstElementChild
        if (!form) return
        // Match the bottom action panel: fixed CSS size, screen-space anchor,
        // horizontal edge clamping. Reserve the 22px label strip plus 14px gap.
        const surface = container.getBoundingClientRect()
        const width = form.offsetWidth
        const height = form.offsetHeight
        const center = Math.max(12 + width / 2,
          Math.min(surface.width - width / 2 - 12, placement.screen.x))
        form.style.left = `${center - placement.screen.x - width / 2}px`
        let top = -height
        if (placement.screen.y - height < 12) {
          const bounds = resolveOverlayBounds(node, board.nodeTypes)
          const viewport = board.viewport.get()
          const bottom = bounds.maxY * viewport.scale + viewport.offset.y
          // Keep the bottom action panel's 8px gap and 36px height clear too.
          top = bottom + 52 - placement.screen.y
        }
        form.style.top = `${top}px`
      },
    })
  }

  async function open() {
    if (stopped || agentOptions.enabled === false) return
    const board = site.activeBoard
    bindBoard(board)
    const ids = board.selection.get()
    if (ids.length !== 1 || !board.nodes.get(ids[0])) return
    if (tracked?.board === board && tracked.nodeId === ids[0]) { close(); return }
    close()
    const target = { board, boardId: activeBoardId, nodeId: ids[0], open: false }
    tracked = target
    const version = generation
    try {
      const boardId = await getActiveBoardId()
      if (stopped || version !== generation || tracked !== target) return
      target.boardId = boardId
      const node = currentNode(target)
      syncTheme()
      target.open = true
      layer.refresh()
      post({ action: 'open', boardId, node: structuredClone(node) })
    } catch (failure) {
      if (version !== generation || tracked !== target) return
      close()
      console.error('[dsh-canvas] 无法打开节点 Agent 操作', failure)
    }
  }

  function onClick(event) {
    const button = event.target?.closest?.('#selection-actions [data-selection-action="agent"]')
    if (button && !button.disabled) void open()
  }

  async function prepare(boardId, nodeId) {
    const target = tracked
    const version = generation
    function validate() {
      if (!target || boardId !== target.boardId || nodeId !== target.nodeId) {
        throw new Error('节点 Agent 操作已关闭或目标已切换，请重新打开后提交。')
      }
      const node = currentNode(target)
      if (!target.open || tracked !== target || version !== generation) {
        throw new Error('节点 Agent 操作已关闭或选区已切换，请重新打开后提交。')
      }
      return node
    }
    validate()
    // Join the normal per-board save queue so polling and debounced autosaves
    // cannot race this flush. If an edit arrives during saving, flush it too.
    // Bound retries so a moving
    // document cannot keep a submission waiting indefinitely.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      validate()
      const snapshot = target.board.document.toJSON()
      try {
        await store.save(boardId, snapshot, {})
      } catch (error) {
        validate()
        throw new Error('节点数据保存失败，请稍后重试。', { cause: error })
      }
      const node = validate()
      const latest = target.board.document.toJSON()
      if (!sameDocument(snapshot, latest)) continue
      const assetIds = new Set(Object.values(node.assetRefs ?? {}).map(ref => ref.assetId))
      return {
        boardId,
        node: structuredClone(node),
        assets: structuredClone(latest.assets.filter(asset => assetIds.has(asset.id))),
      }
    }
    throw new Error('画布内容仍在变化，请停止编辑后重新提交 Agent 操作。')
  }

  function onResult(event) {
    if (event.origin !== origin || event.source !== window.parent || event.data?.type !== 'dsh-canvas:node-agent-result') return
    const target = tracked
    if (!target?.pending || event.data.requestId !== target.pending) return
    if (event.data.ok) { close(); target.board.focus() }
    else target.fail?.(event.data.error || '发送失败，请稍后重试')
  }

  function destroy() {
    if (stopped) return
    stopped = true
    close()
    agent?.destroy()
    layer?.destroy()
    for (const dispose of boardDisposers) dispose()
    for (const dispose of disposers) dispose()
    container.remove()
    if (window.__dshCanvasConfigureNodeAgent === configure) delete window.__dshCanvasConfigureNodeAgent
    if (window.__dshCanvasCloseNodeAgent === close) delete window.__dshCanvasCloseNodeAgent
    if (window.__dshCanvasPrepareNodeAgent === prepare) delete window.__dshCanvasPrepareNodeAgent
  }

  function configure(next = {}) {
    agentOptions = { ...agentOptions, ...next }
    close()
    agent?.configure(agentOptions)
  }
  window.__dshCanvasConfigureNodeAgent = configure
  bindBoard(site.activeBoard)
  const themeObserver = new window.parent.MutationObserver(syncTheme)
  themeObserver.observe(window.parent.document.documentElement, { attributes: true })
  themeObserver.observe(window.parent.document.body, { attributes: true })
  disposers.push(() => themeObserver.disconnect(), onActiveBoardChange(close))
  document.addEventListener('click', onClick)
  window.addEventListener('message', onResult)
  window.addEventListener('pagehide', destroy)
  const refreshOnResize = () => layer?.refresh()
  window.addEventListener('resize', refreshOnResize)
  disposers.push(
    () => document.removeEventListener('click', onClick),
    () => window.removeEventListener('message', onResult),
    () => window.removeEventListener('pagehide', destroy),
    () => window.removeEventListener('resize', refreshOnResize),
  )
  window.__dshCanvasCloseNodeAgent = close
  window.__dshCanvasPrepareNodeAgent = prepare
  return destroy
}
