import "./styles.css";
import {
  attachDomTransformer,
  attachLabelOverlay,
  attachSelectionOverlay,
  createPixiBoard,
  type BoardConnection,
  type ConnectionsController,
  type CustomNodeDefinition,
  type CustomTextureLease,
  type DomTransformer,
  type PixiBoard,
  type RuntimeRenderer,
} from "pixiboardjs/browser";
import { NodeTypeRegistry, type AssetRef, type BoardDocument, type BoardNode } from "@pixi-board/core";
import { createPixiApplicationFactory, loadPixiRuntime, PixiBoardRenderer } from "@pixi-board/renderer-pixi";
import { createIcon } from "./ui/icons";
import {
  MediaLibrary,
  UnsupportedMediaError,
  modelVertices,
  type AssetVariant,
  type MediaImport,
  type MediaKind,
  type ModelVertex,
} from "./media";
import { createMediaPlaybackController, type MediaPlaybackController } from "./media-playback";
import { SiteProjectStore, type SiteProject } from "./project-store";
import { ProjectSwitcherController } from "./ui/project-switcher";
import { isDocumentNode, isPreviewNode, requestDocumentPreview, previewTypeLabel, reportPreviewTextureReady, getPreviewTextureEpoch, previewProperties, configureLocalPreviewRenderer, hasSitePreviewRenderer, type PreviewImportState } from "./preview";

const THREE_ORBIT_CONTROLS_URL = "three/examples/jsm/controls/OrbitControls.js";

const host = document.querySelector<HTMLDivElement>("#board-host")!;
const hudScale = document.querySelector<HTMLSpanElement>("#hud-scale")!;
const statusText = document.querySelector<HTMLSpanElement>("#status-text")!;
const toolbar = document.querySelector<HTMLDivElement>("#toolbar");
const selectionBox = document.querySelector<HTMLDivElement>("#selection-box")!;
const selectionOverlay = document.querySelector<HTMLDivElement>("#selection-overlay")!;
const handleOverlay = document.querySelector<HTMLDivElement>("#handle-overlay")!;
const mediaInput = document.querySelector<HTMLInputElement>("#media-input")!;
mediaInput.removeAttribute("accept");
const mediaOverlay = document.querySelector<HTMLDivElement>("#media-overlay")!;
const dropHint = document.querySelector<HTMLDivElement>("#drop-hint")!;
const importLock = document.querySelector<HTMLDivElement>("#import-lock")!;
const textEditorOverlay = document.querySelector<HTMLDivElement>("#text-editor-overlay")!;
const selectionActions = document.querySelector<HTMLDivElement>("#selection-actions")!;
const selectionPlayback = document.querySelector<HTMLDivElement>("#selection-playback")!;
const playbackToggle = selectionActions.querySelector<HTMLButtonElement>("[data-selection-action='toggle-playback']")!;
const playbackProgress = document.querySelector<HTMLInputElement>("#playback-progress")!;
const playbackTime = document.querySelector<HTMLSpanElement>("#playback-time")!;
const mediaPlayerViewer = document.querySelector<HTMLDivElement>("#media-player-viewer")!;
const mediaPlayerTitle = document.querySelector<HTMLElement>("#media-player-title")!;
const mediaPlayerMeta = document.querySelector<HTMLSpanElement>("[data-media-player-meta]")!;
const mediaPlayerBody = document.querySelector<HTMLDivElement>("[data-media-player-body]")!;
const mediaPlayerOpen = document.querySelector<HTMLButtonElement>("[data-media-player-open]")!;
const mediaPlayerDownload = document.querySelector<HTMLButtonElement>("[data-media-player-download]")!;
const mediaPlayerClose = document.querySelector<HTMLButtonElement>("[data-media-player-close]")!;
const uploadButton = document.querySelector<HTMLButtonElement>('button[data-action="upload"]');
const screenshotButton = document.querySelector<HTMLButtonElement>('button[data-action="export-image"]');

uploadButton?.replaceChildren(createIcon("upload", { size: 17 }));
screenshotButton?.replaceChildren(createIcon("camera", { size: 17 }));
mediaPlayerOpen.replaceChildren(createIcon("open", { size: 15 }));
mediaPlayerDownload.replaceChildren(createIcon("download", { size: 15 }));
mediaPlayerClose.replaceChildren(createIcon("x", { size: 15 }));

const selectionToolbar = document.createElement("div");
selectionToolbar.className = "selection-actions-row";

selectionActions.replaceChildren(selectionToolbar, selectionPlayback);

let activeBoard: PixiBoard | undefined;
const mediaLibrary = new MediaLibrary();
const projectStore = new SiteProjectStore();
const BOARD_NODES_CLIPBOARD_TYPE = "application/x-pixiboard-nodes";
const ARROW_KEY_STEP = 1;
const ARROW_KEY_STEP_LARGE = 10;
let clipboardNodes: BoardNode[] | undefined;
let clipboardConnections: BoardConnection[] = [];
let siteConnections: ConnectionsController | undefined;
/** Optional host integration; relationship commands remain owned by the SDK. */
export function configureSiteConnections(controller: ConnectionsController): void {
  siteConnections = controller;
}
let pasteCount = 0;
let cloneSequence = 0;
let activeProject: SiteProject | undefined;
let mediaPlayerLoadVersion = 0;

type ModelViewerState = {
  renderer: import("three").WebGLRenderer;
  scene: import("three").Scene;
  camera: import("three").PerspectiveCamera;
  controls: { update(): void; dispose(): void };
  dispose(): void;
};

type StageLike = {
  scale: { set(x: number, y: number): void };
  position: { set(x: number, y: number): void };
};

type RectProps = { fill: number };
type TextProps = { text: string; style?: Record<string, string | number | boolean | null> };
const TEXT_STYLE_DEFAULTS = { fill: 0x111827, fontFamily: "Arial, sans-serif", fontSize: 16 } as const;

const rectTypeDefinition: CustomNodeDefinition<RectProps> = {
  type: "rect",
  version: 1,
  defaults: { fill: 0x7c8cf8 },
  validate(value): RectProps {
    const candidate = (value ?? {}) as Partial<RectProps>;
    return { fill: typeof candidate.fill === "number" ? candidate.fill : 0x7c8cf8 };
  },
  getBounds(node) {
    return { minX: node.x, minY: node.y, maxX: node.x + node.width, maxY: node.y + node.height };
  },
};

const textTypeDefinition: CustomNodeDefinition<TextProps> = {
  type: "text",
  version: 1,
  defaults: { text: "" },
  // Resizing is proportional by default; Command/Ctrl temporarily unlocks
  // freeform sizing during the gesture.
  resize: { mode: "free" },
  validate(value): TextProps {
    const candidate = (value ?? {}) as Partial<TextProps>;
    return {
      text: typeof candidate.text === "string" ? candidate.text : "",
      ...(candidate.style ? { style: candidate.style } : {}),
    };
  },
  getBounds(node) {
    return { minX: node.x, minY: node.y, maxX: node.x + node.width, maxY: node.y + node.height };
  },
};

type MediaProps = PreviewImportState & { name: string; mimeType: string; size: number; duration?: number; playbackTime?: number; intrinsicWidth?: number; intrinsicHeight?: number };

/**
 * The Pixi renderer already ships image/video/audio renderers that resolve
 * `assetRefs`; core ships no node types at all, so the host declares the data
 * side of those three types here.
 *
 * The site uses gesture-level proportional resizing by default; hosts can still
 * provide content-specific resize policies.
 */
function mediaTypeDefinition(type: MediaKind): CustomNodeDefinition<MediaProps> {
  return {
    type,
    version: 1,
    defaults: { name: "", mimeType: "", size: 0 },
    resize: { mode: "free" },
    validate(value): MediaProps {
      const candidate = (value ?? {}) as Partial<MediaProps>;
      return {
        name: typeof candidate.name === "string" ? candidate.name : "",
        mimeType: typeof candidate.mimeType === "string" ? candidate.mimeType : "",
        size: typeof candidate.size === "number" ? candidate.size : 0,
        ...(typeof candidate.duration === "number" && Number.isFinite(candidate.duration) && candidate.duration > 0 ? { duration: candidate.duration } : {}),
        ...(typeof candidate.playbackTime === "number" && Number.isFinite(candidate.playbackTime) && candidate.playbackTime > 0 ? { playbackTime: candidate.playbackTime } : {}),
        ...(typeof candidate.intrinsicWidth === "number" ? { intrinsicWidth: candidate.intrinsicWidth } : {}),
        ...(typeof candidate.intrinsicHeight === "number" ? { intrinsicHeight: candidate.intrinsicHeight } : {}),
        ...previewProperties(candidate),
      };
    },
    getBounds(node) {
      return { minX: node.x, minY: node.y, maxX: node.x + node.width, maxY: node.y + node.height };
    },
    ...(["model", "html", "markdown", "text-file", "file"].includes(type) ? { renderer: previewTextureRenderer(type) } : {}),
  };
}

