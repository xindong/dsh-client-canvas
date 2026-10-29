export function withDeadline(work, timeout, message) {
  let timer
  return Promise.race([work, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new DOMException(message, 'TimeoutError')), timeout)
  })]).finally(() => clearTimeout(timer))
}

/** Both document validation and renderer startup use the same recovery path. */
export async function createRecoverableBoard(create, options, store, project) {
  let board
  try {
    board = await create(options)
    await withDeadline(board.ready, 15_000, '画布恢复超时')
    return { board, project }
  } catch (error) {
    // destroy aborts outstanding renderer work; do not wait on a stuck decoder.
    if (board) void board.destroy().catch(error => console.warn('[dsh-canvas] cleanup failed', error))
    project = await store.recover(() => ({ schemaVersion: 1, revision: 0, nodes: [], assets: [] }), error, { restoreTemporary: false })
    board = await create({ ...options, document: project.document })
    try {
      await withDeadline(board.ready, 15_000, '空白画布初始化超时')
      return { board, project }
    } catch (error) {
      void board.destroy().catch(() => {})
      throw error
    }
  }
}
