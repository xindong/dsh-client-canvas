import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** A bounded, serial writer. Recording never waits for disk or delays publication. */
export function createPreviewJournal({ root, onError, maxBytes = 1024 * 1024, maxPending = 512 }) {
  const path = join(root, 'performance.ndjson')
  const pending = []
  let draining
  let closed = false
  function pump() {
    if (draining || !pending.length) return
    draining = (async () => {
      await mkdir(root, { recursive: true })
      let size = (await stat(path).catch(error => {
        if (error?.code !== 'ENOENT') throw error
        return { size: 0 }
      })).size
      while (pending.length) {
        const line = pending.shift()
        const bytes = Buffer.byteLength(line)
        if (size + bytes > maxBytes) {
          await rm(`${path}.1`, { force: true })
          await rename(path, `${path}.1`).catch(error => { if (error?.code !== 'ENOENT') throw error })
          size = 0
        }
        await appendFile(path, line, { mode: 0o600 })
        size += bytes
      }
    })().catch(error => {
      // Drop this batch after a disk failure; subsequent records may retry.
      pending.length = 0
      try { onError?.(error) } catch { /* diagnostics cannot reject the writer */ }
    }).finally(() => { draining = undefined; pump() })
  }
  return {
    record(row) {
      if (closed) return
      const line = `${JSON.stringify(row)}\n`
      if (Buffer.byteLength(line) > maxBytes) return
      if (pending.length >= maxPending) pending.shift()
      pending.push(line)
      pump()
    },
    async close() {
      closed = true
      while (draining || pending.length) { pump(); await draining }
    },
  }
}
