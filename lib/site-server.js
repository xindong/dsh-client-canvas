import { readFile, realpath, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { createHash } from 'node:crypto'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PREFIX = '/xindong-canvas/site/'
const ROOT = resolve(fileURLToPath(new URL('./site/', import.meta.url)))
const runtimeRequire = createRequire(import.meta.url)
const SDK_BROWSER = runtimeRequire.resolve('pixiboardjs/browser')
const THREE_ROOT = dirname(dirname(runtimeRequire.resolve('three')))
function sourcePath(relative) {
  return resolve(ROOT, relative)
}

const moduleMap = {
  'pixiboardjs/browser': 'sdk/browser.js',
  '@pixi-board/core': 'sdk/browser.js',
  '@pixi-board/capabilities': 'sdk/browser.js',
  '@pixi-board/renderer-pixi': 'sdk/browser.js',
  '@pixi-board/adapter-browser': 'sdk/browser.js',
  'pixi.js': 'deps/pixi.js/dist/pixi.mjs',
  lucide: 'lucide.js',
  fflate: 'deps/fflate.mjs',
  three: 'deps/three/build/three.module.js',
  'three/examples/jsm/': 'deps/three/examples/jsm/',
}

function isInside(root, path) {
  return path === root || path.startsWith(root + sep)
}

const cache = new Map()
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml',
}

function patchOnce(source, search, replacement, name) {
  if (source.split(search).length !== 2) throw new Error(`Upstream site contract changed: ${name}. Update the integration patch before syncing.`)
  return source.replace(search, replacement)
}