function previewTextureRenderer(type: MediaKind): CustomNodeDefinition<MediaProps, { lease?: CustomTextureLease }>["renderer"] {
  return {
    async create(node, context) {
      const ref = node.assetRefs?.preview;
      const lease = ref ? await context.assets.acquireTexture(ref, { kind: type }) : undefined;
      if (context.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const displayObject = await context.display.createImage?.(ref, node) ?? context.display.createContainer();
      if (lease?.texture !== undefined) displayObject.texture = lease.texture;
      displayObject.mediaKind = type;
      return { displayObject, state: { lease } };
    },
    update(view, node) {
      view.displayObject.x = node.x;
      view.displayObject.y = node.y;
      view.displayObject.rotation = node.rotation;
      view.displayObject.zIndex = node.zIndex;
      view.displayObject.width = node.width;
      view.displayObject.height = node.height;
    },
    destroy(view) {
      view.state.lease?.release?.();
      view.displayObject.destroy?.({ children: true });
    },
  };
}

function seededDocument() {
  return {
    schemaVersion: 1,
    revision: 0,
    assets: [],
    nodes: [],
  };
}

async function main(): Promise<void> {
  let application: { canvas: HTMLCanvasElement; stage: StageLike; render?(): void } | undefined;
  let pixiRenderer: PixiBoardRenderer | undefined;
  const applicationFactory = createPixiApplicationFactory({
    resizeTo: host,
    antialias: true,
    backgroundAlpha: 0,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
  });

  const nodeTypes = new NodeTypeRegistry();
  nodeTypes.register(rectTypeDefinition);
  nodeTypes.register(textTypeDefinition);
  nodeTypes.register(mediaTypeDefinition("image"));
  nodeTypes.register(mediaTypeDefinition("video"));
  nodeTypes.register(mediaTypeDefinition("audio"));
  nodeTypes.register(mediaTypeDefinition("model"));
  nodeTypes.register(mediaTypeDefinition("html"));
  nodeTypes.register(mediaTypeDefinition("markdown"));
  nodeTypes.register(mediaTypeDefinition("text-file"));
  nodeTypes.register(mediaTypeDefinition("file"));

  // A previously persisted board wins over the seeded scene so uploads survive
  // a reload; a corrupt record must not brick the demo.
  let restored: SiteProject;
  try {
    restored = await projectStore.loadActive(() => seededDocument());
  } catch (error) {
    console.warn("Failed to restore the persisted site project", error);
    const legacyDocument = await mediaLibrary.loadDocument().catch(() => undefined);
    restored = await projectStore.create("画布", legacyDocument ?? seededDocument());
  }
  activeProject = restored;

  const board = await createPixiBoard({
    container: host,
    document: restored.document,
    core: { nodeTypes },
    interactions: { pointer: true, keyboard: true },
    transform: { handles: ["nw", "ne", "se", "sw"] },
    ports: {
      events: window,
      onKeyboardEvent: (event) => handleKeyboard(event as KeyboardEvent),
      createResizeObserver: (callback) => new ResizeObserver(callback),
    },
    capture: async (input, options = {}) => {
      if (!pixiRenderer) throw new Error("Capture is unavailable before the renderer is ready");
      const result = await pixiRenderer.capture(input as never, options);
      return {
        dataUrl: result.dataUrl,
        mimeType: result.mimeType,
        ...(result.width !== undefined ? { width: result.width } : {}),
        ...(result.height !== undefined ? { height: result.height } : {}),
      };
    },
    rendererFactory: (options) => {
      pixiRenderer = new PixiBoardRenderer({
        ...(options as Record<string, unknown>),
        applicationFactory: async () => {
          const app = await applicationFactory();
          application = app as never;
          return app;
        },
        acquireTexture: (ref: AssetRef) => acquireMediaTexture(ref),
      } as ConstructorParameters<typeof PixiBoardRenderer>[0]);
      return pixiRenderer as unknown as RuntimeRenderer;
    },
  });
  await board.ready;
  if (application) host.appendChild(application.canvas);

  await refreshModelPreviews(board);

  activeBoard = board;
  wireStageTransform(board, application);
  let spacePanning = false;
  const transformer = wireSelectionOverlay(board);
  wireStatus(board);
  const resyncMediaBadges = wireMediaBadges(board);
  wireProjectMenu(board);
  wirePointerInteractions(board, transformer, resyncMediaBadges, {
    isSpacePanning: () => spacePanning,
    setSpacePanning: (value) => {
      spacePanning = value;
      transformer.setInteractive(!value);
    },
  });
  wireMediaPlayerViewer();
  wireSelectionActions(board, resyncMediaBadges);
  wireClipboardAndContextMenu(board, resyncMediaBadges);
  wireToolbar(board, resyncMediaBadges);
  wireMediaUpload(board, resyncMediaBadges);
  wirePersistence(board);
  statusText.textContent = "已就绪";

  // Fit once up front so the initial scene is centered. Later resizes must
  // NOT re-fit: the SDK already tracks `host`'s size via its own
  // ResizeObserver (packages/pixiboardjs) and Pixi's `resizeTo: host` keeps
  // the canvas pixel size in sync on its own — re-fitting here on every
  // resize would (a) race that ResizeObserver, since the native `window`
  // "resize" event fires synchronously while ResizeObserver callbacks are
  // always batched to a later frame, so fitBounds could read a stale screen
  // size, and (b) throw away whatever pan/zoom the user had set, snapping
  // back to "fit all" on every resize instead of just growing/shrinking the
  // visible area like an infinite canvas is expected to.
  board.viewport.fitBounds(padBounds(computeContentBounds(board), 80));
}

/**
 * Turns a document asset reference into a live Pixi texture. The renderer's
 * builtin media renderers call this; without it an image node resolves to an
 * empty sprite.
 */
async function acquireMediaTexture(ref: AssetRef): Promise<{ texture?: unknown; release?: () => void }> {
  // The reference carries its own variant, so no node lookup is needed. That
  // matters on restore: the first render pass runs before the board handle is
  // published, and guessing the variant there would hand a video's raw bytes
  // to the image decoder.
  const variant = (ref.variant ?? "original") as AssetVariant;
  const cacheKey = `${ref.assetId}:${variant}`;
  const previewEpoch = variant === "preview" ? getPreviewTextureEpoch(ref.assetId) : 0;
  const cached = textureCache.get(cacheKey);
  if (cached) {
    if (variant === "preview" || variant.startsWith("preview-")) reportPreviewTextureReady(ref.assetId, variant);
    return { texture: cached };
  }

  const url = await mediaLibrary.objectUrl(ref.assetId, variant);
  if (!url) return {};

  try {
    // Decode to a bitmap first: Texture.from on a bare URL returns before the
    // pixels have loaded, which yields an empty sprite on first paint.
    const pixi = await loadPixiRuntime();
    const source = await decodeToBitmap(url);
    if (variant === "preview" && previewEpoch !== getPreviewTextureEpoch(ref.assetId)) {
      (source as { close?: () => void }).close?.();
      return {};
    }
    const texture = pixi.Texture?.from(source);
    if (texture === undefined) return {};
    textureCache.set(cacheKey, texture);
    if (variant === "preview" || variant.startsWith("preview-")) reportPreviewTextureReady(ref.assetId, variant);
    return { texture };
  } catch (error) {
    // One unreadable asset must degrade to a placeholder node, never reject the
    // render pass and take the whole board down with it.
    console.warn(`Failed to decode asset ${ref.assetId} (${variant})`, error);
    return {};
  }
}

/** One GPU texture per asset variant; released wholesale when storage clears. */
const textureCache = new Map<string, unknown>();

configureLocalPreviewRenderer(async (board, node, spec) => {
  const assetId = node.assetRefs?.primary?.assetId ?? node.assetRefs?.preview?.assetId;
  if (!assetId || !isMediaKind(node.type)) throw new Error("找不到原始资源，暂无预览。");
  const requestId = (board.nodes.get(node.id)?.props as PreviewImportState | undefined)?.previewRequestId;
  const isCurrent = () => (board.nodes.get(node.id)?.props as PreviewImportState | undefined)?.previewRequestId === requestId;
  const changed = await mediaLibrary.refreshPreview(assetId, node.type, spec, isCurrent);
  if (!changed && isCurrent()) throw new Error("找不到原始资源，暂无预览。");
  if (!changed || !isCurrent()) return;
  const variant: AssetVariant = typeof changed === "string" ? changed : "preview";
  if (variant === "preview") textureCache.delete(`${assetId}:preview`);
  const current = board.nodes.get(node.id);
  if (current) {
    const assetRefs = Object.fromEntries(Object.entries(current.assetRefs ?? {}).filter(([key]) => !key.startsWith("_refreshPreview")));
    board.nodes.update(node.id, { assetRefs: { ...assetRefs, preview: { assetId, variant },
      [`_refreshPreview${Date.now()}`]: { assetId, variant } } });
  }
});

async function decodeToBitmap(url: string): Promise<ImageBitmap | HTMLImageElement> {
  const image = new Image();
  image.src = url;
  await image.decode();
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(image);
    } catch {
      // Fall back to the decoded element itself.
    }
  }
  return image;
}

// The renderer keeps node positions in raw world/document units on an
// untransformed Pixi container; the SDK's viewport (scale/offset) is state
// the host application is responsible for projecting onto the real stage.
function wireStageTransform(
  board: PixiBoard,
  application: { stage: StageLike; render?(): void } | undefined,
): void {
  if (!application) return;
  const apply = () => {
    const viewport = board.viewport.get();
    application.stage.scale.set(viewport.scale, viewport.scale);
    application.stage.position.set(viewport.offset.x, viewport.offset.y);
    // The renderer only renders on demand when it drives a document change
    // (see PixiBoardRenderer.requestFrame); this stage transform is applied
    // directly by the host and bypasses that path entirely, so pan/zoom must
    // request its own frame or the canvas would freeze on the last document
    // render until something else invalidates it.
    application.render?.();
  };
  board.on("viewport:change", apply);
  apply();
}

// Selection outlines and the multi-select bounding box both come from the SDK
// (attachSelectionOverlay), which owns the projection, element pooling and
// frame batching. The eight resize handles stay separate: they need real
// elements with live pointer handlers rather than the decorative markup an
// outline can get away with, so the SDK's DOM transformer owns those.
function wireSelectionOverlay(board: PixiBoard): DomTransformer {
  // Keep the group outline on the same bounds as the transform controller.
  // The overlay's default 6px padding would leave all eight handles visually
  // inset from the dashed multi-selection box.
  attachSelectionOverlay(board, { container: selectionOverlay, groupBoxPadding: 0, nodeOutlines: "single" });
  return attachDomTransformer(board, {
    overlay: handleOverlay,
    surface: host,
    handles: ["nw", "ne", "se", "sw"],
  });
}

function computeContentBounds(board: PixiBoard) {
  const nodes = board.find();
  if (nodes.length === 0) return { minX: 0, minY: 0, maxX: 800, maxY: 600 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const item of nodes) {
    minX = Math.min(minX, item.x);
    minY = Math.min(minY, item.y);
    maxX = Math.max(maxX, item.x + item.width);
    maxY = Math.max(maxY, item.y + item.height);
  }
  return { minX, minY, maxX, maxY };
}

function padBounds(bounds: { minX: number; minY: number; maxX: number; maxY: number }, padding: number) {
  return {
    minX: bounds.minX - padding,
    minY: bounds.minY - padding,
    maxX: bounds.maxX + padding,
    maxY: bounds.maxY + padding,
  };
}

function wireToolbar(board: PixiBoard, resyncMediaBadges: () => void): void {
  const handleAction = (event: Event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    const centerWorld = board.viewport.toWorld({ x: host.clientWidth / 2, y: host.clientHeight / 2 });
    switch (action) {
      case "add-text": {
        const width = 220;
        const props: TextProps = { text: "新文本节点", style: { ...TEXT_STYLE_DEFAULTS } };
        board.nodes.create({
          type: "text",
          x: centerWorld.x - 80,
          y: centerWorld.y,
          width,
          height: textNodeHeight(props, width),
          props,
        });
        break;
      }
      case "undo":
        board.history.undo();
        break;
      case "redo":
        board.history.redo();
        break;
      case "fit":
        board.viewport.fitBounds(padBounds(computeContentBounds(board), 80));
        break;
      case "export":
        exportDocument(board);
        break;
      case "export-image":
        void exportCanvasImage(board);
        break;
      case "cleanup-assets":
        void cleanupUnusedAssets(board);
        break;
      case "upload":
        mediaInput.click();
        break;
      case "clear-storage":
        void clearStorage(board, resyncMediaBadges);
        break;
      default:
        break;
    }
  };
  toolbar?.addEventListener("click", handleAction);
  document.querySelector<HTMLDivElement>(".tool-rail")?.addEventListener("click", handleAction);
}

