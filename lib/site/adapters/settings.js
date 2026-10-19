import { settingsMarkup, settingsStyles, attachSettingsHelp } from './settings-view.js'
import { attachStorageSettings } from './storage-settings.js'

const KEY = 'dsh-canvas:settings:v1'
export const DEFAULT_SETTINGS = {
  canvas: { minZoom: 20, maxZoom: 500, background: '#f9fafc', grid: false },
  connections: { enabled: true, startColor: '#8b9cba', endColor: '#526de0', startOpacity: 1, endOpacity: 1, width: 1.8, lineType: 'solid' },
  agent: { enabled: true, scope: 'node', maxNodes: 20, maxChars: 24000, maxDepth: 1, maxResources: 20 },
}
const clone = value => structuredClone(value)
function bounded(value, fallback, min, max) { if (value === null || value === undefined || value === '') return fallback; const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback }
function sanitize(input) {
  const c = input?.canvas || {}, l = input?.connections || {}, a = input?.agent || {}
  const color = (v, fallback) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback
  const minZoom = bounded(c.minZoom, 20, 5, 100), maxZoom = bounded(c.maxZoom, 500, minZoom, 1000)
  return {
    canvas: { minZoom, maxZoom, background: color(c.background, '#f9fafc'), grid: c.grid === true },
    connections: { enabled: l.enabled !== false, startColor: color(l.startColor, '#8b9cba'), endColor: color(l.endColor, '#526de0'),
      startOpacity: bounded(l.startOpacity, 1, 0, 1), endOpacity: bounded(l.endOpacity, 1, 0, 1), width: bounded(l.width, 1.8, .5, 6),
      lineType: ['solid', 'dashed', 'dotted'].includes(l.lineType) ? l.lineType : 'solid' },
    agent: { enabled: a.enabled !== false, scope: ['node', 'upstream', 'downstream', 'connected'].includes(a.scope) ? a.scope : 'node',
      maxResources: Math.round(bounded(a.maxResources, 20, 0, 100)), maxDepth: Math.round(bounded(a.maxDepth, 1, 0, 10)), maxNodes: Math.round(bounded(a.maxNodes, 20, 1, 100)), maxChars: Math.round(bounded(a.maxChars, 24000, 1000, 100000)) },
  }
}
let current = clone(DEFAULT_SETTINGS)
try { current = sanitize(JSON.parse(localStorage.getItem(KEY))) } catch { /* defaults if storage unavailable */ }
const listeners = new Set()
export function getCanvasSettings() { return clone(current) }
export function subscribeCanvasSettings(listener) { listeners.add(listener); return () => listeners.delete(listener) }
function commit(value) {
  current = sanitize(value)
  try { localStorage.setItem(KEY, JSON.stringify(current)) } catch { /* settings remain in memory */ }
  for (const listener of listeners) listener(getCanvasSettings())
}
function visibleGridStep(scale) {
  return 24 * 2 ** Math.round(Math.log2(1 / scale))
}
function positiveModulo(value, divisor) { return ((value % divisor) + divisor) % divisor }
const PROMPT_FIELDS = {
  systemEnabled: 'boolean', systemText: 'string', contextEnabled: 'boolean', contextTemplate: 'string',
  nodePreferences: 'string', includeNodeContent: 'boolean', includeGeometry: 'boolean',
  includeAssets: 'boolean', includeConnections: 'boolean',
}
let promptCurrent, promptDefaults, promptRevision, promptDraft, promptDraftRevision
const promptListeners = new Set()
export function getPromptSettings() { return promptCurrent === undefined ? undefined : clone(promptCurrent) }
export function subscribePromptSettings(listener) { promptListeners.add(listener); return () => promptListeners.delete(listener) }
function pickPromptFields(value, complete = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('提示词配置必须是 JSON 对象')
  const result = {}
  for (const [key, type] of Object.entries(PROMPT_FIELDS)) {
    if (!Object.hasOwn(value, key)) { if (complete) throw new Error(`配置缺少字段：${key}`); continue }
    if (typeof value[key] !== type) throw new Error(`字段 ${key} 必须是 ${type}`)
    result[key] = value[key]
  }
  if (!Object.keys(result).length) throw new Error('没有可导入的提示词字段')
  return result
}
function acceptPromptPayload(payload) {
  if (!payload || !Number.isSafeInteger(payload.revision) || payload.revision < 0) throw new Error('服务端配置版本无效')
  const settings = pickPromptFields(payload.settings, true), defaults = pickPromptFields(payload.defaults, true)
  promptCurrent = settings; promptDefaults = defaults; promptRevision = payload.revision
  for (const listener of promptListeners) {
    try { listener(getPromptSettings()) } catch (error) { console.error('提示词配置订阅失败', error) }
  }
}
export function attachCanvasSettings(site) {
  const rail = document.querySelector('.tool-rail'), host = document.querySelector('#board-host')
  const button = document.createElement('button')
  button.className = 'tool-button'; button.type = 'button'; button.title = '画布设置'; button.setAttribute('aria-label', '画布设置')
  button.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9.5 3-.7 2.2-2 .9-2.1-.5-2.5 4.3 1.5 1.7v2.2l-1.5 1.7 2.5 4.3 2.1-.5 2 .9.7 2.2h5l.7-2.2 2-.9 2.1.5 2.5-4.3-1.5-1.7v-2.2l1.5-1.7-2.5-4.3-2.1.5-2-.9L14.5 3Z"/><circle cx="12" cy="12" r="3"/></svg>'
  rail?.append(button)
  const modal = document.createElement('dialog')
  modal.className = 'dsh-canvas-settings'; modal.setAttribute('aria-labelledby', 'dsh-settings-title')
  modal.innerHTML = settingsMarkup
  const style = document.createElement('style')
  style.textContent = settingsStyles
  document.head.append(style); document.body.append(modal)
  const disposeHelp = attachSettingsHelp(modal)
  const storageSettings = attachStorageSettings(modal, () => updatePromptStatus())
  const promptFields = modal.querySelector('[data-prompt-fields]')
  const promptStatus = modal.querySelector('[data-prompt-status]')
  const promptReload = modal.querySelector('[data-prompt-reload]')
  const promptSave = modal.querySelector('[data-prompt-save]')
  const promptFile = modal.querySelector('[data-prompt-file]')
  let promptPending = false, promptSaving = false, promptConflict = false, disposed = false, promptMessage = ''
  let agentDraft = clone(current.agent)
  const dirtyPrompt = () => promptDraft !== undefined && JSON.stringify(promptDraft) !== JSON.stringify(promptCurrent)
  const dirtyAgent = () => JSON.stringify(agentDraft) !== JSON.stringify(current.agent)
  function applyGrid() {
    host.style.backgroundColor = current.canvas.background
    if (!current.canvas.grid) {
      host.style.backgroundImage = 'none'
      host.style.backgroundSize = ''
      host.style.backgroundPosition = ''
      return
    }
    const viewport = site.activeBoard?.viewport.get()
    const scale = viewport?.scale
    const worldStep = Number.isFinite(scale) && scale > 0 ? visibleGridStep(scale) : 24
    const screenStep = worldStep * (scale || 1)
    const x = Number.isFinite(viewport?.offset.x) ? positiveModulo(viewport.offset.x, screenStep) : 0
    const y = Number.isFinite(viewport?.offset.y) ? positiveModulo(viewport.offset.y, screenStep) : 0
    host.style.backgroundImage = 'radial-gradient(circle, rgba(152, 164, 186, 0.34) 1px, transparent 1.2px)'
    host.style.backgroundSize = `${screenStep}px ${screenStep}px`
    host.style.backgroundPosition = `${x}px ${y}px`
    host.style.backgroundRepeat = 'repeat'
  }
  function updatePromptStatus(message = promptMessage) {
    promptMessage = message
    const dirty = dirtyPrompt() || dirtyAgent() || storageSettings.dirty()
    promptStatus.textContent = message || (dirty ? '有未保存的修改' : promptCurrent ? '已保存' : '正在读取设置…')
    for (const control of modal.querySelectorAll('[data-prompt]')) control.disabled = promptPending || !promptCurrent
    for (const control of promptFields.querySelectorAll('input,button:not([data-setting-help])')) {
      control.disabled = promptPending || !promptCurrent
    }
    for (const control of modal.querySelectorAll('[name^="agent."]')) control.disabled = promptSaving
    promptReload.disabled = promptPending
    for (const control of modal.querySelectorAll('[data-prompt-defaults], [data-prompt-import], [data-prompt-export]')) control.disabled = promptPending || !promptCurrent
    modal.querySelector('[data-reset]').disabled = promptSaving
    storageSettings.setLocked(promptSaving)
    promptSave.disabled = promptPending || storageSettings.pending || !dirty || (dirtyPrompt() && (promptConflict || !promptCurrent))
    promptSave.textContent = promptSaving ? '正在保存…' : '保存设置'
  }
  function fillPrompt() {
    if (!promptDraft) return
    for (const input of modal.querySelectorAll('[data-prompt]')) {
      const value = promptDraft[input.dataset.prompt]
      if (input.type === 'checkbox') input.checked = value
      else input.value = value
    }
  }
  async function loadPrompt(replaceDraft = false) {
    if (promptPending) return
    promptPending = true; updatePromptStatus('正在加载提示词配置…')
    try {
      const response = await fetch('/xindong-canvas/prompt-settings', { cache: 'no-store' })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error?.message || `加载失败（${response.status}）`)
      if (disposed) return
      acceptPromptPayload(payload)
      if (!promptDraft || replaceDraft) {
        promptDraft = clone(promptCurrent); promptDraftRevision = promptRevision; promptConflict = false
      } else if (promptDraftRevision !== promptRevision) promptConflict = true
      fillPrompt()
      promptMessage = promptConflict ? '配置已在其他窗口更新。请在“提示词”页重新载入，当前草稿已保留。' : ''
    } catch (error) {
      if (!disposed) promptMessage = `${error.message}；可点击重新载入重试${promptDraft ? '，草稿已保留' : ''}。`
    } finally { promptPending = false; if (!disposed) updatePromptStatus() }
  }
  modal.querySelectorAll('[data-prompt]').forEach(input => input.addEventListener('input', () => {
    if (!promptDraft || promptPending) return
    promptDraft[input.dataset.prompt] = input.type === 'checkbox' ? input.checked : input.value
    updatePromptStatus(promptConflict ? '配置已在其他窗口更新，请在“提示词”页重新载入。' : '')
  }))
  promptReload.addEventListener('click', () => loadPrompt(true))
  promptSave.addEventListener('click', async () => {
    const changedPrompt = dirtyPrompt()
    if (promptPending || (!changedPrompt && !dirtyAgent() && !storageSettings.dirty()) || (changedPrompt && (!promptCurrent || promptConflict))) return
    if (changedPrompt) {
      if (promptDraft.nodePreferences.length > 4000 || promptDraft.systemText.length > 12000 || promptDraft.contextTemplate.length > 20000) {
        updatePromptStatus('处理偏好最多 4000 字，画布使用说明最多 12000 字，其他格式最多 20000 字。'); return
      }

    }
    const submittedAgent = clone(agentDraft)
    promptPending = true; promptSaving = true; updatePromptStatus('正在保存设置…')
    try {
      // Save the shared part first: a conflict must not silently apply half of
      // the user's changes. Browser preferences are committed only on success.
      if (changedPrompt) {
        const response = await fetch('/xindong-canvas/prompt-settings', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedRevision: promptDraftRevision, settings: promptDraft }),
        })
        if (response.status === 409) {
          promptConflict = true
          throw new Error('配置已在其他窗口更新。草稿已保留，可先导出备份，再重新载入。')
        }
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(payload.error?.message || `保存失败（${response.status}），请重试。`)
        if (disposed) return
        acceptPromptPayload(payload)
        promptDraft = clone(promptCurrent); promptDraftRevision = promptRevision
      }
      await storageSettings.save()
      if (disposed) return
      if (JSON.stringify(submittedAgent) !== JSON.stringify(current.agent)) commit({ ...current, agent: submittedAgent })
      agentDraft = clone(submittedAgent)
      fillPrompt(); fill()
      promptMessage = storageSettings.restartRequired ? '设置已保存，重启 DSH 后使用新目录。' : promptCurrent ? '设置已保存' : '节点操作设置已保存。处理偏好暂未载入，可在“提示词”页重试。'
    } catch (error) { if (!disposed) promptMessage = error.message }
    finally { promptPending = false; promptSaving = false; if (!disposed) updatePromptStatus() }
  })
  modal.querySelector('[data-prompt-defaults]').addEventListener('click', () => {
    if (promptPending || !promptDefaults) return
    promptDraft = clone(promptDefaults); agentDraft = clone(DEFAULT_SETTINGS.agent)
    fillPrompt(); fill(); updatePromptStatus('已恢复默认，点击保存后应用。')
  })
  modal.querySelector('[data-prompt-export]').addEventListener('click', () => {
    if (!promptDraft) return
    const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, agent: agentDraft, prompts: promptDraft }, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = 'dsh-agent-settings.json'
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    updatePromptStatus('已导出当前配置，包含未保存的修改。')
  })
  modal.querySelector('[data-prompt-import]').addEventListener('click', () => promptFile.click())
  promptFile.addEventListener('change', async () => {
    const file = promptFile.files?.[0]; promptFile.value = ''
    if (!file || promptPending || !promptDraft) return
    try {
      if (file.size > 1024 * 1024) throw new Error('配置文件不能超过 1 MB')
      const raw = JSON.parse(await file.text())
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('配置文件必须是 JSON 对象')
      if (raw.version !== undefined && raw.version !== 1) throw new Error('暂不支持此配置版本')
      const imported = pickPromptFields(raw.prompts ?? raw)
      let nextAgent = clone(agentDraft)
      if (Object.hasOwn(raw, 'agent')) {
        if (!raw.agent || typeof raw.agent !== 'object' || Array.isArray(raw.agent)) throw new Error('节点操作配置格式无效')
        for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS.agent)) {
          if (!Object.hasOwn(raw.agent, key)) continue
          const value = raw.agent[key]
          if (typeof value !== typeof fallback || (typeof value === 'number' && !Number.isFinite(value))) throw new Error(`节点配置 ${key} 的类型无效`)
          if (key === 'scope' && !['node', 'upstream', 'downstream', 'connected'].includes(value)) throw new Error('参考范围无效')
          nextAgent[key] = value
        }
        nextAgent = sanitize({ ...current, agent: nextAgent }).agent
      }
      if (disposed || promptPending) return
      promptDraft = { ...promptDraft, ...imported }; agentDraft = nextAgent
      fillPrompt(); fill(); updatePromptStatus('已导入到草稿，点击保存后应用。')
    } catch (error) { if (!disposed) updatePromptStatus(`导入失败：${error.message}`) }
  })
  fillPrompt(); void loadPrompt()
  function fill() {
    for (const input of modal.querySelectorAll('[name]')) {
      const [group, key] = input.name.split('.'); let value = (group === 'agent' ? agentDraft : current[group])[key]
      if (key.endsWith('Opacity')) value *= 100
      if (input.type === 'checkbox') input.checked = value
      else if (input.type === 'radio') input.checked = value === input.value
      else input.value = value
    }
  }
  let appliedAgent
  function apply() {
    applyGrid()
    const viewport = site.activeBoard?.viewport
    if (viewport) viewport.set(viewport.get())
    const agentKey = JSON.stringify(current.agent)
    if (agentKey !== appliedAgent) {
      window.__dshCanvasConfigureNodeAgent?.({ enabled: current.agent.enabled, context: {
        scope: current.agent.scope, maxResources: current.agent.maxResources, maxNodes: current.agent.maxNodes, maxChars: current.agent.maxChars, maxDepth: current.agent.maxDepth,
      } })
      appliedAgent = agentKey
    }
    document.querySelectorAll('[data-selection-action="agent"]').forEach(el => { el.hidden = !current.agent.enabled })
  }
  const reportModal = open => window.parent.postMessage({ type: 'dsh-canvas:settings-modal', open }, window.location.origin)
  button.addEventListener('click', () => { fill(); updatePromptStatus(); modal.showModal(); reportModal(true); void storageSettings.load() })
  modal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => modal.close()))
  modal.addEventListener('click', event => { if (event.target === modal) {
    const r = modal.getBoundingClientRect()
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) modal.close()
  } })
  modal.addEventListener('close', () => { reportModal(false); button.focus() })
  modal.querySelector('form').addEventListener('submit', event => event.preventDefault())
  modal.querySelectorAll('[data-tab]').forEach(el => el.addEventListener('click', () => {
    modal.querySelectorAll('[data-tab]').forEach(tab => tab.setAttribute('aria-pressed', String(tab === el)))
    modal.querySelectorAll('[data-page]').forEach(page => { page.hidden = page.dataset.page !== el.dataset.tab })
    const editingAgent = ['agent', 'prompts', 'config'].includes(el.dataset.tab)
    modal.querySelector('[data-agent-footer]').hidden = !editingAgent
    modal.querySelector('[data-view-footer]').hidden = editingAgent
    modal.querySelector('.settings-pages').scrollTop = 0
  }))
  modal.addEventListener('change', event => {
    if (!event.target.matches('[name]')) return
    const group = event.target.name.split('.')[0]
    const next = clone(current)
    if (group === 'agent') next.agent = clone(agentDraft)
    for (const input of modal.querySelectorAll(`[name^="${group}."]`)) {
      if (input.type === 'radio' && !input.checked) continue
      const key = input.name.split('.')[1]
      let value = ['checkbox', 'radio'].includes(input.type) ? input.checked && (input.type === 'checkbox' ? true : input.value) : input.type === 'number' ? Number(input.value) : input.value
      if (key.endsWith('Opacity')) value /= 100
      next[group][key] = value
    }
    if (group === 'agent') {
      agentDraft = sanitize(next).agent
      updatePromptStatus('')
    } else commit(next)
    fill()
  })
  modal.querySelector('[data-reset]').addEventListener('click', () => {
    if (promptSaving) return
    commit(clone(DEFAULT_SETTINGS)); agentDraft = clone(current.agent)
    fill(); updatePromptStatus()
  })
  const unsubscribe = subscribeCanvasSettings(apply)
  const unsubscribeViewport = site.activeBoard?.on('viewport:change', applyGrid)
  const observer = new MutationObserver(() => document.querySelectorAll('[data-selection-action="agent"]').forEach(el => { el.hidden = !current.agent.enabled }))
  const actions = document.querySelector('#selection-actions')
  if (actions) observer.observe(actions, { childList: true, subtree: true })
  apply()
  return () => { disposed = true; storageSettings.dispose(); disposeHelp(); reportModal(false); unsubscribe(); unsubscribeViewport?.(); observer.disconnect(); modal.remove(); button.remove(); style.remove() }
}
