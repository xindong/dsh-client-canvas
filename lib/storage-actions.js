import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

const execute = promisify(execFile)

export async function openCanvasDirectory(root) {
  if (typeof root !== 'string' || !root.trim() || root.includes('\0')) throw new TypeError('请填写有效的目录绝对路径')
  const value = root.trim()
  const expanded = value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
  if (!isAbsolute(expanded)) throw new TypeError('请填写目录的绝对路径')
  root = resolve(expanded)
  let info
  try { info = await stat(root) }
  catch (error) {
    if (error.code === 'ENOENT') throw new TypeError('目录不存在，请先创建目录或选择已有目录')
    throw error
  }
  if (!info.isDirectory()) throw new TypeError('该路径不是目录')
  if (process.platform === 'darwin') await execute('/usr/bin/open', [root])
  else if (process.platform === 'win32') await execute('explorer.exe', [root])
  else await execute('xdg-open', [root])
}

export async function chooseCanvasDirectory() {
  if (process.platform !== 'darwin') throw new TypeError('当前系统请直接填写目录的绝对路径')
  try {
    const { stdout } = await execute('/usr/bin/osascript', ['-e',
      'POSIX path of (choose folder with prompt "选择画布保存目录（重启 DSH 后生效）")'], { timeout: 120_000 })
    return stdout.trim()
  } catch (error) {
    if (error.stderr?.includes('(-128)')) return null
    throw new Error('选择目录失败，请直接填写目录的绝对路径', { cause: error })
  }
}