function wireMediaUpload(board: PixiBoard, resyncMediaBadges: () => void): void {
  mediaInput.addEventListener("change", () => {
    const files = [...(mediaInput.files ?? [])];
    // Reset first so re-picking the same file still fires a change event.
    mediaInput.value = "";
    if (files.length) void importFiles(board, files, freeSpaceAnchor(board), resyncMediaBadges);
  });

  // Only a drag that actually carries files should arm the drop affordance;
  // dragging a node inside the canvas must not flash the hint.
  let dragDepth = 0;
  const carriesFiles = (event: DragEvent) => [...(event.dataTransfer?.types ?? [])].includes("Files");

  host.addEventListener("dragenter", (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    dropHint.hidden = false;
  });
  host.addEventListener("dragover", (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });
  host.addEventListener("dragleave", (event) => {
    if (!carriesFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropHint.hidden = true;
  });
  host.addEventListener("drop", (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    dropHint.hidden = true;
    const files = [...(event.dataTransfer?.files ?? [])];
    if (!files.length) return;
    // Drop at the pointer, so files land where the user aimed them.
    void importFiles(board, files, board.viewport.toWorld(toHostPoint(event)), resyncMediaBadges);
  });
}

function wireClipboardAndContextMenu(board: PixiBoard, resyncMediaBadges: () => void): void {
  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.hidden = true;
  document.body.appendChild(menu);

  type ContextMenuItem = { label: string; icon: string; danger?: boolean; action: () => void };

  const closeMenu = () => {
    menu.hidden = true;
    menu.replaceChildren();
  };

  const showMenu = (event: MouseEvent) => {
    event.preventDefault();
    if (host.dataset.suppressContextMenu === "true") {
      host.dataset.suppressContextMenu = "false";
      return;
    }
    const point = board.viewport.toWorld(toHostPoint(event));
    const hitId = hitTestTopmost(board, point);
    if (hitId && !board.selection.get().includes(hitId)) board.selection.set([hitId]);
    if (!hitId) board.selection.clear();

    const selected = selectedMediaNode(board);
    const selectedNode = hitId ? board.nodes.get(hitId) : undefined;
    const canvasItems: ContextMenuItem[] = [
      { label: "刷新", icon: "refresh", action: () => location.reload() },
      { label: "适配全部", icon: "fit", action: () => board.viewport.fitBounds(padBounds(computeContentBounds(board), 80)) },
    ];
    const nodeItems: ContextMenuItem[] = [
      { label: "重命名", icon: "rename", action: () => renameSelectedNode(board, resyncMediaBadges) },
      { label: "复制", icon: "copy", action: () => copySelection(board) },
      { label: "剪切", icon: "cut", action: () => cutSelection(board) },
      { label: "复制一份", icon: "duplicate", action: () => duplicateSelection(board) },
      { label: "删除", icon: "delete", danger: true, action: () => deleteSelection(board) },
      ...(selectedNode ? [{ label: "复制节点名称", icon: "text", action: () => copyNodeName(selectedNode) }] : []),
      ...(selected
        ? [
            { label: "下载原始文件", icon: "download", action: () => downloadSelectedMedia(board) },
            { label: "打开原始文件", icon: "open", action: () => openSelectedMedia(board) },
            ...(isDocumentNode(selected) ? [] : [{ label: "恢复导入时的宽高比", icon: "frame" as const, action: () => restoreSelectedMediaRatio(board) }]),
            { label: isPreviewNode(selected) ? "重置预览" : "刷新预览", icon: "refresh", action: () => refreshSelectedMediaPreview(board, resyncMediaBadges) },
          ]
        : []),
      { label: "适配全部", icon: "fit", action: () => board.viewport.fitBounds(padBounds(computeContentBounds(board), 80)) },
    ];
    const items = hitId ? nodeItems : canvasItems;

    const list = document.createElement("div");
    list.className = "context-menu-list";
    list.replaceChildren(...items.map((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `context-menu-item${item.danger ? " danger" : ""}`;
      button.dataset.icon = item.icon;
      const icon = document.createElement("span");
      icon.className = "context-menu-icon";
      icon.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.className = "context-menu-label";
      label.textContent = item.label;
      button.replaceChildren(icon, label);
      button.addEventListener("click", () => {
        closeMenu();
        item.action();
      });
      return button;
    }));
    menu.replaceChildren(list);
    menu.hidden = false;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(window.innerWidth - rect.width - 8, Math.max(8, event.clientX))}px`;
    menu.style.top = `${Math.min(window.innerHeight - rect.height - 8, Math.max(8, event.clientY))}px`;
  };

  host.addEventListener("contextmenu", showMenu);
  document.addEventListener("pointerdown", (event) => {
    if (!menu.contains(event.target as Node)) closeMenu();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu();
  });

  window.addEventListener("copy", (event) => {
    if (isTypingTarget(event.target)) return;
    if (!copySelection(board)) return;
    event.preventDefault();
    event.clipboardData?.setData(BOARD_NODES_CLIPBOARD_TYPE, "1");
    event.clipboardData?.setData("text/plain", "");
  });

  window.addEventListener("cut", (event) => {
    if (isTypingTarget(event.target)) return;
    if (!cutSelection(board)) return;
    event.preventDefault();
    event.clipboardData?.setData(BOARD_NODES_CLIPBOARD_TYPE, "1");
    event.clipboardData?.setData("text/plain", "");
  });

  window.addEventListener("paste", (event) => {
    if (isTypingTarget(event.target)) return;
    const files = [...(event.clipboardData?.files ?? [])].filter((file) => classifyMedia(file) !== undefined);
    if (files.length) {
      event.preventDefault();
      void importFiles(board, files, freeSpaceAnchor(board), resyncMediaBadges);
      return;
    }
    if (event.clipboardData?.types.includes(BOARD_NODES_CLIPBOARD_TYPE) && clipboardNodes?.length) {
      event.preventDefault();
      pasteNodes(board);
      return;
    }
    const text = event.clipboardData?.getData("text/plain")?.trim();
    if (!text) return;
    event.preventDefault();
    void pasteTextAsNode(board, text, resyncMediaBadges);
  });
}

function copySelection(board: PixiBoard): boolean {
  const selected = board.selection.get()
    .map((id) => board.nodes.get(id))
    .filter((item): item is BoardNode => item !== undefined)
    .sort((a, b) => a.zIndex - b.zIndex);
  if (selected.length === 0) return false;
  clipboardNodes = selected.map((item) => structuredClone(item));
  clipboardConnections = siteConnections?.copyWithin(selected.map(node => node.id)) ?? [];
  pasteCount = 0;
  showToast(`已复制 ${selected.length} 个节点`, "success");
  return true;
}

function copyNodeName(node: BoardNode): void {
  const name = nodeName(node).trim() || node.type;
  void navigator.clipboard.writeText(name)
    .then(() => showToast("已复制节点名称", "success"))
    .catch((error) => showToast(`复制失败：${error instanceof Error ? error.message : String(error)}`, "error"));
}

function cutSelection(board: PixiBoard): boolean {
  if (!copySelection(board)) return false;
  deleteSelection(board, "Cut nodes");
  return true;
}

function pasteNodes(board: PixiBoard): void {
  if (!clipboardNodes?.length) return;
  pasteCount += 1;
  const offset = 24 * pasteCount;
  const clones = clipboardNodes.map((item) => cloneNodeForInsert(item, { x: offset, y: offset }));
  board.transaction("Paste nodes", () => {
    for (const item of clones) board.nodes.create(item);
    siteConnections?.pasteWithin(clipboardConnections, new Map(clipboardNodes!.map((node, index) => [node.id, clones[index]!.id])));
  }, { origin: "ui" });
  board.selection.set(clones.map((item) => item.id).filter((id): id is string => typeof id === "string"));
}

function duplicateSelection(board: PixiBoard): void {
  const selected = board.selection.get()
    .map((id) => board.nodes.get(id))
    .filter((item): item is BoardNode => item !== undefined)
    .sort((a, b) => a.zIndex - b.zIndex);
  if (!selected.length) return;
  const clones = selected.map((item) => cloneNodeForInsert(item, { x: 24, y: 24 }));
  const connections = siteConnections?.copyWithin(selected.map(node => node.id)) ?? [];
  board.transaction("Duplicate nodes", () => {
    for (const item of clones) board.nodes.create(item);
    siteConnections?.pasteWithin(connections, new Map(selected.map((node, index) => [node.id, clones[index]!.id])));
  }, { origin: "ui" });
  board.selection.set(clones.map((item) => item.id).filter((id): id is string => typeof id === "string"));
}

function cloneNodeForInsert(node: BoardNode, offset: { x: number; y: number }) {
  return {
    id: `site-node-${Date.now()}-${++cloneSequence}`,
    type: node.type,
    typeVersion: node.typeVersion,
    name: node.name,
    x: node.x + offset.x,
    y: node.y + offset.y,
    width: node.width,
    height: node.height,
    rotation: node.rotation,
    zIndex: node.zIndex + 1,
    locked: node.locked,
    visible: node.visible,
    assetRefs: node.assetRefs ? structuredClone(node.assetRefs) : undefined,
    props: structuredClone(node.props),
  };
}

function deleteSelection(board: PixiBoard, label = "Delete nodes"): boolean {
  const ids = board.selection.get();
  if (!ids.length) return false;
  board.transaction(label, () => {
    for (const id of ids) board.nodes.remove(id);
  }, { origin: "ui" });
  board.selection.clear();
  return true;
}

async function pasteTextAsNode(board: PixiBoard, text: string, resyncMediaBadges: () => void): Promise<void> {
  const file = new File([text], clipboardTextFileName(text), { type: "text/plain" });
  await importFiles(board, [file], freeSpaceAnchor(board), resyncMediaBadges);
}

function clipboardTextFileName(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim().replace(/[^a-z0-9\u4e00-\u9fa5_-]+/gi, "-").slice(0, 32);
  return `${firstLine || "clipboard-text"}.txt`;
}

function nudgeSelection(board: PixiBoard, dx: number, dy: number): void {
  const ids = board.selection.get();
  if (!ids.length) return;
  board.transaction("Nudge selection", () => {
    for (const id of ids) {
      const node = board.nodes.get(id);
      if (node) board.nodes.update(id, { x: node.x + dx, y: node.y + dy });
    }
  }, { origin: "ui" });
}

function resetZoom(board: PixiBoard): void {
  const center = { x: host.clientWidth / 2, y: host.clientHeight / 2 };
  const worldCenter = board.viewport.toWorld(center);
  board.viewport.set({
    scale: 1,
    offset: { x: center.x - worldCenter.x, y: center.y - worldCenter.y },
  });
}

function zoomAtCenter(board: PixiBoard, factor: number): void {
  board.viewport.zoomAt({ x: host.clientWidth / 2, y: host.clientHeight / 2 }, factor);
}

function downloadSelectedMedia(board: PixiBoard): void {
  const node = selectedMediaNode(board);
  const assetId = selectedMediaAssetId(node);
  if (!node || !assetId) return;
  void downloadMediaAsset(assetId, node.props.name || `${node.type}-${node.id}`);
}

function openSelectedMedia(board: PixiBoard): void {
  const node = selectedMediaNode(board);
  const assetId = selectedMediaAssetId(node);
  if (!node || !assetId) return;
  void openMediaAsset(assetId);
}

async function downloadMediaAsset(assetId: string, name: string): Promise<void> {
  const url = await mediaLibrary.downloadUrl(assetId);
  if (!url) {
    showToast("原始文件不存在，无法下载", "error");
    return;
  }
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
}

async function openMediaAsset(assetId: string): Promise<void> {
  const url = await mediaLibrary.downloadUrl(assetId);
  if (!url) {
    showToast("原始文件不存在，无法打开", "error");
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

async function createModelViewer(file: File): Promise<HTMLElement> {
  const modelWindow = window as Window & { __pixiboardModelViewerCleanup?: () => void };
  modelWindow.__pixiboardModelViewerCleanup?.();
  modelWindow.__pixiboardModelViewerCleanup = undefined;
  const extension = file.name.toLowerCase().split(".").pop() ?? "model";
  const shell = document.createElement("div");
  shell.className = "model-viewer";

  const canvas = document.createElement("canvas");
  canvas.className = "model-viewer-canvas";

  const status = document.createElement("div");
  status.className = "model-viewer-status";
  status.textContent = `${extension.toUpperCase()} · ${formatBytes(file.size)}`;
  shell.replaceChildren(canvas, status);

  const THREE = await import("three");
  const vertices = await modelVertices(file, extension).catch((): ModelVertex[] => []);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe8edf3);

  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 10000);
  camera.position.set(4, 3, 5);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: false, canvas });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const ambient = new THREE.AmbientLight(0xffffff, 1.5);
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(4, 7, 6);
  const fill = new THREE.DirectionalLight(0xaecbfa, 1.2);
  fill.position.set(-5, 2, 3);
  scene.add(ambient, key, fill);

  const object = await loadModelObject(THREE, file, extension, vertices);
  scene.add(object);
  frameObject(THREE, object, camera);

  const resize = () => {
    const width = Math.max(1, shell.clientWidth);
    const height = Math.max(1, shell.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };

  const controlsModule = await import(THREE_ORBIT_CONTROLS_URL);
  const controls = new controlsModule.OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.target.set(0, 0, 0);
  controls.update();

  let disposed = false;
  const animate = () => {
    if (disposed) return;
    resize();
    controls.update();
    renderer.render(scene, camera);
    status.textContent = `${extension.toUpperCase()} · ${formatBytes(file.size)} · 拖动旋转 · 滚轮缩放`;
    requestAnimationFrame(animate);
  };
  animate();

  const state: ModelViewerState = {
    renderer,
    scene,
    camera,
    controls,
    dispose() {
      disposed = true;
      controls.dispose();
      disposeObject(THREE, object);
      renderer.dispose();
    },
  };

  modelWindow.__pixiboardModelViewerCleanup = () => state.dispose();
  return shell;
}

async function loadModelObject(
  THREE: typeof import("three"),
  file: File,
  extension: string,
  vertices: ModelVertex[],
): Promise<InstanceType<typeof THREE.Object3D>> {
  const loadUrl = URL.createObjectURL(file);
  try {
    switch (extension) {
      case "glb":
      case "gltf": {
        const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
        const loaded = await new GLTFLoader().loadAsync(loadUrl);
        return normalizeLoadedModel(THREE, loaded);
      }
      case "obj": {
        const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
        const loaded = await new OBJLoader().loadAsync(loadUrl);
        return normalizeLoadedModel(THREE, loaded);
      }
      case "fbx": {
        const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
        const loaded = await new FBXLoader().loadAsync(loadUrl);
        return normalizeLoadedModel(THREE, loaded);
      }
      case "stl": {
        const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
        const loaded = await new STLLoader().loadAsync(loadUrl);
        return normalizeLoadedModel(THREE, loaded);
      }
      case "ply": {
        const { PLYLoader } = await import("three/examples/jsm/loaders/PLYLoader.js");
        const loaded = await new PLYLoader().loadAsync(loadUrl);
        return normalizeLoadedModel(THREE, loaded);
      }
      case "dae": {
        const { ColladaLoader } = await import("three/examples/jsm/loaders/ColladaLoader.js");
        const loaded = await new ColladaLoader().loadAsync(loadUrl);
        return normalizeLoadedModel(THREE, loaded);
      }
      case "3mf": {
        const { ThreeMFLoader } = await import("three/examples/jsm/loaders/3MFLoader.js");
        const loaded = await new ThreeMFLoader().loadAsync(loadUrl);
        return normalizeLoadedModel(THREE, loaded);
      }
      case "3ds": {
        const { TDSLoader } = await import("three/examples/jsm/loaders/TDSLoader.js");
        const loaded = await new TDSLoader().loadAsync(loadUrl);
        return normalizeLoadedModel(THREE, loaded);
      }
      case "vrml":
      case "wrl": {
        const { VRMLLoader } = await import("three/examples/jsm/loaders/VRMLLoader.js");
        const loaded = await new VRMLLoader().loadAsync(loadUrl);
        return normalizeLoadedModel(THREE, loaded);
      }
      default:
        return createFallbackModel(THREE, file, extension, vertices);
    }
  } finally {
    URL.revokeObjectURL(loadUrl);
  }
}

function createFallbackModel(
  THREE: typeof import("three"),
  file: File,
  extension: string,
  vertices: ModelVertex[],
): InstanceType<typeof THREE.Object3D> {
  if (vertices.length < 3) throw new Error("此模型格式暂不支持本地查看，原文件已保存。");
  const group = new THREE.Group();
  if (vertices.length >= 3) {
    const geometry = new THREE.BufferGeometry();
    const flat = new Float32Array(vertices.flat());
    geometry.setAttribute("position", new THREE.BufferAttribute(flat, 3));
    geometry.computeBoundingBox();
    const cloud = new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0x4f7cff, size: 0.04 }));
    group.add(cloud);
  }
  group.userData.label = file.name || `${extension} model`;
  return group;
}

function normalizeLoadedModel(THREE: typeof import("three"), loaded: unknown): InstanceType<typeof THREE.Object3D> {
  const object = loaded as { scene?: unknown };
  if (object && object.scene instanceof THREE.Object3D) return object.scene;
  if (loaded instanceof THREE.Object3D) return loaded;
  if (loaded instanceof THREE.BufferGeometry) return new THREE.Mesh(loaded, new THREE.MeshStandardMaterial({ color: 0xb7c0cc }));
  throw new Error("Loaded model result is not renderable");
}

function frameObject(THREE: typeof import("three"), object: InstanceType<typeof THREE.Object3D>, camera: InstanceType<typeof THREE.PerspectiveCamera>): void {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(maxDimension) || maxDimension <= 0) return;
  object.position.sub(center);
  camera.position.set(maxDimension * 1.2, maxDimension * 0.9, maxDimension * 1.8);
  camera.lookAt(0, 0, 0);
  camera.near = Math.max(maxDimension / 1000, 0.01);
  camera.far = maxDimension * 20;
  camera.updateProjectionMatrix();
}

function disposeObject(THREE: typeof import("three"), object: InstanceType<typeof THREE.Object3D>): void {
  object.traverse((child) => {
    const mesh = child as { geometry?: { dispose?: () => void }; material?: unknown };
    mesh.geometry?.dispose?.();
    disposeMaterial(THREE, mesh.material);
  });
}

function disposeMaterial(THREE: typeof import("three"), material: unknown): void {
  if (Array.isArray(material)) {
    material.forEach((entry) => disposeMaterial(THREE, entry));
    return;
  }
  if (material && typeof material === "object" && "dispose" in material) {
    (material as { dispose?: () => void }).dispose?.();
  }
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function mediaKindLabel(kind: MediaKind): string {
  return ({
    image: "图片",
    video: "视频",
    audio: "音频",
    model: "模型",
    html: "HTML",
    markdown: "Markdown",
    "text-file": "文本",
    file: "文件",
  } satisfies Record<MediaKind, string>)[kind];
}

function loadingView(message: string): HTMLElement {
  const shell = document.createElement("div");
  shell.className = "viewer-state";
  const spinner = document.createElement("span");
  spinner.className = "viewer-spinner";
  spinner.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.textContent = message;
  shell.replaceChildren(spinner, label);
  return shell;
}

function errorView(message: string): HTMLElement {
  const shell = document.createElement("div");
  shell.className = "viewer-state viewer-state-error";
  shell.textContent = message;
  return shell;
}

function openSelectedMediaPlayer(board: PixiBoard): void {
  const node = selectedMediaNode(board);
  const assetId = selectedMediaAssetId(node);
  if (!node || !assetId || !canPlayMediaKind(node.type)) return;

  const loadVersion = ++mediaPlayerLoadVersion;
  mediaPlayerTitle.textContent = node.props.name || (node.type === "video" ? "视频播放" : "音频播放");
  mediaPlayerMeta.textContent = `${mediaKindLabel(node.type)} · ${formatBytes(node.props.size)}`;
  mediaPlayerOpen.onclick = () => void openMediaAsset(assetId);
  mediaPlayerDownload.onclick = () => void downloadMediaAsset(assetId, node.props.name || `${node.type}-${node.id}`);
  mediaPlayerBody.replaceChildren(loadingView("正在载入媒体…"));
  mediaPlayerViewer.hidden = false;

  void mediaLibrary.objectUrl(assetId, "original").then((url) => {
    if (loadVersion !== mediaPlayerLoadVersion || mediaPlayerViewer.hidden) return;
    if (!url) throw new Error("原始文件不存在");
    const element = document.createElement(node.type === "video" ? "video" : "audio");
    element.controls = true;
    element.preload = "metadata";
    element.src = url;
    if (node.type === "video") {
      (element as HTMLVideoElement).playsInline = true;
    }
    mediaPlayerBody.replaceChildren(element);
    void element.play().catch(() => undefined);
  }).catch((error) => {
    mediaPlayerBody.replaceChildren(errorView(`播放失败：${error instanceof Error ? error.message : String(error)}`));
    showToast(`播放失败：${error instanceof Error ? error.message : String(error)}`, "error");
  });
}

function wireMediaPlayerViewer(): void {
  const close = () => {
    mediaPlayerLoadVersion += 1;
    for (const element of mediaPlayerBody.querySelectorAll<HTMLMediaElement>("video,audio")) {
      element.pause();
      element.removeAttribute("src");
      element.load();
    }
    mediaPlayerViewer.hidden = true;
    mediaPlayerMeta.textContent = "";
    mediaPlayerOpen.onclick = null;
    mediaPlayerDownload.onclick = null;
    mediaPlayerBody.replaceChildren();
  };
  mediaPlayerOpen.replaceChildren(createIcon("open", { size: 15 }));
  mediaPlayerDownload.replaceChildren(createIcon("download", { size: 15 }));
  mediaPlayerClose.replaceChildren(createIcon("x", { size: 15 }));
  mediaPlayerClose.addEventListener("click", close);
  mediaPlayerViewer.addEventListener("pointerdown", (event) => {
    if (event.target === mediaPlayerViewer) close();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !mediaPlayerViewer.hidden) close();
  });
}

function restoreSelectedMediaRatio(board: PixiBoard): void {
  const node = selectedMediaNode(board);
  if (node) restoreMediaAspectRatio(board, node);
}

function restoreMediaAspectRatio(board: PixiBoard, node: BoardNode<MediaProps>): void {
  const intrinsicWidth = node.props.intrinsicWidth;
  const intrinsicHeight = node.props.intrinsicHeight;
  if (!intrinsicWidth || !intrinsicHeight) {
    showToast("这个节点没有记录导入尺寸", "error");
    return;
  }
  // Keep the current width scale, then derive the height from the imported ratio.
  const scale = node.width / intrinsicWidth;
  const width = intrinsicWidth * scale;
  const height = intrinsicHeight * scale;
  // Node rotation is around its top-left, so keep its rotated visual center fixed.
  const cos = Math.cos(node.rotation);
  const sin = Math.sin(node.rotation);
  const centerX = node.x + (cos * node.width - sin * node.height) / 2;
  const centerY = node.y + (sin * node.width + cos * node.height) / 2;
  const nextOffsetX = (cos * width - sin * height) / 2;
  const nextOffsetY = (sin * width + cos * height) / 2;
  board.transaction("Restore imported aspect ratio", () => board.nodes.update<MediaProps>(node.id, {
    width,
    height,
    x: centerX - nextOffsetX,
    y: centerY - nextOffsetY,
  }), { origin: "ui" });
}

function refreshSelectedMediaPreview(board: PixiBoard, resyncMediaBadges: () => void): void {
  const node = selectedMediaNode(board);
  const assetId = selectedMediaAssetId(node);
  if (!node || !assetId || !isMediaKind(node.type)) return;
  if (isPreviewNode(node)) {
    void requestDocumentPreview(board, node.id, { reason: "refresh" })
      .catch((error) => showToast(`刷新失败：${error instanceof Error ? error.message : String(error)}`, "error"));
    showToast("正在重置预览...");
    return;
  }
  showToast("正在刷新预览...");
  void mediaLibrary.refreshPreview(assetId, node.type).then((changed) => {
    if (!changed) {
      showToast("这个资源没有可刷新的派生预览", "error");
      return;
    }
    for (const variant of ["preview", "waveform"] as const) textureCache.delete(`${assetId}:${variant}`);
    const current = board.nodes.get<MediaProps>(node.id);
    if (current) {
      const refreshVariant: AssetVariant = current.type === "audio" ? "waveform" : "preview";
      const assetRefs = Object.fromEntries(
        Object.entries(current.assetRefs ?? {}).filter(([key]) => !key.startsWith("_refreshPreview")),
      );
      board.nodes.update<MediaProps>(node.id, {
        assetRefs: {
          ...assetRefs,
          [`_refreshPreview${Date.now()}`]: { assetId, variant: refreshVariant },
        },
      });
    }
    resyncMediaBadges();
    showToast("预览已刷新", "success");
  }).catch((error) => showToast(`刷新失败：${error instanceof Error ? error.message : String(error)}`, "error"));
}

function selectedMediaAssetId(node: BoardNode<MediaProps> | undefined): string | undefined {
  return node?.assetRefs?.primary?.assetId ?? node?.assetRefs?.preview?.assetId ?? node?.assetRefs?.poster?.assetId ?? node?.assetRefs?.waveform?.assetId;
}

function renameSelectedNode(board: PixiBoard, resyncMediaBadges: () => void): void {
  const [nodeId, extra] = board.selection.get();
  if (!nodeId || extra) return;
  beginNodeRename(board, nodeId, resyncMediaBadges);
}

function beginNodeRename(board: PixiBoard, nodeId: string, resyncMediaBadges: () => void): void {
  const node = board.nodes.get(nodeId);
  if (!node) return;
  const currentName = nodeName(node);
  const existing = textEditorOverlay.querySelector<HTMLElement>("[data-node-rename]");
  existing?.remove();
  // Keep the live media badge from rendering underneath the editor. Both
  // layers contain the same name, which reads as a ghosted duplicate while
  // the input is active.
  mediaOverlay.classList.add("is-editing-name");

  const input = document.createElement("input");
  input.className = "node-name-editor";
  input.dataset.nodeRename = nodeId;
  input.value = currentName;
  input.placeholder = currentName;
  input.maxLength = 160;
  input.spellcheck = false;
  input.setAttribute("aria-label", "节点名称");

  let finished = false;
  let cancelled = false;
  const save = () => {
    if (finished || cancelled) return;
    finished = true;
    const latest = board.nodes.get(nodeId);
    if (!latest) {
      input.remove();
      return;
    }
    const nextName = input.value.trim();
    const latestName = nodeName(latest);
    if (nextName && nextName !== latestName) {
      applyNodeRename(board, latest, nextName);
      resyncMediaBadges();
    }
    input.remove();
    board.focus();
  };

  const cancel = () => {
    if (finished) return;
    cancelled = true;
    finished = true;
    input.remove();
    board.focus();
  };

  input.addEventListener("pointerdown", (event) => event.stopPropagation());
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("wheel", (event) => {
    event.preventDefault();
    event.stopPropagation();
  }, { passive: false });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  });
  input.addEventListener("blur", () => save());
  textEditorOverlay.appendChild(input);

  const reposition = () => {
    if (!input.isConnected) return;
    const latest = board.nodes.get(nodeId);
    if (!latest) {
      input.remove();
      return;
    }
    positionNodeRenameEditor(board, latest, input);
  };
  reposition();
  const unsubscribeChange = board.on("change", reposition);
  const unsubscribeViewport = board.on("viewport:change", reposition);
  const originalRemove = input.remove.bind(input);
  let removed = false;
  input.remove = () => {
    if (removed) return;
    removed = true;
    mediaOverlay.classList.remove("is-editing-name");
    unsubscribeChange();
    unsubscribeViewport();
    window.removeEventListener("resize", reposition);
    originalRemove();
  };
  window.addEventListener("resize", reposition);

  window.requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function applyNodeRename(board: PixiBoard, node: BoardNode, nextName: string): void {
  board.transaction("Rename node", () => {
    if (isMediaKind(node.type)) {
      const mediaNode = node as BoardNode<MediaProps>;
      board.nodes.update<MediaProps>(node.id, { name: nextName, props: { ...mediaNode.props, name: nextName } });
    } else if (node.type === "text") {
      const textNode = node as BoardNode<TextProps>;
      board.nodes.update<TextProps>(node.id, { name: nextName, props: { ...textNode.props, text: nextName } });
    } else {
      board.nodes.update(node.id, { name: nextName });
    }
  }, { origin: "ui" });
}

function positionNodeRenameEditor(board: PixiBoard, node: BoardNode, form: HTMLElement): void {
  const screen = nodeScreenRect(board, node);
  const tagWidth = mediaTagScreenWidth(node);
  const width = Math.min(Math.max(180, screen.maxX - screen.minX), 360);
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, screen.minX + tagWidth + 5));
  const top = Math.max(12, Math.min(window.innerHeight - 42, screen.minY - 22));
  form.style.left = `${left}px`;
  form.style.top = `${top - 2}px`;
  form.style.width = `${width}px`;
}

function mediaTagScreenWidth(node: BoardNode): number {
  if (!isMediaKind(node.type)) return 0;
  return Math.ceil([...mediaTag(node)].reduce((width, character) => width + (character.charCodeAt(0) > 127 ? 10 : 6), 12));
}

function nodeName(node: BoardNode): string {
  if (isMediaKind(node.type)) {
    const props = node.props as Partial<MediaProps>;
    return typeof props.name === "string" && props.name ? props.name : node.name || node.type;
  }
  if (node.type === "text") {
    const props = node.props as Partial<TextProps>;
    return typeof props.text === "string" && props.text ? props.text : node.name || "文本";
  }
  return node.name || node.type;
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) || element.isContentEditable;
}

/**
 * Imports each file, laying the resulting nodes out in a row that grows into a
 * grid, anchored on the requested world point. Nodes are created one at a time
 * so a single bad file cannot abort the whole batch.
 */
async function importFiles(
  board: PixiBoard,
  files: File[],
  anchor: { x: number; y: number },
  resyncMediaBadges: () => void,
): Promise<void> {
  const supported = files;
  if (!supported.length) return;

  importLock.hidden = false;
  host.style.pointerEvents = "none";
  statusText.textContent = `正在导入 ${supported.length} 个资源`;
  showToast(`正在处理 ${supported.length} 个文件…`);
  const created: MediaImport[] = [];
  const previewNodeIds: string[] = [];
  let cursor = { x: anchor.x, y: anchor.y };
  let rowHeight = 0;
  let rowWidth = 0;

  try {
    for (const file of supported) {
      try {
        const media = await mediaLibrary.importFile(file);
        // Wrap the row once it grows past a comfortable width so a large batch
        // does not stretch off into empty space.
        if (rowWidth > 0 && rowWidth + media.width > 720) {
          cursor = { x: anchor.x, y: cursor.y + rowHeight + 16 };
          rowWidth = 0;
          rowHeight = 0;
        }
        const createdNode = await board.nodes.create<MediaProps>({
          type: media.kind,
          x: cursor.x + rowWidth,
          y: cursor.y,
          width: media.width,
          height: media.height,
          assetRefs: mediaAssetRefs(media),
          props: {
            name: media.name,
            mimeType: media.mimeType,
            size: media.size,
            ...(media.duration ? { duration: media.duration } : {}),
            intrinsicWidth: media.width,
            intrinsicHeight: media.height,
            ...previewProperties(media),
          },
        });
        rowWidth += media.width + 16;
        rowHeight = Math.max(rowHeight, media.height);
        created.push(media);
        if (media.previewStatus === "pending") previewNodeIds.push(createdNode.id);
      } catch (error) {
        const message = error instanceof UnsupportedMediaError
          ? error.message
          : `${file.name} 处理失败：${error instanceof Error ? error.message : String(error)}`;
        showToast(message, "error");
      }
    }
  } finally {
    importLock.hidden = true;
    host.style.pointerEvents = "";
    statusText.textContent = "已就绪";
  }

  if (created.length) {
    showToast(`已添加 ${created.length} 个资源节点`, "success");
    resyncMediaBadges();
    void persist(board);
    // Dispatch after the entire import batch exists, including companion files.
    for (const nodeId of previewNodeIds) {
      void requestDocumentPreview(board, nodeId, { reason: "import" })
        .catch((error) => console.warn("Failed to start imported preview", error));
    }
  }
}

/**
 * Points the reference at the variant each builtin renderer looks for: video
 * resolves a poster, audio a waveform, image a downscaled preview when one
 * was generated (builtins.ts checks "preview" before "primary", so this is
 * picked over the original automatically) and otherwise its original bytes.
 */
function mediaAssetRefs(media: MediaImport): Record<string, AssetRef> {
  if (media.kind === "video") return { poster: { assetId: media.assetId, variant: "preview" } };
  if (media.kind === "audio") return { waveform: { assetId: media.assetId, variant: "waveform" } };
  return {
    primary: { assetId: media.assetId, variant: "original" },
    ...(media.hasPreview ? { preview: { assetId: media.assetId, variant: "preview" } } : {}),
  };
}

/**
 * Where a toolbar upload should land. Dropping aims at the pointer, but the
 * button has no pointer to aim with, so new media is stacked under the existing
 * content instead of on top of it.
 */
function freeSpaceAnchor(board: PixiBoard): { x: number; y: number } {
  const bounds = computeContentBounds(board);
  return { x: bounds.minX, y: bounds.maxY + 48 };
}

function mediaTag(node: Readonly<BoardNode>): string {
  const previewLabel = previewTypeLabel(node, KIND_ICON[node.type as MediaKind] ?? node.type.toUpperCase());
  if (previewLabel) return previewLabel;
  if (node.type === "video" || node.type === "audio") {
    const duration = (node.props as Partial<MediaProps>).duration;
    if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) return formatTime(duration);
  }
  return KIND_ICON[node.type as MediaKind] ?? node.type.toUpperCase();
}

const KIND_ICON: Record<MediaKind, string> = { image: "IMG", video: "VID", audio: "AUD", model: "3D", html: "HTML", markdown: "MD", "text-file": "TXT", file: "FILE" };

function isMediaKind(type: string): type is MediaKind {
  return ["image", "video", "audio", "model", "html", "markdown", "text-file", "file"].includes(type);
}

function canPlayMediaKind(type: string): boolean {
  return type === "video" || type === "audio";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderSimpleMarkdown(source: string): string {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const html: string[] = [];
  let inCode = false;
  let listOpen = false;

  const closeList = () => {
    if (!listOpen) return;
    html.push("</ul>");
    listOpen = false;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.startsWith("```")) {
      if (inCode) {
        html.push("</code></pre>");
      } else {
        closeList();
        html.push("<pre><code>");
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      html.push(`${escapeHtml(rawLine)}\n`);
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1]?.length ?? 1;
      html.push(`<h${level}>${escapeHtml(heading[2] ?? "")}</h${level}>`);
      continue;
    }

    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      if (!listOpen) {
        html.push("<ul>");
        listOpen = true;
      }
      html.push(`<li>${escapeHtml(bullet[1] ?? "")}</li>`);
      continue;
    }

    if (!line.trim()) {
      closeList();
      continue;
    }

    closeList();
    html.push(`<p>${escapeHtml(line)}</p>`);
  }

  if (inCode) html.push("</code></pre>");
  closeList();
  return html.join("\n");
}

