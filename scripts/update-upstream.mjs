#!/usr/bin/env node
// Import exact upstream sources, preserving recorded host overrides. No build.
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { adaptSource } from '../lib/site-server.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(root, 'lib/site/upstream.json')
const target = join(root, 'lib/site')
const snapshotRoot = join(target, 'upstream/apps/site')
const sourcePaths = ['index.html', 'src/main.ts', 'src/styles.css', 'src/media.ts', 'src/preview.ts']
async function hashFile(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function hashSources(base) {
  return Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, await hashFile(join(base, path))])))
}

function requireSourceHashes(value, label, complete) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a path-to-SHA-256 object`)
  const paths = Object.keys(value)
  const unknown = paths.filter(path => !sourcePaths.includes(path))
  const required = complete ? sourcePaths : paths
  const invalid = required.filter(path => !/^[a-f0-9]{64}$/.test(value[path] ?? ''))
  if (unknown.length) throw new Error(`${label} has unsupported paths: ${unknown.join(', ')}`)
  if (invalid.length) throw new Error(`${label} has missing or invalid hashes: ${invalid.join(', ')}`)
  return value
}

const manifestText = await readFile(manifestPath, 'utf8').catch(error => {
  if (error.code === 'ENOENT') throw new Error('Missing lib/site/upstream.json; refusing to replace the snapshot without a recorded upstream baseline')
  throw error
})
let previous
try {
  previous = JSON.parse(manifestText)
} catch {
  throw new Error('Invalid lib/site/upstream.json; refusing to replace the snapshot without a recorded upstream baseline')
}
if (previous.repository !== 'xindong/pixiboardSDK') throw new Error('lib/site/upstream.json records an unexpected repository')
const previousSourceHashes = requireSourceHashes(previous.sourceHashes, 'sourceHashes', true)
const previousLocalSourceHashes = requireSourceHashes(previous.localSourceHashes ?? {}, 'localSourceHashes', false)
const checkedInSourceHashes = await hashSources(snapshotRoot)
const expectedSourceHashes = { ...previousSourceHashes, ...previousLocalSourceHashes }
const unrecordedChanges = sourcePaths.filter(path => checkedInSourceHashes[path] !== expectedSourceHashes[path])
if (unrecordedChanges.length) {
  throw new Error(`Current site snapshot has unrecorded changes: ${unrecordedChanges.join(', ')}; record intentional host overrides in localSourceHashes before syncing`)
}
const revisionIndex = process.argv.indexOf('--revision')
if (revisionIndex >= 0 && process.argv.includes('--latest')) throw new Error('Use --revision or --latest, not both')
const revision = revisionIndex >= 0 ? process.argv[revisionIndex + 1]
  : process.argv.includes('--latest')
    ? JSON.parse(execFileSync('gh', ['api', 'repos/xindong/pixiboardSDK/commits/main'], { encoding: 'utf8' })).sha
    : previous.revision
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Expected an immutable upstream commit SHA')
const temp = await mkdtemp(join(tmpdir(), 'dsh-pixiboard-'))
const staging = join(temp, 'upstream')
try {
  await mkdir(staging)
  const archive = execFileSync('gh', ['api', `repos/xindong/pixiboardSDK/tarball/${revision}`], { maxBuffer: 64 * 1024 * 1024 })
  await writeFile(join(temp, 'source.tgz'), archive)
  execFileSync('tar', ['-xzf', join(temp, 'source.tgz'), '-C', staging, '--strip-components=1'])
  const version = JSON.parse(await readFile(join(staging, 'packages/pixiboardjs/package.json'), 'utf8')).version
  const installedVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).dependencies.pixiboardjs
  if (version !== installedVersion) throw new Error(`Site ${version} does not match published SDK dependency ${installedVersion}`)
  // Fail before replacing our known-good snapshot if an upstream integration
  // seam changed. Never silently ship a UI copy that no longer talks to Core.
  const main = await readFile(join(staging, 'apps/site/src/main.ts'), 'utf8')
  const media = await readFile(join(staging, 'apps/site/src/media.ts'), 'utf8')
  for (const [source, seam] of [
    [main, 'import "./styles.css";'], [main, 'from "./project-store";'],
    [main, 'main()\n  .then'], [media, 'from "@pixi-board/adapter-browser";'],
  ]) {
    if (source.split(seam).length !== 2) throw new Error(`Upstream integration contract changed: ${seam}`)
  }
  adaptSource(main, '/apps/site/src/main.ts')
  adaptSource(media, '/apps/site/src/media.ts')
  // Preview is an upstream capability, not a source patch. Check the public
  // modules before replacing the snapshot; no validator/media rewriting.
  async function exportSurface(path, seen = new Set()) {
    if (seen.has(path)) return ''
    seen.add(path)
    const source = await readFile(path, 'utf8')
    let surface = source
    for (const [, specifier] of source.matchAll(/export\s+(?:\*|\{[^}]*\})\s+from\s+["'](\.[^"']+)["']/g)) {
      const target = resolve(dirname(path), specifier)
      const dependency = /\.ts$/.test(target) ? target : `${target}.ts`
      surface += '\n' + await exportSurface(dependency, seen)
    }
    return surface
  }
  function requireExports(source, names, module) {
    for (const name of names) {
      const declaration = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|class)\\s+${name}\\b`)
      const named = new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`)
      if (!declaration.test(source) && !named.test(source)) {
        throw new Error(`Upstream preview capability missing: ${module} exports ${name}`)
      }
    }
  }
  const preview = await exportSurface(join(staging, 'apps/site/src/preview.ts'))
  requireExports(preview, [
    'configureSitePreviewHost', 'isDocumentNode', 'isPreviewNode',
    'requestDocumentPreview', 'previewTypeLabel', 'reportPreviewTextureReady',
    'getPreviewTextureEpoch', 'classifyPreviewFile', 'documentPreviewImport',
  ], 'apps/site/src/preview.ts')
  const core = await exportSurface(join(staging, 'packages/core/src/index.ts'))
  requireExports(core, [
    'createPreviewSpec', 'isDocumentPreviewType', 'isPreviewNodeType', 'previewStatusLabel',
    'isAssetVariant',
  ], '@pixi-board/core')
  const validator = await readFile(join(staging, 'packages/core/src/document-validation.ts'), 'utf8')
  if (!/\bisAssetVariant\s*\(/.test(validator) || !core.includes('preview-')) {
    throw new Error('Upstream preview capability missing: immutable preview asset variants')
  }
  const site = join(temp, 'site')
  await mkdir(join(site, 'upstream'), { recursive: true })
  // sourceHashes always describes pristine upstream source. localSourceHashes
  // names the only files a host may replace, so a sync can validate the
  // checked-in snapshot and preserve intentional customization without hiding
  // an unrecorded edit or overwriting an upstream change.
  const upstreamSourceHashes = await hashSources(join(staging, 'apps/site'))
  const localSourceHashes = {}
  const hostOverrides = Object.keys(previousLocalSourceHashes)
  for (const path of hostOverrides) {
    if (upstreamSourceHashes[path] !== previousSourceHashes[path]) {
      throw new Error(`Upstream changed host-overridden source: ${path}; merge the host change into the new upstream revision and update localSourceHashes before syncing`)
    }
  }
  // Apply host overrides before copying the staged tree. Copying first and
  // patching staging afterwards would quietly ship the pristine upstream files.
  for (const path of hostOverrides) {
    await cp(join(snapshotRoot, path), join(staging, 'apps/site', path))
    localSourceHashes[path] = await hashFile(join(staging, 'apps/site', path))
  }
  // A host override is the difference from pristine upstream. Keep the two
  // hash sets distinct, otherwise a customized file would be mislabeled as
  // the source baseline and future upstream changes to it would go unnoticed.
  for (const path of hostOverrides) {
    if (localSourceHashes[path] === upstreamSourceHashes[path]) {
      throw new Error(`Host override does not differ from upstream source: ${path}; remove it from localSourceHashes`)
    }
  }
  await cp(join(staging, 'apps/site'), join(site, 'upstream/apps/site'), { recursive: true })
  await cp(join(staging, 'LICENSE'), join(site, 'upstream/LICENSE'))
  // The site and renderer versions are from the pinned upstream pnpm lockfile.
  const lock = await readFile(join(staging, 'pnpm-lock.yaml'), 'utf8')
  const versionOf = (section, name) => {
    const block = lock.split(`  ${section}:\n`)[1]?.split(/\n  [^ ]/)[0]
    const match = block?.match(new RegExp(`      ${name.replace('.', '\\.')}:[\\s\\S]*?        version: ([^\\s(]+)`))
    if (!match) throw new Error(`Missing lockfile version: ${section}/${name}`)
    return match[1]
  }
  const dependencies = {
    'pixi.js': versionOf('packages/renderer-pixi', 'pixi.js'),
    lucide: versionOf('apps/site', 'lucide'),
    three: versionOf('apps/site', 'three'),
  }
  const artifacts = {}
  for (const [name, version] of Object.entries(dependencies)) {
    const response = await fetch(`https://registry.npmjs.org/${name}/${version}`)
    if (!response.ok) throw new Error(`Cannot read npm metadata for ${name}@${version}`)
    const metadata = await response.json()
    const tarResponse = await fetch(metadata.dist.tarball)
    if (!tarResponse.ok) throw new Error(`Cannot download ${name}@${version}`)
    const bytes = Buffer.from(await tarResponse.arrayBuffer())
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    if (metadata.dist.integrity !== integrity) throw new Error(`Integrity mismatch: ${name}`)
    if (name === 'three') {
      const installed = JSON.parse(await readFile(join(root, 'node_modules/three/package.json'), 'utf8')).version
      if (installed !== version) throw new Error(`Installed three@${installed} does not match upstream ${version}`)
      artifacts[name] = { version, integrity }
      continue
    }
    const extracted = join(temp, 'extracted', name)
    const target = join(site, 'deps', name)
    await mkdir(extracted, { recursive: true })
    await mkdir(target, { recursive: true })
    await writeFile(join(temp, 'dep.tgz'), bytes)
    execFileSync('tar', ['-xzf', join(temp, 'dep.tgz'), '-C', extracted, '--strip-components=1'])
    const copied = new Set()
    async function copyModule(path) {
      if (copied.has(path)) return
      copied.add(path)
      const bytes = await readFile(join(extracted, path))
      await mkdir(dirname(join(target, path)), { recursive: true })
      await writeFile(join(target, path), bytes)
      if (!/\.m?js$/.test(path)) return
      // Copy the published module graph, not recompile or bundle it. Only
      // relative module imports participate; bare 'three' uses our import map.
      const code = bytes.toString('utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      for (const [, specifier] of code.matchAll(/\b(?:from\s*|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
        const dependency = resolve('/module-graph', dirname(path), specifier)
        const relative = dependency.slice('/module-graph/'.length)
        if (!dependency.startsWith('/module-graph/')) throw new Error('Unsafe dependency path')
        await copyModule(relative)
      }
    }
    await copyModule('LICENSE')
    if (name === 'pixi.js') await copyModule('dist/pixi.mjs')
    else if (name === 'lucide') {
      await copyModule('dist/esm/createElement.mjs')
      const icons = await readFile(join(staging, 'apps/site/src/ui/icons.ts'), 'utf8')
      const names = icons.match(/import\s*\{([\s\S]*?)\}\s*from "lucide"/)?.[1]
        .split(',').map(value => value.trim()).filter(value => value && !value.startsWith('type ') && !value.startsWith('createElement'))
      if (!names?.length) throw new Error('Cannot resolve upstream Lucide imports')
      for (const icon of names) {
        const slug = icon.replace(/([a-z\d])([A-Z])/g, '$1-$2').replace(/([a-zA-Z])(\d+)/g, '$1-$2').toLowerCase()
        await copyModule(`dist/esm/icons/${slug}.mjs`)
      }
    }
    artifacts[name] = { version, integrity }
    console.log(`Imported ${name}@${version}`)
  }
  // SDK site archive classification uses this published browser module via the import map.
  await cp(join(root, 'node_modules/fflate/esm/browser.js'), join(site, 'deps/fflate.mjs'))
  await cp(join(root, 'node_modules/fflate/LICENSE'), join(site, 'deps/fflate.LICENSE'))
  const pending = await mkdtemp(join(target, '.upstream-update-'))
  const replaced = []
  try {
    for (const name of ['upstream', 'deps']) await cp(join(site, name), join(pending, name), { recursive: true })
    await mkdir(join(pending, 'previous'))
    for (const name of ['upstream', 'deps']) {
      await rename(join(target, name), join(pending, 'previous', name))
      try { await rename(join(pending, name), join(target, name)) }
      catch (error) {
        await rename(join(pending, 'previous', name), join(target, name))
        throw error
      }
      replaced.push(name)
    }
    await writeFile(manifestPath, JSON.stringify({
      repository: 'xindong/pixiboardSDK',
      revision,
      version,
      dependencies: artifacts,
      sourceHashes: upstreamSourceHashes,
      ...(Object.keys(localSourceHashes).length ? { localSourceHashes } : {}),
    }, null, 2) + '\n')
  } catch (error) {
    for (const name of replaced.reverse()) {
      await rm(join(target, name), { recursive: true, force: true })
      await rename(join(pending, 'previous', name), join(target, name))
    }
    throw error
  } finally {
    await rm(pending, { recursive: true, force: true })
  }
  const overrides = Object.keys(localSourceHashes)
  console.log(`Imported PixiBoardSDK site at ${revision}; browser SDK is pixiboardjs@${version} from npm.${overrides.length ? ` Preserved host overrides: ${overrides.join(', ')}.` : ''}`)
} finally {
  await rm(temp, { recursive: true, force: true })
}
