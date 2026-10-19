/** Each lane owns one slot, so SDK waits cannot occupy another render lane. */
export function createPreviewScheduler({ run, concurrency = 3, maxQueue = 32 }) {
  const lanes = new Map(['light', 'html', 'pdf', 'office', 'model'].map(name => [name, { queue: [], active: 0 }]))
  const active = new Set()
  const starting = new Set()
  const cancelled = new Set()
  let cursor = 0
  let closed = false
  const names = [...lanes.keys()]
  function pump() {
    while (!closed && active.size < concurrency) {
      let selected
      for (let offset = 0; offset < names.length; offset++) {
        const index = (cursor + offset) % names.length
        const lane = lanes.get(names[index])
        if (!lane.active && lane.queue.length) { selected = lane; cursor = (index + 1) % names.length; break }
      }
      if (!selected) break
      const now = Date.now()
      const rank = job => (job.input?.priority ?? 1) - Math.floor((now - (job.admittedAt ?? now)) / 5000)
      let next = 0
      for (let index = 1; index < selected.queue.length; index++) {
        if (rank(selected.queue[index]) < rank(selected.queue[next])) next = index
      }
      const [job] = selected.queue.splice(next, 1)
      selected.active++
      starting.add(job)
      const work = Promise.resolve().then(() => {
        starting.delete(job)
        const skip = cancelled.delete(job)
        if (!closed && !skip) return run(job)
      }).finally(() => { selected.active--; active.delete(work); pump() })
      active.add(work)
      // run owns reporting; keep unexpected rejection from becoming unhandled.
      work.catch(() => {})
    }
  }
  return {
    active,
    enqueue(job, superseded = []) {
      const lane = lanes.get(job.lane) || lanes.get('light')
      if (closed || lane.queue.filter(queued => !superseded.includes(queued)).length >= maxQueue) return false
      for (const previous of superseded) {
        for (const existing of lanes.values()) {
          const index = existing.queue.indexOf(previous)
          if (index >= 0) existing.queue.splice(index, 1)
        }
        if (starting.has(previous)) cancelled.add(previous)
      }
      lane.queue.push(job)
      pump()
      return true
    },
    cancel(job) {
      for (const lane of lanes.values()) {
        const index = lane.queue.indexOf(job)
        if (index >= 0) { lane.queue.splice(index, 1); pump(); return true }
      }
      if (starting.has(job)) { cancelled.add(job); return true }
      return false
    },
    close() {
      closed = true
      const queued = [...starting, ...[...lanes.values()].flatMap(lane => lane.queue.splice(0))]
      starting.clear()
      return queued
    },
  }
}