function selectedMediaNode(board: PixiBoard): BoardNode<MediaProps> | undefined {
  const [nodeId, extra] = board.selection.get();
  if (!nodeId || extra) return undefined;
  const node = board.nodes.get<MediaProps>(nodeId);
  return node && isMediaKind(node.type) ? node : undefined;
}

function wireSelectionActions(board: PixiBoard, resyncMediaBadges: () => void): void {
  let activeNodeId: string | undefined;
  let activePlayback: MediaPlaybackController | undefined;
  let activeInlineElement: HTMLMediaElement | undefined;
  let activeAssetId: string | undefined;
  let scrubbing = false;
  let rafHandle: number | undefined;
  let lastPersistedPlaybackTime = 0;

  selectionActions.addEventListener("pointerdown", (event) => event.stopPropagation());
  selectionActions.addEventListener("wheel", forwardWheelToBoard, { passive: false });

  const videoFrameRefreshPatch = (node: BoardNode<MediaProps>, assetId: string): Pick<BoardNode<MediaProps>, "assetRefs"> => {
    const assetRefs = Object.fromEntries(
      Object.entries(node.assetRefs ?? {}).filter(([key]) => !key.startsWith("_refreshPreview")),
    );
    return {
      assetRefs: {
        ...assetRefs,
        [`_refreshPreview${Date.now()}`]: { assetId, variant: "preview" },
      },
    };
  };

  const persistPlaybackTime = (nodeId: string | undefined, seconds: number | undefined, force = false): void => {
    if (!nodeId || seconds === undefined) return;
    if (!Number.isFinite(seconds) || seconds < 0) return;
    if (!force && Math.abs(seconds - lastPersistedPlaybackTime) < 0.2) return;
    const node = board.nodes.get<MediaProps>(nodeId);
    if (!node || !canPlayMediaKind(node.type)) return;
    lastPersistedPlaybackTime = seconds;
    board.nodes.update<MediaProps>(node.id, { props: { ...node.props, playbackTime: seconds } });
  };

  const resetPlaybackTime = (nodeId: string): void => {
    const node = board.nodes.get<MediaProps>(nodeId);
    if (!node || !canPlayMediaKind(node.type) || node.props.playbackTime === undefined) return;
    lastPersistedPlaybackTime = 0;
    const { playbackTime: _playbackTime, ...props } = node.props;
    board.nodes.update<MediaProps>(node.id, { props });
  };

  const refreshVideoFramePreview = (nodeId: string | undefined, assetId: string | undefined, element: HTMLMediaElement | undefined): void => {
    if (!nodeId || !assetId || !(element instanceof HTMLVideoElement)) return;
    const node = board.nodes.get<MediaProps>(nodeId);
    if (!node || node.type !== "video") return;
    void mediaLibrary.updateVideoPreviewFromElement(assetId, element).then((changed) => {
      if (!changed) return;
      textureCache.delete(`${assetId}:preview`);
      const current = board.nodes.get<MediaProps>(nodeId);
      if (!current || current.type !== "video") return;
      board.nodes.update<MediaProps>(current.id, videoFrameRefreshPatch(current, assetId));
      resyncMediaBadges();
    }).catch(() => undefined);
  };

  const stopPlayback = (keepScrubbing = false) => {
    if (!keepScrubbing) scrubbing = false;
    const nodeId = activeNodeId;
    const assetId = activeAssetId;
    const element = activeInlineElement;
    const playback = activePlayback;
    const seconds = playback?.controls.currentTime();
    // Clear identity before updates emit change events and re-enter panel sync.
    activePlayback = undefined;
    activeInlineElement = undefined;
    activeNodeId = undefined;
    activeAssetId = undefined;
    persistPlaybackTime(nodeId, seconds, true);
    if (element && !element.seeking && element.readyState >= 2) refreshVideoFramePreview(nodeId, assetId, element);
    if (rafHandle !== undefined) {
      cancelAnimationFrame(rafHandle);
      rafHandle = undefined;
    }
    playback?.destroy();
    lastPersistedPlaybackTime = 0;
    selectionPlayback.hidden = true;
    playbackToggle.replaceChildren(createIcon("play", { size: 15 }));
    playbackToggle.disabled = false;
    if (!scrubbing) playbackProgress.value = "0";
    playbackTime.textContent = "0:00 / 0:00";
  };

  const currentPlaybackNode = () => {
    const node = selectedMediaNode(board);
    return node && (node.type === "video" || node.type === "audio") ? node : undefined;
  };

  const syncPlayback = () => {
    const node = currentPlaybackNode();
    selectionPlayback.hidden = !node;
    if (!node) return;
    if (activeNodeId && activeNodeId !== node.id) {
      stopPlayback();
      selectionPlayback.hidden = false;
    }
    const playback = activePlayback?.controls;
    const duration = playback?.duration() ?? node.props.duration ?? 0;
    const current = playback?.currentTime() ?? node.props.playbackTime ?? 0;
    const loading = playback?.isLoading() ?? false;
    playbackToggle.replaceChildren(createIcon(loading ? "loading" : playback?.isPlaying() ? "pause" : "play", { className: loading ? "sp-spin" : undefined, size: 15 }));
    playbackToggle.disabled = loading;
    if (!scrubbing) playbackProgress.value = duration > 0 ? String(Math.round((current / duration) * 1000)) : "0";
    playbackTime.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
  };

  const startPlaybackTick = () => {
    if (rafHandle !== undefined) return;
    const tick = () => {
      syncPlayback();
      rafHandle = requestAnimationFrame(tick);
    };
    rafHandle = requestAnimationFrame(tick);
  };

  const syncInlineElement = () => {
    if (!activeInlineElement || !activeNodeId) return;
    const node = board.nodes.get<MediaProps>(activeNodeId);
    if (!node || !canPlayMediaKind(node.type)) {
      stopPlayback();
      return;
    }
    positionInlineMediaElement(board, node, activeInlineElement);
  };

  const ensurePlayback = () => {
    const node = currentPlaybackNode();
    const assetId = node?.assetRefs?.primary?.assetId ?? node?.assetRefs?.poster?.assetId ?? node?.assetRefs?.waveform?.assetId;
    if (!node || !assetId) return undefined;
    if (activePlayback && activeNodeId === node.id) return activePlayback;
    stopPlayback(true);
    const playback = createMediaPlaybackController({
      durationFallback: node.props.duration,
      initialTime: node.props.playbackTime,
      createElement: async () => {
        const url = await mediaLibrary.objectUrl(assetId, "original");
        if (!url || activePlayback !== playback) return undefined;
        const element = document.createElement(node.type === "video" ? "video" : "audio");
        element.preload = "metadata";
        element.crossOrigin = "anonymous";
        if (node.type === "video") {
          (element as HTMLVideoElement).playsInline = true;
          element.muted = false;
          element.style.visibility = "hidden";
        } else {
          element.controls = true;
        }
        element.src = url;
        element.className = node.type === "video" ? "inline-media-element inline-media-video" : "inline-media-element inline-media-audio";
        const persistCurrentTime = () => {
          if (activeInlineElement !== element || activeNodeId !== node.id) return;
          persistPlaybackTime(node.id, playback.controls.currentTime());
        };
        const refreshCurrentFrame = () => {
          if (activeInlineElement !== element || activeNodeId !== node.id || element.seeking || element.readyState < 2) return;
          if (Math.abs(element.currentTime - playback.controls.currentTime()) > 0.05) return;
          element.style.visibility = "";
          refreshVideoFramePreview(node.id, assetId, element);
        };
        element.addEventListener("loadeddata", refreshCurrentFrame);
        element.addEventListener("pause", () => {
          persistCurrentTime();
          refreshCurrentFrame();
        });
        element.addEventListener("seeked", () => {
          persistCurrentTime();
          refreshCurrentFrame();
        });
        element.addEventListener("ended", () => {
          if (activeInlineElement === element) resetPlaybackTime(node.id);
        });
        element.addEventListener("timeupdate", persistCurrentTime);
        element.addEventListener("wheel", forwardWheelToBoard, { passive: false });
        mediaOverlay.appendChild(element);
        activeInlineElement = element;
        positionInlineMediaElement(board, node, element);
        return element;
      },
      destroyElement: (element) => {
        element.pause();
        element.removeAttribute("src");
        element.load();
        element.remove();
        if (activeInlineElement === element) activeInlineElement = undefined;
      },
    });
    playback.controls.subscribe(syncPlayback);
    activePlayback = playback;
    activeNodeId = node.id;
    activeAssetId = assetId;
    lastPersistedPlaybackTime = node.props.playbackTime ?? 0;
    startPlaybackTick();
    return playback;
  };

  const renderToolbar = (node: BoardNode<MediaProps>) => {
    const actions = [
      { id: "download", title: "下载原始文件", icon: "download" as const, hidden: false },
      { id: "restore-ratio", title: "恢复导入时的宽高比", icon: "frame" as const, hidden: isDocumentNode(node) || !node.props.intrinsicWidth || !node.props.intrinsicHeight },
      { id: "refresh-preview", title: isPreviewNode(node) ? "重置预览" : "刷新预览", icon: "refresh" as const, hidden: !isMediaKind(node.type) },
      { id: "delete", title: "删除节点", icon: "delete" as const, hidden: false },
    ];

    selectionToolbar.replaceChildren(
      ...actions
        .filter((action) => !action.hidden)
        .map((action) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "sp-button";
          button.title = action.title;
          button.setAttribute("aria-label", action.title);
          button.dataset.selectionAction = action.id;
          button.append(createIcon(action.icon, { size: 15 }));
          return button;
        }),
    );
  };

  const refreshPanel = () => {
    const node = selectedMediaNode(board);
    if (!node) {
      selectionActions.hidden = true;
      selectionToolbar.replaceChildren();
      stopPlayback();
      return;
    }
    if (!canPlayMediaKind(node.type) && activePlayback) stopPlayback();

    selectionActions.hidden = false;
    renderToolbar(node);
    const screen = nodeScreenRect(board, node);
    const panelWidth = selectionActions.getBoundingClientRect().width || 260;
    const centerX = Math.max(12 + panelWidth / 2, Math.min(window.innerWidth - panelWidth / 2 - 12, (screen.minX + screen.maxX) / 2));
    const y = Math.max(12, Math.min(window.innerHeight - 42, screen.maxY + 8));
    selectionActions.style.left = `${centerX}px`;
    selectionActions.style.top = `${y}px`;
    syncPlayback();
  };

  selectionToolbar.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-selection-action]");
    if (!button) return;
    const action = button.dataset.selectionAction;
    const node = selectedMediaNode(board);
    if (!node) return;

    if (action === "download") {
      downloadSelectedMedia(board);
    } else if (action === "restore-ratio") {
      restoreMediaAspectRatio(board, node);
    } else if (action === "refresh-preview") {
      if (isPreviewNode(node)) {
        void requestDocumentPreview(board, node.id, { reason: "reset" })
          .catch((error) => showToast(`重置失败：${error instanceof Error ? error.message : String(error)}`, "error"));
        showToast("正在重置预览...");
        return;
      }
      const assetId = node.assetRefs?.primary?.assetId ?? node.assetRefs?.preview?.assetId ?? node.assetRefs?.poster?.assetId ?? node.assetRefs?.waveform?.assetId;
      if (!assetId || !isMediaKind(node.type)) return;
      showToast("正在刷新预览...");
      void mediaLibrary.refreshPreview(assetId, node.type).then((changed) => {
        if (!changed) {
          showToast("这个资源没有可刷新的派生预览", "error");
          return;
        }
        for (const variant of ["preview", "waveform"] as const) textureCache.delete(`${assetId}:${variant}`);
        const current = board.nodes.get<MediaProps>(node.id);
        if (current) {
          const refreshVariant: AssetVariant = current.type === "audio" ? "waveform" : "preview";
          const assetRefs = Object.fromEntries(
            Object.entries(current.assetRefs ?? {}).filter(([key]) => !key.startsWith("_refreshPreview")),
          );
          board.nodes.update<MediaProps>(node.id, {
            assetRefs: {
              ...assetRefs,
              [`_refreshPreview${Date.now()}`]: { assetId, variant: refreshVariant },
            },
          });
        }
        resyncMediaBadges();
        showToast("预览已刷新", "success");
      }).catch((error) => showToast(`刷新失败：${error instanceof Error ? error.message : String(error)}`, "error"));
    } else if (action === "delete") {
      stopPlayback();
      deleteSelection(board);
    }
  });

  selectionPlayback.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-selection-action='toggle-playback']");
    if (!button) return;
    if (event.detail !== 0) return;
    void ensurePlayback()?.controls.toggle()
      .catch((error) => showToast(`播放失败：${error instanceof Error ? error.message : String(error)}`, "error"))
      .finally(syncPlayback);
  });

  playbackToggle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void ensurePlayback()?.controls.toggle()
      .catch((error) => showToast(`播放失败：${error instanceof Error ? error.message : String(error)}`, "error"))
      .finally(syncPlayback);
  });

  playbackProgress.addEventListener("pointerdown", () => {
    scrubbing = true;
  });
  playbackProgress.addEventListener("input", () => {
    const ratio = Number(playbackProgress.value) / 1000;
    const playback = ensurePlayback();
    if (!playback) return;
    const seekTime = ratio * playback.controls.duration();
    void playback.controls.seek(seekTime)
      .catch((error) => showToast(`跳转失败：${error instanceof Error ? error.message : String(error)}`, "error"))
      .finally(syncPlayback);
  });
  const stopScrubbing = () => {
    scrubbing = false;
    syncPlayback();
  };
  window.addEventListener("pointerup", stopScrubbing);
  playbackProgress.addEventListener("pointercancel", stopScrubbing);
  playbackProgress.addEventListener("blur", stopScrubbing);
  playbackProgress.addEventListener("change", stopScrubbing);

  board.on("selection:change", refreshPanel);
  board.on("viewport:change", () => {
    refreshPanel();
    syncInlineElement();
  });
  board.on("change", () => {
    refreshPanel();
    syncInlineElement();
  });
  window.addEventListener("resize", () => {
    refreshPanel();
    syncInlineElement();
  });
  refreshPanel();
}