// Integration seams and the requested node-panel presentation overrides.
// Upstream interaction handlers, context menus and preview functions remain intact.
export function adaptSource(source, path) {
  if (path.endsWith('/apps/site/src/main.ts')) {
    source = 'import { processingNodeDefinition, registerPlaceholderRenderers } from "/xindong-canvas/site/adapters/processing.js";\n' + source
    source = patchOnce(source, '  nodeTypes.register(textTypeDefinition);',
      '  nodeTypes.register(textTypeDefinition);\n  nodeTypes.register(processingNodeDefinition);', 'processing node type')
    source = 'import { withConnections } from "/xindong-canvas/site/adapters/connections.js";\n' + source
    // All site node types use strict validators; retain DSH relationship fields.
    source = source.replace(/nodeTypes\.register\(([^\n]+)\);/g, 'nodeTypes.register(withConnections($1));')
    source = patchOnce(source, '      return pixiRenderer as unknown as RuntimeRenderer;',
      '      if (options.registry) registerPlaceholderRenderers(options.registry);\n      return pixiRenderer as unknown as RuntimeRenderer;', 'static placeholder renderers')
    source = patchOnce(source, '      if (!isMediaKind(node.type)) return undefined;',
      '      if (node.type === "processing") return String((node.props as Record<string, unknown>).title || "处理任务");\n      if (!isMediaKind(node.type)) return undefined;', 'processing title')
    source = patchOnce(source, '    icon: (node) => (isMediaKind(node.type) ? mediaTag(node) : undefined),',
      '    icon: (node) => node.type === "processing" ? String((node.props as Record<string, unknown>).label || "处理") + ((node.props as Record<string, unknown>).status === "failed" ? ":失败" : ":处理中") : (isMediaKind(node.type) ? mediaTag(node) : undefined),', 'processing type label')
    source = patchOnce(source, '    classPrefix: "media",',
      '    classPrefix: "media",\n    tooltip: (node) => node.type === "processing" ? [(node.props as Record<string, unknown>).title, (node.props as Record<string, unknown>).message].filter(Boolean).join(" · ") : String((node.props as Record<string, unknown>).mediaPreparationError || (node.props as Record<string, unknown>).previewError || (node.props as Record<string, unknown>).name || node.name || ""),', 'placeholder tooltip')
    source = patchOnce(source, 'import "./styles.css";',
      'import { attachViewportPersistence, documentWithViewport, fitInitialViewport } from "/xindong-canvas/site/adapters/viewport.js";', 'stylesheet / viewport adapter')
    source = patchOnce(source, 'document: restored.document,',
      'document: documentWithViewport(restored.document, activeProject?.id, host),', 'initial SDK viewport')
    source = patchOnce(source, '  await board.ready;\n  if (application) host.appendChild(application.canvas);',
      `  attachViewportPersistence(board, () => activeProject?.id, host);
  wireStatus(board);
  await board.ready;
  fitInitialViewport(board, activeProject?.id, host, padBounds(computeContentBounds(board), 80));
  wireStageTransform(board, application);
  if (application) host.appendChild(application.canvas);`, 'viewport before first visible frame')
    source = patchOnce(source, '  activeBoard = board;\n  wireStageTransform(board, application);',
      '  activeBoard = board;', 'stage transform already bound')
    source = patchOnce(source, '  wireStatus(board);\n  const resyncMediaBadges',
      '  const resyncMediaBadges', 'status already bound')
    source = patchOnce(source,
      '  board.viewport.fitBounds(padBounds(computeContentBounds(board), 80));\n}\n\n/**\n * Turns a document asset reference',
      '  // Initial camera was applied before the canvas became visible.\n}\n\n/**\n * Turns a document asset reference', 'no delayed startup fit')
    // Automatic project loads restore their own camera; explicit toolbar/keyboard
    // fit commands retain upstream behavior.
    // clearStorage uses two additional spaces of indentation.
    for (const [indent, count] of [['  ', 3], ['    ', 1]]) {
      const before = `board.selection.clear();\n${indent}board.viewport.fitBounds(padBounds(computeContentBounds(board), 80));`
      if (source.split(before).length !== count + 1) throw new Error('Upstream site contract changed: project viewport restore')
      source = source.split(before).join(`board.selection.clear();\n${indent}fitInitialViewport(board, activeProject?.id, host, padBounds(computeContentBounds(board), 80));`)
    }
    source = patchOnce(source,
      '      { id: "delete", title: "删除节点", icon: "delete" as const, hidden: false },',
      '      { id: "delete", title: "删除节点", icon: "delete" as const, hidden: true },', 'hide delete action in node panel')
    source = patchOnce(source, '      { id: "download", title: "下载原始文件", icon: "download" as const, hidden: false },',
      '      { id: "download", title: "下载原始文件", icon: "download" as const, hidden: !isMediaKind(node.type) },', 'media-only download action')
    source = patchOnce(source, '  const refreshPanel = () => {\n    const node = selectedMediaNode(board);',
      '  const refreshPanel = () => {\n    const ids = board.selection.get();\n    const node = ids.length === 1 ? board.nodes.get<MediaProps>(ids[0]) : undefined;', 'all selected node actions')
    source = patchOnce(source,
      '  selectionToolbar.addEventListener("click", (event) => {\n    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-selection-action]");\n    if (!button) return;\n    const action = button.dataset.selectionAction;\n    const node = selectedMediaNode(board);',
      '  selectionToolbar.addEventListener("click", (event) => {\n    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-selection-action]");\n    if (!button) return;\n    const action = button.dataset.selectionAction;\n    const ids = board.selection.get();\n    const node = ids.length === 1 ? board.nodes.get<MediaProps>(ids[0]) : undefined;', 'all selected node action dispatch')
    source = patchOnce(source, '  window.open(url, "_blank", "noopener,noreferrer");',
      '  const boardId = activeProject?.id;\n  if (!boardId) return;\n  window.open(`/xindong-canvas/boards/${encodeURIComponent(boardId)}/assets/${encodeURIComponent(assetId)}/original`, "_blank", "noopener,noreferrer");', 'sandboxed original asset open')
    // SDK owns ratio/preview visibility. Anchor only on the action identity.
    const ratioActions = source.match(/^.*\{ id: "restore-ratio",[^\n]*$/gm) || []
    if (ratioActions.length !== 1) throw new Error('Upstream site contract changed: node agent action anchor')
    source = patchOnce(source, ratioActions[0],
      `${ratioActions[0]}\n      { id: "agent", title: "Agent 操作", icon: "agent" as const, hidden: false },`, 'node agent action')
    source = patchOnce(source, '          button.append(createIcon(action.icon, { size: 15 }));',
      `          button.append(createIcon(action.icon, { size: 15 }));
          const label = action.id === "download" ? "下载" : action.id === "restore-ratio" ? "重置比例" : action.id === "refresh-preview" ? "重置预览" : action.id === "agent" ? "Agent 操作" : undefined;
          if (label) {
            button.classList.add("dsh-node-action-labeled");
            button.append(document.createTextNode(label));
            button.setAttribute("aria-label", label);
          }`, 'node action text labels')
    source = patchOnce(source,
      '#selection-actions, .pixiboard-handle, .inline-media-audio',
      '#selection-actions, .dsh-node-agent-item, .pixiboard-connection-port, .pixiboard-handle, .inline-media-audio', 'node editor overlay pan target');
    source = patchOnce(source, 'from "./project-store";', 'from "/xindong-canvas/site/adapters/store.js";', 'project store')
    source = patchOnce(source, 'main()\n  .then', 'const dshReady = main()\n  .then', 'bootstrap')
    source += '\nexport { dshReady, activeBoard, mediaLibrary, projectStore, textureCache };\n'
  }
  if (path.endsWith('/apps/site/src/ui/icons.ts')) {
    source = patchOnce(source, 'export type SiteIconName = keyof typeof ICONS;',
      'export type SiteIconName = keyof typeof ICONS | "agent";', 'node agent icon type')
    source = patchOnce(source, '  return createLucideElement(ICONS[name], {',
      `  if (name === "agent") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const attributes = {
      "aria-hidden": "true",
      class: className ? \`ui-icon \${className}\` : "ui-icon",
      focusable: "false",
      viewBox: "0 0 24 24",
      height: String(size),
      width: String(size),
      fill: "none",
      stroke: "currentColor",
      "stroke-width": String(strokeWidth),
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    };
    for (const [key, value] of Object.entries(attributes)) svg.setAttribute(key, value);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M21 15a4 4 0 0 1-4 4H7l-4 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z");
    svg.append(path);
    return svg;
  }
  return createLucideElement(ICONS[name], {`, 'inline node agent icon')
  }
  if (path.endsWith('/apps/site/src/media.ts')) {
    source = patchOnce(source, 'from "@pixi-board/adapter-browser";', 'from "/xindong-canvas/site/adapters/persistence.js";', 'media persistence')
  }
  return source
}

function canonicalImports(source, path) {
  // Native ESM requires extensions. Resolve local SDK source imports without
  // changing bare specifiers, which the iframe's import map handles.
  return source.replace(/(\b(?:from\s*|import\s*(?:\(\s*)?))(["'])(\.{1,2}\/[^"']+)\2/g,
    (match, prefix, quote, specifier) => {
      if (extname(specifier)) return match
      const target = resolve(dirname(path), specifier)
      const suffix = ['.ts', '.js', '/index.ts'].find(candidate => existsSync(target + candidate))
      return suffix ? `${prefix}${quote}${specifier}${suffix}${quote}` : match
    })
}

async function siteHtml() {
  let html = await readFile(sourcePath('upstream/apps/site/index.html'), 'utf8')
  const imports = Object.fromEntries(Object.entries(moduleMap).map(([name, path]) => [name, PREFIX + path]))
  html = patchOnce(html, '</head>',
    `<link rel="stylesheet" href="${PREFIX}upstream/apps/site/src/styles.css">\n<link rel="stylesheet" href="${PREFIX}adapters/node-panel.css">\n<script type="importmap">${JSON.stringify({ imports })}</script>\n</head>`, 'head')
  html = html.replace(/\saccept="[^"]*"/g, '');
  return patchOnce(html, '<script type="module" src="/src/main.ts"></script>',
    `<script type="module" src="${PREFIX}entry.js"></script>`, 'entry')
}

async function lucideModule() {
  const icons = await readFile(sourcePath('upstream/apps/site/src/ui/icons.ts'), 'utf8')
  const names = icons.match(/import\s*\{([\s\S]*?)\}\s*from "lucide"/)?.[1]
    .split(',').map(value => value.trim()).filter(value => value && !value.startsWith('type ') && !value.startsWith('createElement'))
  if (!names?.length) throw new Error('Cannot resolve upstream Lucide icons')
  return `export { default as createElement } from '${PREFIX}deps/lucide/dist/esm/createElement.mjs';\n` + names.map(name => {
    const slug = name.replace(/([a-z\d])([A-Z])/g, '$1-$2').replace(/([a-zA-Z])(\d+)/g, '$1-$2').toLowerCase()
    return `export { default as ${name} } from '${PREFIX}deps/lucide/dist/esm/icons/${slug}.mjs';`
  }).join('\n')
}

export async function serveSite(req, res) {
  const url = new URL(req.url || '/', 'http://localhost')
  if (url.pathname === PREFIX.slice(0, -1)) {
    res.writeHead(302, { location: PREFIX }); res.end(); return true
  }
  if (!url.pathname.startsWith(PREFIX)) return false
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return true
  }
  let relative
  try { relative = decodeURIComponent(url.pathname.slice(PREFIX.length)) } catch {
    res.writeHead(400); res.end(); return true
  }
  let body
  let type
  if (!relative || relative === 'index.html') {
    body = Buffer.from(await siteHtml()); type = MIME['.html']
  } else if (relative === 'lucide.js') {
    body = Buffer.from(await lucideModule()); type = MIME['.js']
  } else {
    const pinnedPath = resolve(ROOT, relative)
    const fromThree = relative.startsWith('deps/three/')
    let path = relative === 'sdk/browser.js' ? SDK_BROWSER
      : fromThree ? resolve(THREE_ROOT, relative.slice('deps/three/'.length)) : sourcePath(relative)
    if (!isInside(ROOT, pinnedPath) || (fromThree && !isInside(THREE_ROOT, path))
      || !MIME[extname(path)] || relative.includes('\\')) {
      res.writeHead(404); res.end(); return true
    }
    let info, actualPath
    try {
      actualPath = await realpath(path)
      if (fromThree && !isInside(await realpath(THREE_ROOT), actualPath)) {
        res.writeHead(404); res.end(); return true
      }
      info = await stat(actualPath)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
      res.writeHead(404); res.end(); return true
    }
    if (!info.isFile()) { res.writeHead(404); res.end(); return true }
    path = actualPath
    const stamp = `${info.mtimeMs}:${info.size}`
    let cached = cache.get(path)
    if (!cached || cached.stamp !== stamp) {
      let bytes = await readFile(path)
      if (path.endsWith('.ts')) {
        const source = adaptSource(bytes.toString('utf8'), path)
        // Runtime type erasure, NOT a build or typecheck. This serves the
        // checked-in upstream source directly, without a stale compiled copy.
        const javascript = stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url.pathname })
        bytes = Buffer.from(canonicalImports(javascript, path))
      }
      cached = { stamp, body: bytes }
      cache.set(path, cached)
    }
    body = cached.body; type = MIME[extname(path)]
  }
  const etag = `"${createHash('sha256').update(body).digest('hex')}"`
  const headers = { 'content-type': type, 'cache-control': 'no-cache', etag, 'x-content-type-options': 'nosniff' }
  if (type === MIME['.html']) headers['content-security-policy'] = "frame-ancestors 'self'"
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return true }
  res.writeHead(200, { ...headers, 'content-length': String(body.length) })
  res.end(req.method === 'HEAD' ? undefined : body)
  return true
}
