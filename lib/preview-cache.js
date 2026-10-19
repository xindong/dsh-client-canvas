/** Bounded LRU of immutable resource bytes. Callers must use content/version identities. */
export function createPreviewByteCache({ maxBytes = 32 * 1024 * 1024, maxEntries = 256, maxAge = Infinity } = {}) {
  const values = new Map()
  const pending = new Map()
  const storedAt = new Map()
  let bytes = 0
  let generation = 0
  return {
    async get(key, load) {
      if (!key) return load()
      if (values.has(key) && Date.now() - storedAt.get(key) >= maxAge) {
        const expired = values.get(key)
        bytes -= expired?.data?.length ?? expired?.length ?? 0
        values.delete(key)
        storedAt.delete(key)
      }
      const previous = values.get(key)
      if (previous) { values.delete(key); values.set(key, previous); return previous }
      if (pending.has(key)) return pending.get(key)
      const epoch = generation
      const work = Promise.resolve().then(load).then(value => {
        const size = value?.data?.length ?? value?.length ?? 0
        if (epoch !== generation || !size || size > maxBytes || maxEntries <= 0) return value
        values.set(key, value)
        storedAt.set(key, Date.now())
        bytes += size
        while (bytes > maxBytes || values.size > maxEntries) {
          const oldest = values.keys().next().value
          const removed = values.get(oldest)
          bytes -= removed?.data?.length ?? removed?.length ?? 0
          values.delete(oldest)
          storedAt.delete(oldest)
        }
        return value
      }).finally(() => { if (pending.get(key) === work) pending.delete(key) })
      pending.set(key, work)
      return work
    },
    clear() { generation++; values.clear(); storedAt.clear(); pending.clear(); bytes = 0 },
  }
}