function forwardWheelToBoard(event: WheelEvent): void {
  event.preventDefault();
  event.stopPropagation();
  host.dispatchEvent(new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: event.clientX,
    clientY: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    deltaZ: event.deltaZ,
    deltaMode: event.deltaMode,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
  }));
}

function positionInlineMediaElement(board: PixiBoard, node: BoardNode<MediaProps>, element: HTMLMediaElement): void {
  const viewport = board.viewport.get();
  const topLeft = board.viewport.toScreen({ x: node.x, y: node.y });
  element.style.left = `${topLeft.x}px`;
  element.style.top = `${topLeft.y}px`;
  element.style.width = `${Math.max(1, node.width * viewport.scale)}px`;
  element.style.height = `${Math.max(1, node.height * viewport.scale)}px`;
  element.style.transform = `rotate(${node.rotation}rad)`;
}

function nodeScreenRect(board: PixiBoard, node: BoardNode): { minX: number; minY: number; maxX: number; maxY: number } {
  const rotation = node.rotation || 0;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const corners = [
    { x: 0, y: 0 },
    { x: node.width, y: 0 },
    { x: node.width, y: node.height },
    { x: 0, y: node.height },
  ].map((corner) => board.viewport.toScreen({
    x: node.x + corner.x * cos - corner.y * sin,
    y: node.y + corner.x * sin + corner.y * cos,
  }));

  return {
    minX: Math.min(...corners.map((corner) => corner.x)),
    minY: Math.min(...corners.map((corner) => corner.y)),
    maxX: Math.max(...corners.map((corner) => corner.x)),
    maxY: Math.max(...corners.map((corner) => corner.y)),
  };
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

/**
 * Labels each media node with its kind and file name.
 *
 * The SDK's label overlay owns the hard parts: it pools elements instead of
 * rebuilding the subtree per frame, follows the renderer's visible set so cost
 * tracks what is on screen rather than document size, and collapses labels to
 * a bare icon once the board is zoomed out far enough that names would overlap.
 */
function wireMediaBadges(board: PixiBoard): () => void {
  const layer = attachLabelOverlay(board, {
    container: mediaOverlay,
    wheelSurface: host,
    classPrefix: "media",
    anchor: "top-left",
    offset: { x: 0, y: -22 },
    text: (node) => {
      if (!isMediaKind(node.type)) return undefined;
      const props = node.props as Partial<MediaProps>;
      return typeof props.name === "string" && props.name ? props.name : node.name ?? node.type;
    },
    icon: (node) => (isMediaKind(node.type) ? mediaTag(node) : undefined),
  });

  // The SDK applies "change" asynchronously (queued behind the renderer apply
  // pass), so a caller that just made a synchronous edit and wants the badges
  // to reflect it immediately — rather than a frame later — can force a flush.
  return () => layer.flush();
}

/**
 * Persists the document after changes settle. Writes are debounced and
 * serialized so a drag does not queue one IndexedDB write per frame.
 */
function wirePersistence(board: PixiBoard): void {
  let timer: number | undefined;
  board.on("change", () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => void persist(board), 400);
  });
  window.addEventListener("pagehide", () => void persist(board));
}

