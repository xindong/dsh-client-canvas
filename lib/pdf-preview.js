import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const failure = (code, message) => Object.assign(new Error(message), { code })

/** One warm, isolated PDF renderer. A deadline or cancellation discards its process. */
export function createPdfPreviewRenderer() {
  const queue = []
  let worker
  let running
  let closed = false
  let broken
  let closing
  let retiring

  function finish(task, error, value) {
    if (!task || task.done) return
    task.done = true
    clearTimeout(task.timer)
    task.signal?.removeEventListener('abort', task.abort)
    const index = queue.indexOf(task)
    if (index >= 0) queue.splice(index, 1)
    if (running === task) running = undefined
    if (error) task.reject(error)
    else task.resolve(value)
    queueMicrotask(pump)
  }

  function stop(previous = worker) {
    if (!previous) return retiring || Promise.resolve()
    if (previous.retiring) return previous.retiring
    if (worker === previous) worker = undefined
    previous.dead = true
    // Keep the queue blocked until SIGKILL has actually released native memory.
    retiring = previous.retiring = (async () => {
      if (previous.child.exitCode === null && previous.child.signalCode === null) {
        previous.child.kill('SIGKILL')
      }
      await previous.closed
    })()
    const current = retiring
    current.then(() => {
      if (retiring === current) retiring = undefined
      pump()
    }, error => {
      if (retiring === current) retiring = undefined
      broken = failure('PREVIEW_PDF_WORKER_EXITED', `PDF 进程清理失败：${error.message}`)
      finish(running, broken)
      for (const task of queue.splice(0)) finish(task, broken)
    })
    return current
  }

  function endTask(task, error, value, previous = worker) {
    if (!task || task.done || task.ending) return
    task.ending = true
    clearTimeout(task.timer)
    void stop(previous).then(() => finish(task, error, value), cleanup => finish(task, cleanup))
  }

  function ensureWorker() {
    if (worker) return worker
    const next = { ready: false, dead: false, stderr: '' }
    const child = fork(fileURLToPath(new URL('./pdf-worker.mjs', import.meta.url)), [], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced', execArgv: ['--max-old-space-size=512'],
    })
    next.child = child
    next.closed = new Promise(resolve => child.once('close', resolve))
    worker = next
    child.stderr.on('data', bytes => { next.stderr = (next.stderr + bytes.toString()).slice(-4000) })
    child.on('message', message => {
      if (worker !== next || next.dead) return
      if (message?.type === 'startup-error') {
        endTask(running, failure('PREVIEW_PDF_UNAVAILABLE', message.error?.message || 'PDF 渲染依赖无法加载'), undefined, next)
        return
      }
      if (message?.type === 'ready') { next.ready = true; dispatch(next); return }
      if (message?.type !== 'result' || !running || running.ending || message.id !== running.id) return
      const task = running
      const error = message.error && failure(message.error.code || 'PREVIEW_PDF_RENDER_FAILED', message.error.message)
      let value
      if (!error) {
        try {
          value = { ...message.result, png: Buffer.from(message.result.png),
            timings: { ...message.result.timings, startupMs: task.startupMs, queueMs: task.started - task.submitted,
              totalMs: performance.now() - task.submitted } }
        } catch {
          endTask(task, failure('PREVIEW_PDF_RENDER_FAILED', 'PDF 渲染进程返回无效结果'), undefined, next)
          return
        }
      }
      if (message.recycle || error) endTask(task, error, value, next)
      else finish(task, undefined, value)
    })
    child.on('error', error => {
      if (worker !== next || next.dead) return
      if (running) endTask(running, error, undefined, next)
      else void stop(next)
    })
    child.on('exit', () => {
      if (worker !== next || next.dead) return
      const error = failure('PREVIEW_PDF_WORKER_EXITED', `PDF 渲染进程退出：${next.stderr}`)
      if (running) endTask(running, error, undefined, next)
      else void stop(next)
    })
    child.on('disconnect', () => {
      if (worker !== next || next.dead) return
      if (running) endTask(running, failure('PREVIEW_PDF_WORKER_EXITED', 'PDF 渲染进程连接已断开'), undefined, next)
      else void stop(next)
    })
    return next
  }

  function dispatch(next) {
    const task = running
    if (!next.ready || next.dead || worker !== next || !task || task.sent || task.ending) return
    task.sent = true
    task.startupMs = performance.now() - task.started
    try {
      next.child.send({ ...task.input, id: task.id }, error => {
        if (error && worker === next && running === task) endTask(task, error, undefined, next)
      })
    } catch (error) { endTask(task, error, undefined, next) }
  }

  function pump() {
    if (closed || broken || retiring || running || !queue.length) return
    const task = queue.shift()
    if (task.done) { queueMicrotask(pump); return }
    running = task
    task.started = performance.now()
    try { dispatch(ensureWorker()) }
    catch (error) { endTask(task, error) }
  }

  function render(input) {
    const { signal, timeout = 90_000, ...serializable } = input
    if (closed) return Promise.reject(new Error('PDF 预览服务已关闭'))
    if (broken) return Promise.reject(broken)
    if (signal?.aborted) return Promise.reject(signal.reason || new Error('PDF 预览已取消'))
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 86_400_000) {
      return Promise.reject(failure('PREVIEW_INVALID_ARGUMENT', 'PDF timeout 必须是大于 0 且不超过一天的毫秒数'))
    }
    if (queue.length >= 32) return Promise.reject(failure('PREVIEW_QUEUE_FULL', 'PDF 预览队列已满'))
    return new Promise((resolve, reject) => {
      const task = { id: randomUUID(), input: serializable, signal, resolve, reject, submitted: performance.now(), done: false }
      const cancel = error => {
        if (task.done || task.ending) return
        if (running === task) endTask(task, error)
        else finish(task, error)
      }
      task.abort = () => cancel(signal.reason || new Error('PDF 预览已取消'))
      signal?.addEventListener('abort', task.abort, { once: true })
      task.timer = setTimeout(() => cancel(failure('PREVIEW_TIMEOUT', 'PDF 预览超时')), timeout)
      task.timer.unref?.()
      queue.push(task)
      if (signal?.aborted) task.abort()
      else pump()
    })
  }

  function dispose() {
    if (closing) return closing
    closed = true
    const error = new Error('PDF 预览服务已关闭')
    for (const task of queue.splice(0)) finish(task, error)
    const task = running
    if (task && !task.ending) endTask(task, error)
    closing = (async () => { await stop(); if (broken) throw broken })()
    return closing
  }
  return { render, dispose }
}
