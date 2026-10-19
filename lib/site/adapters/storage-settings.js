import { transport } from './store.js'

const endpoint = '/storage-settings'

export function attachStorageSettings(modal, onChange) {
  const input = modal.querySelector('[data-storage-root]')
  const status = modal.querySelector('[data-storage-status]')
  const choose = modal.querySelector('[data-storage-choose]')
  const open = modal.querySelector('[data-storage-open]')
  let state, pending = false, locked = false, disposed = false
  const dirty = () => !!state && input.value.trim() !== state.configuredRoot
  function update(message) {
    if (disposed) return
    input.disabled = pending || locked || !state
    choose.disabled = pending || locked || !state
    open.disabled = pending || locked || !state || !input.value.trim()
    if (message !== undefined) status.textContent = message
    onChange?.()
  }
  function accept(payload) {
    state = payload
    input.value = payload.configuredRoot
    update(payload.restartRequired ? '重启 DSH 后使用新目录，原数据保留。' : '')
  }
  async function load() {
    if (pending || disposed || state) return
    pending = true; update('正在读取目录…')
    try {
      const payload = await transport(endpoint)
      if (!disposed) accept(payload)
    } catch (error) { update(`读取失败：${error.message}。重新打开设置可重试。`) }
    finally { pending = false; update() }
  }
  input.addEventListener('input', () => update(''))
  choose.addEventListener('click', async () => {
    if (pending || locked) return
    pending = true; update('请选择目录…')
    try {
      const payload = await transport(`${endpoint}/choose`, { method: 'POST' })
      if (payload.root && !disposed) input.value = payload.root
      update('')
    } catch (error) { update(error.message) }
    finally { pending = false; update() }
  })
  open.addEventListener('click', async () => {
    if (pending || locked || !input.value.trim()) return
    pending = true; update('正在打开目录…')
    try {
      await transport(`${endpoint}/open`, { method: 'POST', json: { root: input.value.trim() } })
      update('')
    } catch (error) { update(error.message) }
    finally { pending = false; update() }
  })
  return {
    load, dirty,
    get pending() { return pending },
    get restartRequired() { return state?.restartRequired === true },
    setLocked(value) { locked = value; input.disabled = pending || locked || !state; choose.disabled = pending || locked || !state; open.disabled = pending || locked || !state || !input.value.trim() },
    async save() {
      if (!dirty()) return
      if (!input.value.trim()) throw new Error('请填写保存目录')
      const payload = await transport(endpoint, { method: 'PUT', json: { root: input.value.trim() } })
      if (!disposed) accept(payload)
    },
    dispose() { disposed = true },
  }
}