let persistQueue = Promise.resolve();

function persist(board: PixiBoard): Promise<void> {
  persistQueue = persistQueue
    .then(async () => {
      if (!activeProject) return;
      const snapshot = board.document.toJSON();
      await projectStore.save(activeProject.id, snapshot);
      activeProject = { ...activeProject, updatedAt: Date.now(), document: snapshot };
    })
    .catch((error) => {
      console.warn("Failed to persist the document", error);
    });
  return persistQueue;
}

async function clearStorage(board: PixiBoard, resyncMediaBadges: () => void): Promise<void> {
  try {
    await mediaLibrary.clear();
    await projectStore.clear();
    textureCache.clear();
    const project = await projectStore.create("画布", seededDocument());
    activeProject = project;
    await board.document.load(project.document, { replaceHistory: true });
    board.selection.clear();
    board.viewport.fitBounds(padBounds(computeContentBounds(board), 80));
    const currentName = document.querySelector<HTMLSpanElement>("[data-project-current]");
    if (currentName) currentName.textContent = project.name;
    resyncMediaBadges();
    showToast("已清空浏览器中保存的媒体与画布", "success");
  } catch (error) {
    showToast(`清空失败：${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

async function refreshModelPreviews(board: PixiBoard): Promise<void> {
  for (const node of board.nodes.list()) {
    if (!isPreviewNode(node)) continue;
    const status = (node.props as PreviewImportState).previewStatus;
    const unfinished = status === "pending" || status === "queued" || status === "running";
    // A host resumes its own jobs. Without one, no persisted in-flight state
    // has an owner: retry models locally and settle documents to a terminal state.
    if (hasSitePreviewRenderer()) {
      if (node.type !== "model" || status !== undefined) continue;
    } else if (!unfinished && (node.type !== "model" || status !== undefined)) continue;
    try {
      await requestDocumentPreview(board, node.id);
    } catch (error) {
      console.warn("Failed to refresh model preview", error);
    }
  }
}

async function cleanupUnusedAssets(board: PixiBoard): Promise<void> {
  try {
    if (board.history.canUndo() && !window.confirm("清理未用资源会永久删除当前所有画布都不再引用的本地文件；如果随后撤销已删除的媒体节点，文件可能无法恢复。继续清理？")) {
      return;
    }
    await persist(board);
    const [storedAssetIds, projects] = await Promise.all([mediaLibrary.assetIds(), projectStore.all()]);
    const referenced = new Set<string>();
    for (const project of projects) collectDocumentAssetIds(project.document, referenced);
    const unused = storedAssetIds.filter((assetId) => !referenced.has(assetId));
    if (!unused.length) {
      showToast("没有可清理的未用资源", "success");
      return;
    }

    for (const assetId of unused) {
      await mediaLibrary.deleteAsset(assetId);
      for (const variant of ["original", "preview", "waveform"] as const) textureCache.delete(`${assetId}:${variant}`);
    }
    showToast(`已清理 ${unused.length} 个未用资源`, "success");
  } catch (error) {
    showToast(`清理失败：${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

function collectDocumentAssetIds(document: BoardDocument, output: Set<string>): void {
  for (const node of document.nodes ?? []) {
    for (const ref of Object.values(node.assetRefs ?? {})) {
      if (ref && typeof ref.assetId === "string") output.add(ref.assetId);
    }
  }
  for (const asset of document.assets ?? []) output.add(asset.id);
}

function showToast(_message: string, _tone: "info" | "error" | "success" = "info"): void {
}

function exportDocument(board: PixiBoard): void {
  const json = JSON.stringify(board.document.toJSON(), null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "pixiboard-demo-document.json";
  link.click();
  URL.revokeObjectURL(url);
}

async function exportCanvasImage(board: PixiBoard): Promise<void> {
  try {
    const result = await board.capture({ target: "viewport", format: "png" });
    const link = document.createElement("a");
    link.href = result.dataUrl;
    link.download = "pixiboard-canvas.png";
    link.click();
    showToast("已导出画布截图", "success");
  } catch (error) {
    showToast(`截图生成失败：${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

function wireProjectMenu(board: PixiBoard): void {
  const root = document.querySelector<HTMLElement>("[data-project-switcher]");
  const trigger = document.querySelector<HTMLButtonElement>("[data-project-trigger]");
  const triggerIcon = document.querySelector<HTMLElement>("[data-project-trigger-icon]");
  const menu = document.querySelector<HTMLDivElement>("[data-project-menu]");
  const list = document.querySelector<HTMLDivElement>("[data-project-list]");
  const newButton = document.querySelector<HTMLButtonElement>("[data-project-new]");
  const currentName = document.querySelector<HTMLSpanElement>("[data-project-current]");
  if (!root || !trigger || !triggerIcon || !menu || !list || !newButton || !currentName) return;

  const controller = new ProjectSwitcherController({
    root,
    trigger,
    triggerIcon,
    current: currentName,
    menu,
    list,
    newButton,
  });

  // Project changes share the board document and active-project pointer, so
  // serialize transitions to keep autosave from observing an intermediate pair.
  let projectOperationQueue = Promise.resolve();
  const enqueueProjectOperation = (operation: () => Promise<void>): void => {
    projectOperationQueue = projectOperationQueue.then(operation, operation);
  };

  const renderProjects = async () => {
    const projects = await projectStore.list();
    controller.setProjects(projects, activeProject ?? null);
  };

  controller.setActions({
    onOpenProject: (project) => {
      enqueueProjectOperation(async () => {
        await switchProject(board, project.id);
        await renderProjects();
      });
    },
    onCreateProject: () => {
      enqueueProjectOperation(async () => {
        await createProject(board);
        controller.close();
        await renderProjects();
      });
    },
    onDeleteProject: (project) => {
      enqueueProjectOperation(async () => {
        await deleteProject(board, project.id);
        controller.close();
        await renderProjects();
      });
    },
    onRenameProject: async (project, name) => {
      if (!name || name === project.name) {
        await renderProjects();
        return;
      }
      const renamed = await projectStore.rename(project.id, name);
      if (!renamed) return;
      if (renamed.id === activeProject?.id) {
        activeProject = renamed;
      }
      await renderProjects();
      showToast("画布已重命名", "success");
    },
  });

  void renderProjects();
}

async function switchProject(board: PixiBoard, projectId: string): Promise<void> {
  await persist(board);
  const project = await projectStore.get(projectId);
  if (!project) {
    showToast("画布不存在或已被移除", "error");
    return;
  }
  await projectStore.setActive(project.id);
  activeProject = project;
  await board.document.load(project.document, { replaceHistory: true });
  await refreshModelPreviews(board);
  board.selection.clear();
  board.viewport.fitBounds(padBounds(computeContentBounds(board), 80));
  document.querySelector<HTMLSpanElement>("[data-project-current]")!.textContent = project.name;
  showToast(`已切换到 ${project.name}`, "success");
}

async function createProject(board: PixiBoard): Promise<void> {
  await persist(board);
  const project = await projectStore.create("未命名画布", seededDocument());
  activeProject = project;
  await board.document.load(project.document, { replaceHistory: true });
  await refreshModelPreviews(board);
  board.selection.clear();
  board.viewport.fitBounds(padBounds(computeContentBounds(board), 80));
  document.querySelector<HTMLSpanElement>("[data-project-current]")!.textContent = project.name;
  showToast("已新建空白画布", "success");
}

async function deleteActiveProject(board: PixiBoard): Promise<void> {
  if (!activeProject) return;
  const deletedName = activeProject.name;
  const deletedId = activeProject.id;
  await projectStore.delete(deletedId);
  const [nextProjectSummary] = await projectStore.list();
  const nextProject = nextProjectSummary
    ? await projectStore.get(nextProjectSummary.id)
    : await projectStore.create("画布", seededDocument());
  if (!nextProject) {
    showToast("画布删除后恢复失败", "error");
    return;
  }
  await projectStore.setActive(nextProject.id);
  activeProject = nextProject;
  await board.document.load(nextProject.document, { replaceHistory: true });
  await refreshModelPreviews(board);
  board.selection.clear();
  board.viewport.fitBounds(padBounds(computeContentBounds(board), 80));
  document.querySelector<HTMLSpanElement>("[data-project-current]")!.textContent = nextProject.name;
  showToast(`已删除 ${deletedName}`, "success");
}

async function deleteProject(board: PixiBoard, projectId: string): Promise<void> {
  const project = await projectStore.get(projectId);
  if (!project) return;
  if (projectId === activeProject?.id) {
    await deleteActiveProject(board);
  } else {
    await projectStore.delete(projectId, true);
    showToast(`已删除 ${project.name}`, "success");
  }
}

function wirePointerInteractions(
  board: PixiBoard,
  transformer: DomTransformer,
  resyncMediaBadges: () => void,
  panModifier: { isSpacePanning(): boolean; setSpacePanning(value: boolean): void },
): void {
  let mode: "idle" | "select" | "drag-node" | "pan" = "idle";
  // Every selected node moves, so the drag carries one origin per node instead
  // of a single handle. Origins are accumulated in world units to keep the drag
  // exact under fractional zoom.
  let dragOrigins: Array<{ id: string; x: number; y: number }> = [];
  let lastScreen = { x: 0, y: 0 };
  let selectStart = { x: 0, y: 0 };
  let lastTapNodeId: string | undefined;
  let lastTapTime = 0;
  // Pressing an already-selected node must keep the group intact so the whole
  // group can be dragged; the collapse to a single node happens on release only
  // if the pointer never actually moved.
  let collapseToOnRelease: string | undefined;
  let movedDuringDrag = false;
  // One key per gesture, shared by every frame of that drag, so the whole
  // move collapses into a single undo step instead of one per frame.
  let dragCoalesceKey: string | undefined;
  let dragSequence = 0;
  let panMoved = false;

  const isOverlayPanTarget = (target: EventTarget | null): target is Element => {
    return target instanceof Element && Boolean(target.closest("#selection-actions, .pixiboard-handle, .inline-media-audio"));
  };

  const isInsideHost = (event: PointerEvent): boolean => {
    const rect = host.getBoundingClientRect();
    return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
  };

  const beginPan = (event: PointerEvent, capture: boolean) => {
    event.preventDefault();
    board.focus();
    if (capture) {
      try {
        host.setPointerCapture(event.pointerId);
      } catch {
        // Forwarded overlay gestures are still tracked by the window listeners.
      }
    }
    lastScreen = toHostPoint(event);
    mode = "pan";
    panMoved = false;
  };

  const beginNodeDrag = () => {
    dragOrigins = board.selection
      .get()
      .map((id) => board.nodes.get(id))
      .filter((item): item is NonNullable<typeof item> => item !== undefined)
      .map((item) => ({ id: item.id, x: item.x, y: item.y }));
    mode = dragOrigins.length > 0 ? "drag-node" : "idle";
    dragCoalesceKey = `move:${++dragSequence}`;
  };

  document.addEventListener("pointerdown", (event) => {
    if (mode !== "idle" || !isOverlayPanTarget(event.target) || !isInsideHost(event)) return;
    const wantsPan = event.button === 1 || event.button === 2 || (event.button === 0 && panModifier.isSpacePanning());
    if (!wantsPan) return;
    beginPan(event, false);
    event.stopImmediatePropagation();
  }, { capture: true });

  host.addEventListener("pointerdown", (event) => {
    const wantsPan = event.button === 1 || event.button === 2 || (event.button === 0 && panModifier.isSpacePanning());
    if (wantsPan) {
      beginPan(event, true);
      return;
    }
    if (event.button !== 0) return;
    // The handles stop propagation before this fires, so a resize normally
    // never reaches the canvas at all; this only guards a gesture already in
    // flight (a second pointer, or a synthetic event) from also starting a
    // marquee underneath it.
    if (transformer.dragging()) return;
    board.focus();
    host.setPointerCapture(event.pointerId);
    const screenPoint = toHostPoint(event);
    const worldPoint = board.viewport.toWorld(screenPoint);
    const hitId = hitTestTopmost(board, worldPoint);
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    lastScreen = screenPoint;
    collapseToOnRelease = undefined;
    movedDuringDrag = false;

    if (hitId) {
      const now = performance.now();
      if (!additive && hitId === lastTapNodeId && now - lastTapTime < 320) {
        if (board.nodes.get(hitId)?.type === "text") {
          // Let the second click finish before focusing the textarea. Starting
          // the editor inside pointerdown lets the click's default focus action
          // immediately blur and remove it again.
          if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
          event.preventDefault();
          window.requestAnimationFrame(() => beginTextEdit(board, hitId));
        } else {
          if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
          event.preventDefault();
          window.requestAnimationFrame(() => beginNodeRename(board, hitId, resyncMediaBadges));
        }
        lastTapNodeId = undefined;
        return;
      }
      lastTapNodeId = hitId;
      lastTapTime = now;

      if (additive) {
        board.selection.toggle(hitId);
      } else if (!board.selection.get().includes(hitId)) {
        board.selection.set([hitId]);
      } else if (board.selection.get().length > 1) {
        collapseToOnRelease = hitId;
      }
      beginNodeDrag();
    } else {
      lastTapNodeId = undefined;
      if (!additive) board.selection.clear();
      mode = "select";
      selectStart = screenPoint;
      showSelectionBox(selectStart, selectStart);
    }
  });

  window.addEventListener("pointermove", (event) => {
    if (mode === "idle") return;
    const screenPoint = toHostPoint(event);
    const deltaScreen = { x: screenPoint.x - lastScreen.x, y: screenPoint.y - lastScreen.y };
    lastScreen = screenPoint;

    if (mode === "pan") {
      if (deltaScreen.x !== 0 || deltaScreen.y !== 0) panMoved = true;
      board.viewport.panBy(deltaScreen.x, deltaScreen.y);
    } else if (mode === "select") {
      showSelectionBox(selectStart, screenPoint);
    } else if (mode === "drag-node" && dragOrigins.length > 0) {
      if (deltaScreen.x !== 0 || deltaScreen.y !== 0) movedDuringDrag = true;
      const scale = board.viewport.get().scale;
      const deltaWorld = { x: deltaScreen.x / scale, y: deltaScreen.y / scale };
      for (const origin of dragOrigins) {
        origin.x += deltaWorld.x;
        origin.y += deltaWorld.y;
      }
      // One transaction per frame keeps the whole group on a single render
      // pass; the shared coalesceKey folds every frame of the gesture into one
      // undo step.
      board.transaction("Move selection", () => {
        for (const origin of dragOrigins) {
          board.nodes.update(origin.id, { x: origin.x, y: origin.y });
        }
      }, { origin: "ui", ...(dragCoalesceKey ? { coalesceKey: dragCoalesceKey } : {}) });
    }
  });

  const endDrag = (event: PointerEvent) => {
    if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
    if (mode === "pan") {
      if (event.button === 2 && panMoved) host.dataset.suppressContextMenu = "true";
    } else if (mode === "select") {
      const marqueeIds = nodesInScreenRect(board, selectStart, lastScreen);
      const additive = event.shiftKey || event.metaKey || event.ctrlKey;
      const ids = additive ? [...new Set([...board.selection.get(), ...marqueeIds])] : marqueeIds;
      board.selection.set(ids);
      hideSelectionBox();
    } else if (mode === "drag-node" && collapseToOnRelease && !movedDuringDrag) {
      board.selection.set([collapseToOnRelease]);
    }
    mode = "idle";
    dragOrigins = [];
    collapseToOnRelease = undefined;
    movedDuringDrag = false;
    dragCoalesceKey = undefined;
    panMoved = false;
  };
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);

  host.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const screenPoint = toHostPoint(event);
      if (event.ctrlKey || event.metaKey) {
        // Trackpad pinch synthesizes a wheel event with ctrlKey=true; explicit
        // Ctrl/Cmd + wheel follows the same zoom-at-pointer convention.
        const factor = Math.exp(-event.deltaY * 0.01);
        board.viewport.zoomAt(screenPoint, factor);
      } else {
        // Plain wheel scroll and two-finger trackpad pan both land here.
        board.viewport.panBy(-event.deltaX, -event.deltaY);
      }
    },
    { passive: false },
  );

  window.addEventListener("keydown", (event) => {
    if (isTypingTarget(event.target)) return;
    if (event.code === "Space") {
      event.preventDefault();
      panModifier.setSpacePanning(true);
      host.classList.add("is-space-panning");
    }
  });
  window.addEventListener("keyup", (event) => {
    if (event.code === "Space") {
      panModifier.setSpacePanning(false);
      host.classList.remove("is-space-panning");
    }
  });
  window.addEventListener("blur", () => {
    panModifier.setSpacePanning(false);
    host.classList.remove("is-space-panning");
  });
}

function showSelectionBox(start: { x: number; y: number }, end: { x: number; y: number }): void {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);
  selectionBox.style.left = `${left}px`;
  selectionBox.style.top = `${top}px`;
  selectionBox.style.width = `${width}px`;
  selectionBox.style.height = `${height}px`;
  selectionBox.hidden = false;
}

function hideSelectionBox(): void {
  selectionBox.hidden = true;
}

function nodesInScreenRect(board: PixiBoard, start: { x: number; y: number }, end: { x: number; y: number }): string[] {
  const worldStart = board.viewport.toWorld(start);
  const worldEnd = board.viewport.toWorld(end);
  const minX = Math.min(worldStart.x, worldEnd.x);
  const minY = Math.min(worldStart.y, worldEnd.y);
  const maxX = Math.max(worldStart.x, worldEnd.x);
  const maxY = Math.max(worldStart.y, worldEnd.y);
  return board
    .find()
    .filter((item) => item.x < maxX && item.x + item.width > minX && item.y < maxY && item.y + item.height > minY)
    .map((item) => item.id);
}

function handleKeyboard(event: KeyboardEvent): void {
  if (isTypingTarget(event.target)) return;
  const boardInstance = activeBoard;
  if (!boardInstance) return;
  const meta = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();

  if (meta && key === "z") {
    event.preventDefault();
    if (event.shiftKey) boardInstance.history.redo();
    else boardInstance.history.undo();
    return;
  }
  if (meta && key === "y") {
    event.preventDefault();
    boardInstance.history.redo();
    return;
  }
  if (meta && key === "d" && !event.shiftKey) {
    event.preventDefault();
    duplicateSelection(boardInstance);
    return;
  }
  if (meta && event.key === "0") {
    event.preventDefault();
    resetZoom(boardInstance);
    return;
  }
  if (meta && (event.key === "=" || event.key === "+")) {
    event.preventDefault();
    zoomAtCenter(boardInstance, 1.18);
    return;
  }
  if (meta && event.key === "-") {
    event.preventDefault();
    zoomAtCenter(boardInstance, 1 / 1.18);
    return;
  }
  if (event.key === "Home") {
    event.preventDefault();
    boardInstance.viewport.fitBounds(padBounds(computeContentBounds(boardInstance), 80));
    return;
  }
  const nudgeStep = event.shiftKey ? ARROW_KEY_STEP_LARGE : ARROW_KEY_STEP;
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    nudgeSelection(boardInstance, -nudgeStep, 0);
    return;
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    nudgeSelection(boardInstance, nudgeStep, 0);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    nudgeSelection(boardInstance, 0, -nudgeStep);
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    nudgeSelection(boardInstance, 0, nudgeStep);
    return;
  }
  if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    deleteSelection(boardInstance);
  }
}

function textNodeHeight(props: TextProps, width: number): number {
  const fontSize = typeof props.style?.fontSize === "number" ? props.style.fontSize : 16;
  const lineHeight = typeof props.style?.lineHeight === "number"
    ? props.style.lineHeight
    : fontSize * 1.25;
  const text = props.text || " ";
  const context = textMeasurementContext();
  if (context) context.font = canvasFont(props.style, fontSize);
  const letterSpacing = typeof props.style?.letterSpacing === "number" ? props.style.letterSpacing : 0;
  const lineCount = text.split(/\r?\n/).reduce((count, line) => {
    let lines = 1;
    let occupied = 0;
    for (const character of Array.from(line)) {
      // Measuring one glyph at a time is intentionally conservative: it does
      // not subtract negative kerning pairs, so the resulting node may be a
      // little taller but cannot leave rendered Pixi text outside hit bounds.
      const measured = context?.measureText(character).width;
      const measuredWidth = typeof measured === "number" && Number.isFinite(measured) ? measured : fontSize;
      const advance = Math.max(measuredWidth + letterSpacing, fontSize * 0.25);
      if (occupied > 0 && occupied + advance > Math.max(width, 1)) {
        lines += 1;
        occupied = advance;
      } else {
        occupied += advance;
      }
    }
    return count + lines;
  }, 0);
  return Math.max(lineHeight, Math.ceil(lineCount * lineHeight));
}

let measurementContext: CanvasRenderingContext2D | null | undefined;

function textMeasurementContext(): CanvasRenderingContext2D | undefined {
  if (measurementContext === undefined) {
    measurementContext = document.createElement("canvas").getContext("2d");
  }
  return measurementContext ?? undefined;
}

function canvasFont(style: TextProps["style"], fontSize: number): string {
  const fontStyle = textFontStyle(style);
  const fontWeight = textFontWeight(style);
  const fontFamily = textFontFamily(style);
  return `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
}

function textFontStyle(style: TextProps["style"]): string {
  return typeof style?.fontStyle === "string" ? style.fontStyle : "normal";
}

function textFontWeight(style: TextProps["style"]): string | number {
  return typeof style?.fontWeight === "string" || typeof style?.fontWeight === "number" ? style.fontWeight : "normal";
}

function textFontFamily(style: TextProps["style"]): string {
  return typeof style?.fontFamily === "string" ? style.fontFamily : "Arial, sans-serif";
}

function textCssColor(style: TextProps["style"]): string {
  const fill = style?.fill;
  if (typeof fill === "string") return fill;
  if (typeof fill === "number" && Number.isFinite(fill)) return `#${Math.max(0, Math.round(fill)).toString(16).padStart(6, "0")}`;
  return "#e8edf4";
}

function textLineHeight(style: TextProps["style"], fontSize: number): number {
  return typeof style?.lineHeight === "number" ? style.lineHeight : fontSize * 1.25;
}

function beginTextEdit(board: PixiBoard, nodeId: string): void {
  const node = board.nodes.get<TextProps>(nodeId);
  if (!node || node.type !== "text") return;

  const existing = textEditorOverlay.querySelector<HTMLTextAreaElement>("textarea[data-node-id]");
  existing?.blur();

  const editor = document.createElement("textarea");
  editor.dataset.nodeId = nodeId;
  editor.className = "text-node-editor";
  editor.value = node.props.text;
  editor.wrap = "soft";
  editor.spellcheck = false;
  editor.setAttribute("aria-label", "编辑文字节点");
  editor.style.width = `${Math.max(80, board.viewport.get().scale * node.width)}px`;
  editor.style.height = `${Math.max(1, board.viewport.get().scale * node.height)}px`;

  const place = () => {
    const current = board.nodes.get<TextProps>(nodeId);
    if (!current) return;
    const screen = board.viewport.toScreen({ x: current.x, y: current.y });
    const scale = board.viewport.get().scale;
    editor.style.left = `${screen.x}px`;
    editor.style.top = `${screen.y}px`;
    editor.style.width = `${Math.max(80, scale * current.width)}px`;
    const minHeight = Math.max(1, scale * current.height);
    editor.style.minHeight = `${minHeight}px`;
    editor.style.height = `${minHeight}px`;
    const fontSize = Number(current.props.style?.fontSize ?? 16);
    const scaledFontSize = Math.max(1, scale * fontSize);
    editor.style.fontSize = `${scaledFontSize}px`;
    editor.style.fontFamily = textFontFamily(current.props.style);
    editor.style.fontStyle = textFontStyle(current.props.style);
    editor.style.fontWeight = String(textFontWeight(current.props.style));
    editor.style.color = textCssColor(current.props.style);
    editor.style.lineHeight = `${Math.max(1, scale * textLineHeight(current.props.style, fontSize))}px`;
    window.requestAnimationFrame(() => {
      if (!editor.isConnected) return;
      editor.style.height = "0";
      editor.style.height = `${Math.max(scale * current.height, editor.scrollHeight)}px`;
    });
  };

  let cancelled = false;
  const finish = (save: boolean) => {
    if (editor.dataset.done === "true") return;
    editor.dataset.done = "true";
    if (save && !cancelled) {
      const current = board.nodes.get<TextProps>(nodeId);
      const text = editor.value.replace(/\r\n/g, "\n");
      if (current && text !== current.props.text) {
        const height = textNodeHeight({ ...current.props, text }, current.width);
        board.transaction("Edit text", () => {
          board.nodes.update<TextProps>(nodeId, { height, props: { ...current.props, text } });
        }, { origin: "ui" });
      }
    }
    editor.remove();
    board.focus();
  };

  editor.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelled = true;
      finish(false);
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      finish(true);
    }
  });
  editor.addEventListener("blur", () => finish(true));
  editor.addEventListener("input", () => {
    const current = board.nodes.get<TextProps>(nodeId);
    const minHeight = current ? Math.max(1, board.viewport.get().scale * current.height) : 1;
    editor.style.minHeight = `${minHeight}px`;
    editor.style.height = "0";
    editor.style.height = `${Math.max(minHeight, editor.scrollHeight)}px`;
  });
  editor.addEventListener("pointerdown", (event) => event.stopPropagation());
  editor.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
  textEditorOverlay.appendChild(editor);
  place();
  const updatePosition = () => place();
  const disposeViewport = board.on("viewport:change", updatePosition);
  const disposeChange = board.on("change", updatePosition);
  const originalRemove = editor.remove.bind(editor);
  editor.remove = () => {
    disposeViewport();
    disposeChange();
    originalRemove();
  };
  editor.focus();
  editor.select();
}

function hitTestTopmost(board: PixiBoard, worldPoint: { x: number; y: number }): string | undefined {
  const candidates = board.find().map((node, index) => ({ node, index }))
    .filter(({ node }) => {
      if (node.visible === false) return false;
      // Inverse node rotation: hit the actual rectangle, not its axis-aligned box.
      const dx = worldPoint.x - node.x, dy = worldPoint.y - node.y;
      const cos = Math.cos(node.rotation), sin = Math.sin(node.rotation);
      const x = dx * cos + dy * sin, y = -dx * sin + dy * cos;
      return x >= 0 && x <= node.width && y >= 0 && y <= node.height;
    })
    .sort((a, b) => b.node.zIndex - a.node.zIndex || b.index - a.index);
  return candidates[0]?.node.id;
}

function toHostPoint(event: MouseEvent | PointerEvent | WheelEvent): { x: number; y: number } {
  const rect = host.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function wireStatus(board: PixiBoard): void {
  const refreshScale = () => {
    hudScale.textContent = `${Math.round(board.viewport.get().scale * 100)}%`;
  };
  board.on("selection:change", (event) => {
    statusText.textContent = event.nodeIds.length > 0 ? `已选中 ${event.nodeIds.length} 个节点` : "已就绪";
  });
  board.on("viewport:change", refreshScale);
  refreshScale();
}

main()
  .then(() => undefined)
  .catch((error) => {
    host.innerHTML = `<div class="boot-error">Demo failed to start: ${String(error)}</div>`;
    console.error(error);
  });
