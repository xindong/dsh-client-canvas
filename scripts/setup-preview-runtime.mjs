// Install published runtime dependencies and Chromium only when absent.
// This does not build the frontend or run tests/type checks.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(join(root, 'package.json'))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
function installed() {
  return Object.entries(manifest.dependencies || {}).every(([name, version]) => {
    try { return JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version === version } catch { return false }
  })
}
if (!installed()) {
  console.log('Installing document preview dependencies (published packages; no frontend build).')
  const result = spawnSync('pnpm', ['install', '--ignore-scripts', '--config.auto-install-peers=false', '--reporter=append-only'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_GC: '1' },
  })
  if (result.error || result.status !== 0) throw result.error || new Error('Could not install document preview dependencies')
}
const { chromium } = await import('playwright')
if (!existsSync(chromium.executablePath())) {
  console.log('Installing Chromium for document previews (first launch only).')
  const result = spawnSync(process.execPath, [join(dirname(require.resolve('playwright/package.json')), 'cli.js'), 'install', 'chromium'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_GC: '1' },
  })
  if (result.error || result.status !== 0) throw result.error || new Error('Could not install preview Chromium')
}
