import {
  BrowserPersistenceAdapter,
  NativeIndexedDbPort,
  NativeObjectUrlPort,
  NativeOpfsPort,
} from "@pixi-board/adapter-browser";
import type { AssetRecord, AssetVariant, BoardDocument, PreviewSpec } from "@pixi-board/core";
import { renderModelPreview } from "./modelPreviewScene";
import { documentPreviewImport, classifyPreviewFile, hasSitePreviewRenderer, type PreviewImportState } from "./preview";

export type MediaKind = "image" | "video" | "audio" | "model" | "html" | "markdown" | "text-file" | "file";
export type ModelVertex = [number, number, number];

/** Storage variants this demo writes; mirrors the core `AssetRef["variant"]`. */
export type { AssetVariant } from "@pixi-board/core";

export type MediaImport = PreviewImportState & {
  assetId: string;
  kind: MediaKind;
  name: string;
  mimeType: string;
  size: number;
  duration?: number;
  /** Intrinsic media size, already clamped to a sane on-canvas footprint. */
  width: number;
  height: number;
  /** Whether a downscaled "preview" derivative was stored for this asset. */
  hasPreview?: boolean;
};

/** Longest edge a freshly imported node is allowed to occupy in world units. */
const MAX_NODE_EDGE = 320;
const AUDIO_NODE_WIDTH = 320;
const AUDIO_NODE_HEIGHT = 96;
const WAVEFORM_BARS = 96;
const DOCUMENT_NODE_WIDTH = 320;
const DOCUMENT_NODE_HEIGHT = 220;
const MODEL_NODE_WIDTH = 320;
const MODEL_NODE_HEIGHT = 240;
/**
 * Longest edge, in device pixels, a generated image preview is allowed to
 * occupy. Nodes cap out at MAX_NODE_EDGE=320 world units and the demo
 * renders at up to 2x device pixel ratio, so ~640px covers 100% zoom; 1600px
 * leaves headroom for the user zooming in further while still cutting a
 * typical multi-megapixel photo down by 80%+ before it becomes a texture.
 */
const MAX_PREVIEW_EDGE = 1600;
const PREVIEW_MIME_TYPE = "image/webp";
const PREVIEW_QUALITY = 0.88;

export class UnsupportedMediaError extends Error {
  constructor(readonly fileName: string, readonly mimeType: string) {
    super(`不支持的文件类型: ${fileName || mimeType || "unknown"}`);
    this.name = "UnsupportedMediaError";
  }
}

export function classifyMedia(file: File): MediaKind | undefined {
  const type = (file.type || "").toLowerCase();
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg"].includes(extension)) return "image";
  if (["mp4", "webm", "mov", "m4v", "ogv"].includes(extension)) return "video";
  if (["mp3", "wav", "ogg", "oga", "m4a", "flac", "aac"].includes(extension)) return "audio";
  if (["glb", "gltf", "obj", "fbx", "stl", "ply", "dae", "3mf", "3ds", "vrml", "wrl", "step", "stp"].includes(extension)) return "model";
  if (["html", "htm"].includes(extension)) return "html";
  if (["md", "markdown"].includes(extension)) return "markdown";
  if (["txt", "log", "csv", "json", "xml", "yaml", "yml"].includes(extension)) return "text-file";

  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type === "text/html") return "html";
  if (["text/markdown", "text/x-markdown"].includes(type)) return "markdown";
  if (type.startsWith("text/")) return "text-file";
  return "file";
}

/**
 * Owns every browser-side media concern for the demo: durable storage of the
 * uploaded bytes, generation of the derived artwork that the canvas actually
 * draws (video poster frame, audio waveform), and the object-URL leases the
 * renderer needs to turn an asset reference into a texture.
 */
export class MediaLibrary {
  private readonly adapter: BrowserPersistenceAdapter;
  /** Object URLs are revoked wholesale on dispose, so leases are tracked here. */
  private readonly leases = new Map<string, { url: string; revoke: () => void }>();
  private readonly opfsSupported: boolean;

  constructor() {
    this.opfsSupported = typeof navigator?.storage?.getDirectory === "function";
    this.adapter = new BrowserPersistenceAdapter({
      indexedDb: new NativeIndexedDbPort({ databaseName: "pixiboardjs-demo" }),
      // OPFS is optional: without it every binary simply falls back to
      // IndexedDB, which the adapter already handles.
      ...(this.opfsSupported ? { opfs: new NativeOpfsPort({ directoryName: "pixiboardjs-demo-assets" }) } : {}),
      objectUrls: new NativeObjectUrlPort(),
    });
  }

  async loadDocument(): Promise<BoardDocument | undefined> {
    const record = await this.adapter.loadDocument();
    return record?.snapshot;
  }

  async saveDocument(snapshot: BoardDocument): Promise<void> {
    await this.adapter.saveDocument({ snapshot });
  }

  /**
   * Stores the original bytes plus, for video and audio, a derived still image
   * that the canvas can render as a texture. Derivation happens before the
   * caller creates a node so a node is never left pointing at a missing
   * variant.
   */
  async importFile(file: File): Promise<MediaImport> {
    const kind = await classifyPreviewFile(file, classifyMedia(file));
    if (!kind) throw new UnsupportedMediaError(file.name, file.type);

    const assetId = `asset-${crypto.randomUUID()}`;
    const record: AssetRecord = {
      id: assetId,
      kind,
      metadata: {
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        relativePath: file.webkitRelativePath || file.name,
      },
    };

    await this.adapter.putAsset(record, file);

    if (kind === "image") {
      const preview = await imagePreview(file);
      if (preview.previewBlob) {
        await this.adapter.putDerivative(assetId, "preview", preview.previewBlob);
      }
      return {
        assetId,
        kind,
        name: file.name,
        mimeType: file.type,
        size: file.size,
        hasPreview: preview.previewBlob !== undefined,
        ...fitNode(preview.width, preview.height),
      };
    }

    if (kind === "video") {
      const poster = await videoPoster(file);
      await this.adapter.putDerivative(assetId, "preview", poster.blob);
      return { assetId, kind, name: file.name, mimeType: file.type, size: file.size, duration: poster.duration, ...fitNode(poster.width, poster.height) };
    }

    if (kind === "audio") {
      const waveform = await audioWaveform(file);
      await this.adapter.putDerivative(assetId, "waveform", waveform.blob);
      return {
        assetId,
        kind,
        name: file.name,
        mimeType: file.type,
        size: file.size,
        duration: waveform.duration,
        width: AUDIO_NODE_WIDTH,
        height: AUDIO_NODE_HEIGHT,
      };
    }

    let state = documentPreviewImport(file, kind);
    let preview: Blob;
    if (kind === "model" && !hasSitePreviewRenderer()) {
      try {
        preview = await modelPreview(file, state.previewSpec);
        state = { ...state, previewStatus: "ready", previewQuality: "thumbnail", previewError: null };
      } catch (error) {
        state = { ...state, previewStatus: "error", previewError: error instanceof Error ? error.message : String(error) };
        preview = await filePreview(file, kind);
      }
    } else {
      preview = await filePreview(file, kind);
    }
    await this.adapter.putDerivative(assetId, "preview", preview);
    return {
      assetId,
      kind,
      name: file.name,
      mimeType: file.type,
      size: file.size,
      width: kind === "model" ? MODEL_NODE_WIDTH : DOCUMENT_NODE_WIDTH,
      height: kind === "model" ? MODEL_NODE_HEIGHT : DOCUMENT_NODE_HEIGHT,
      hasPreview: true,
      ...state,
    };
  }

  /**
   * Leases a URL for one stored variant. The variant is taken from the asset
   * reference itself rather than inferred from the owning node, so this stays
   * correct during the very first render pass, before the board is reachable.
   */
  async objectUrl(assetId: string, variant: AssetVariant = "original"): Promise<string | undefined> {
    const cacheKey = `${assetId}:${variant}`;
    const cached = this.leases.get(cacheKey);
    if (cached) return cached.url;

    try {
      const lease = await this.adapter.leaseObjectUrl(assetId, { variant });
      this.leases.set(cacheKey, { url: lease.url, revoke: () => lease.revoke() });
      return lease.url;
    } catch {
      // A missing asset must not take down the whole render pass; the node
      // simply stays a placeholder.
      return undefined;
    }
  }

  async downloadUrl(assetId: string): Promise<string | undefined> {
    return this.objectUrl(assetId, "original");
  }

  async originalBlob(assetId: string): Promise<Blob | undefined> {
    const stored = await this.adapter.getAsset(assetId, { variant: "original" });
    return stored?.blob;
  }

  async originalText(assetId: string): Promise<string | undefined> {
    const blob = await this.originalBlob(assetId);
    return blob?.text();
  }

  async assetIds(): Promise<string[]> {
    const entries = await this.adapter.listAssets();
    return entries.map((entry) => entry.id);
  }

  async deleteAsset(assetId: string): Promise<void> {
    for (const key of [...this.leases.keys()]) {
      if (key.startsWith(`${assetId}:`)) this.revokeLease(assetId, key.slice(assetId.length + 1) as AssetVariant);
    }
    await this.adapter.deleteAsset(assetId);
  }

  async refreshPreview(assetId: string, kind: MediaKind, spec?: PreviewSpec, isCurrent: () => boolean = () => true): Promise<boolean | AssetVariant> {
    const stored = await this.adapter.getAsset(assetId, { variant: "original" });
    if (!stored) return false;

    const metadata = stored.entry.record.metadata ?? {};
    const name = typeof metadata.name === "string" ? metadata.name : `${kind}-${assetId}`;
    const type = typeof metadata.mimeType === "string" ? metadata.mimeType : stored.blob.type;
    const file = new File([stored.blob], name, { type });

    if (kind === "image") {
      const preview = await imagePreview(file);
      if (!preview.previewBlob) return false;
      await this.adapter.putDerivative(assetId, "preview", preview.previewBlob);
      this.revokeLease(assetId, "preview");
      return true;
    }

    if (kind === "video") {
      const poster = await videoPoster(file);
      await this.adapter.putDerivative(assetId, "preview", poster.blob);
      this.revokeLease(assetId, "preview");
      return true;
    }

    if (kind === "audio") {
      const waveform = await audioWaveform(file);
      await this.adapter.putDerivative(assetId, "waveform", waveform.blob);
      this.revokeLease(assetId, "waveform");
      return true;
    }

    const preview = kind === "model" ? await modelPreview(file, spec) : await filePreview(file, kind);
    if (!isCurrent()) return false;
    // Each requesting node retains its own result; another copy may have a
    // different aspect ratio while still referencing the same original asset.
    const digest = await crypto.subtle.digest("SHA-256", await preview.arrayBuffer());
    const variant: AssetVariant = `preview-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    if (!isCurrent()) return false;
    await this.adapter.putDerivative(assetId, variant, preview);
    return isCurrent() ? variant : false;
  }

  async updateVideoPreviewFromElement(assetId: string, video: HTMLVideoElement): Promise<boolean> {
    if (!video.videoWidth || !video.videoHeight) return false;

    const { width, height } = previewSize(video.videoWidth, video.videoHeight);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return false;

    context.drawImage(video, 0, 0, width, height);
    await this.adapter.putDerivative(assetId, "preview", await canvasBlob(canvas));
    this.revokeLease(assetId, "preview");
    return true;
  }

  async clear(): Promise<void> {
    for (const lease of this.leases.values()) lease.revoke();
    this.leases.clear();
    const entries = await this.adapter.listAssets();
    for (const entry of entries) await this.adapter.deleteAsset(entry.id);
    await this.adapter.saveDocument({
      snapshot: { schemaVersion: 1, revision: 0, nodes: [], assets: [] },
    });
  }

  async dispose(): Promise<void> {
    for (const lease of this.leases.values()) lease.revoke();
    this.leases.clear();
    await this.adapter.destroy();
  }

  private revokeLease(assetId: string, variant: AssetVariant): void {
    const key = `${assetId}:${variant}`;
    const lease = this.leases.get(key);
    if (!lease) return;
    lease.revoke();
    this.leases.delete(key);
  }
}

/** Scales intrinsic media dimensions down to a reasonable canvas footprint. */
function fitNode(width: number, height: number): { width: number; height: number } {
  const safeWidth = width > 0 ? width : MAX_NODE_EDGE;
  const safeHeight = height > 0 ? height : MAX_NODE_EDGE;
  const scale = Math.min(MAX_NODE_EDGE / safeWidth, MAX_NODE_EDGE / safeHeight, 1);
  return { width: Math.round(safeWidth * scale), height: Math.round(safeHeight * scale) };
}

async function imageSize(file: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close?.();
      return size;
    } catch {
      // SVG and a few exotic encodings reject bitmap decoding; fall through.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("图片解码失败"));
      image.src = url;
    });
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Downscales an oversized photo into a canvas-sized preview so a multi
 * megapixel original never ends up as the GPU texture behind a node that
 * only ever renders at a few hundred pixels on screen. Vector art (SVG) is
 * exempt — it's already resolution-independent and typically tiny, so
 * rasterizing it down would only cost quality for no size win — and an
 * image already at or under the preview cap is returned as-is, since
 * there's nothing worth trimming.
 */
async function imagePreview(file: File): Promise<{ width: number; height: number; previewBlob?: Blob }> {
  const size = await imageSize(file);
  if (file.type === "image/svg+xml" || (size.width <= MAX_PREVIEW_EDGE && size.height <= MAX_PREVIEW_EDGE)) {
    return size;
  }
  try {
    const previewBlob = await renderImagePreview(file, size);
    return { ...size, previewBlob };
  } catch (error) {
    // A failed downscale must not block the import — the canvas still has
    // the original bytes to fall back to.
    console.warn("Failed to generate an image preview", error);
    return size;
  }
}

function previewSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(MAX_PREVIEW_EDGE / width, MAX_PREVIEW_EDGE / height, 1);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function renderImagePreview(file: File, intrinsicSize: { width: number; height: number }): Promise<Blob> {
  const { width, height } = previewSize(intrinsicSize.width, intrinsicSize.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建画布上下文");

  if (typeof createImageBitmap === "function") {
    // resizeWidth/resizeHeight lets the browser's own decoder downsample
    // while decoding, which beats decoding at full resolution and then
    // scaling in a 2D context both for speed and for quality.
    const bitmap = await createImageBitmap(file, { resizeWidth: width, resizeHeight: height, resizeQuality: "high" });
    try {
      context.drawImage(bitmap, 0, 0, width, height);
    } finally {
      bitmap.close?.();
    }
  } else {
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("图片解码失败"));
        image.src = url;
      });
      context.drawImage(image, 0, 0, width, height);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return canvasBlob(canvas, PREVIEW_MIME_TYPE, PREVIEW_QUALITY);
}

/**
 * Seeks a hidden video element just past the start and copies that frame into a
 * canvas. Seeking off zero avoids the black leader frame some encoders emit.
 */
async function videoPoster(file: Blob): Promise<{ blob: Blob; width: number; height: number; duration?: number }> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error("视频解码失败"));
      }),
      8000,
      "视频加载超时",
    );
    const seekTarget = Number.isFinite(video.duration) && video.duration > 0.1 ? Math.min(0.1, video.duration / 2) : 0;
    await withTimeout(
      new Promise<void>((resolve) => {
        video.onseeked = () => resolve();
        try {
          video.currentTime = seekTarget;
        } catch {
          resolve();
        }
      }),
      4000,
      "视频取帧超时",
    ).catch(() => undefined);

    const width = video.videoWidth || 320;
    const height = video.videoHeight || 180;
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : undefined;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建画布上下文");
    context.drawImage(video, 0, 0, width, height);
    const blob = await canvasBlob(canvas);
    return { blob, width, height, duration };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

/**
 * Decodes the real samples and renders a symmetric peak-per-bucket waveform, so
 * the drawing reflects the actual audio rather than a decorative placeholder.
 */
async function audioWaveform(file: Blob): Promise<{ blob: Blob; duration?: number }> {
  const canvas = document.createElement("canvas");
  canvas.width = AUDIO_NODE_WIDTH * 2;
  canvas.height = AUDIO_NODE_HEIGHT * 2;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建画布上下文");

  context.fillStyle = "#161c25";
  context.fillRect(0, 0, canvas.width, canvas.height);

  let peaks: number[] = [];
  let duration: number | undefined;
  const AudioContextCtor: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (AudioContextCtor) {
    const audioContext = new AudioContextCtor();
    try {
      const decoded = await audioContext.decodeAudioData(await file.arrayBuffer());
      duration = Number.isFinite(decoded.duration) && decoded.duration > 0 ? decoded.duration : undefined;
      const samples = decoded.getChannelData(0);
      const bucket = Math.max(1, Math.floor(samples.length / WAVEFORM_BARS));
      for (let index = 0; index < WAVEFORM_BARS; index += 1) {
        let peak = 0;
        const start = index * bucket;
        for (let offset = 0; offset < bucket && start + offset < samples.length; offset += 1) {
          peak = Math.max(peak, Math.abs(samples[start + offset]));
        }
        peaks.push(peak);
      }
    } catch {
      peaks = [];
    } finally {
      await audioContext.close().catch(() => undefined);
    }
  }

  const midY = canvas.height / 2;
  if (peaks.length === 0) {
    // Undecodable audio still gets a node, marked by a flat baseline.
    context.strokeStyle = "#667487";
    context.lineWidth = 3;
    context.beginPath();
    context.moveTo(0, midY);
    context.lineTo(canvas.width, midY);
    context.stroke();
  } else {
    const barWidth = canvas.width / peaks.length;
    context.fillStyle = "#52d68e";
    for (const [index, peak] of peaks.entries()) {
      const barHeight = Math.max(2, peak * (canvas.height - 12));
      context.fillRect(index * barWidth + barWidth * 0.2, midY - barHeight / 2, barWidth * 0.6, barHeight);
    }
  }
  return { blob: await canvasBlob(canvas), duration };
}

async function modelPreview(file: File, spec?: Partial<PreviewSpec>): Promise<Blob> {
  return withTimeout(renderModelPreview(file, spec), 20_000, "模型预览超时，暂无预览，原文件已保存。");
}

export async function modelVertices(file: File, extension: string): Promise<ModelVertex[]> {
  if (["obj", "ply", "stl"].includes(extension)) {
    const head = await file.slice(0, Math.min(file.size, 2_000_000)).text();
    if (extension === "obj") return parseObjVertices(head);
    if (extension === "ply") return parsePlyVertices(head);
    if (extension === "stl") {
      const ascii = head.trimStart().startsWith("solid") ? parseAsciiStlVertices(head) : [];
      return ascii.length ? ascii : parseBinaryStlVertices(await file.arrayBuffer());
    }
  }
  return [];
}

function parseObjVertices(text: string): ModelVertex[] {
  const vertices: ModelVertex[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("v ")) continue;
    const [, x, y, z] = line.trim().split(/\s+/).map(Number);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) vertices.push([x, y, z]);
    if (vertices.length >= 5000) break;
  }
  return vertices;
}

function parseAsciiStlVertices(text: string): ModelVertex[] {
  const vertices: ModelVertex[] = [];
  for (const match of text.matchAll(/vertex\s+([-+\deE.]+)\s+([-+\deE.]+)\s+([-+\deE.]+)/g)) {
    const x = Number(match[1]);
    const y = Number(match[2]);
    const z = Number(match[3]);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) vertices.push([x, y, z]);
    if (vertices.length >= 5000) break;
  }
  return vertices;
}

function parseBinaryStlVertices(buffer: ArrayBuffer): ModelVertex[] {
  if (buffer.byteLength < 84) return [];
  const view = new DataView(buffer);
  const triangleCount = view.getUint32(80, true);
  const expectedBytes = 84 + triangleCount * 50;
  if (expectedBytes > buffer.byteLength) return [];
  const vertices: ModelVertex[] = [];
  const maxTriangles = Math.min(triangleCount, 1666);
  for (let triangle = 0; triangle < maxTriangles; triangle += 1) {
    const triangleOffset = 84 + triangle * 50 + 12;
    for (let point = 0; point < 3; point += 1) {
      const offset = triangleOffset + point * 12;
      const x = view.getFloat32(offset, true);
      const y = view.getFloat32(offset + 4, true);
      const z = view.getFloat32(offset + 8, true);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) vertices.push([x, y, z]);
    }
  }
  return vertices;
}

function parsePlyVertices(text: string): ModelVertex[] {
  const headerEnd = text.indexOf("end_header");
  if (headerEnd < 0) return [];
  const header = text.slice(0, headerEnd);
  const vertexCount = Number(header.match(/element\s+vertex\s+(\d+)/)?.[1] ?? 0);
  if (!vertexCount) return [];
  const body = text.slice(headerEnd + "end_header".length).trimStart().split(/\r?\n/);
  const vertices: ModelVertex[] = [];
  for (const line of body.slice(0, Math.min(vertexCount, 5000))) {
    const [x, y, z] = line.trim().split(/\s+/).map(Number);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) vertices.push([x, y, z]);
  }
  return vertices;
}

async function filePreview(file: File, kind: MediaKind): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = (kind === "model" ? MODEL_NODE_WIDTH : DOCUMENT_NODE_WIDTH) * 2;
  canvas.height = (kind === "model" ? MODEL_NODE_HEIGHT : DOCUMENT_NODE_HEIGHT) * 2;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建画布上下文");

  const width = canvas.width;
  const height = canvas.height;
  context.fillStyle = "#f7f8fb";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "#d8dee8";
  context.lineWidth = 2;
  roundedRect(context, 18, 18, width - 36, height - 36, 16);
  context.stroke();

  context.fillStyle = kindAccent(kind);
  roundedRect(context, 44, 44, 88, 88, 18);
  context.fill();
  context.fillStyle = "#ffffff";
  context.font = "700 46px Inter, Arial, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(kindGlyph(kind), 88, 88);

  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  context.fillStyle = "#111827";
  context.font = "700 28px Inter, Arial, sans-serif";
  drawClampedText(context, file.name || kindLabel(kind), 156, 76, width - 200);
  context.fillStyle = "#6b7280";
  context.font = "400 18px Inter, Arial, sans-serif";
  context.fillText(`${kindLabel(kind)} · ${formatBytes(file.size)}`, 156, 112);

  const snippet = ["html", "markdown", "text-file", "file"].includes(kind)
    ? "原文件已保存，可下载或交给 Agent 处理。"
    : await previewSnippet(file, kind);
  context.fillStyle = "#384152";
  context.font = "400 18px ui-monospace, SFMono-Regular, Menlo, monospace";
  const lines = wrapText(context, snippet, width - 92, kind === "model" ? 5 : 7);
  lines.forEach((line, index) => context.fillText(line, 46, 178 + index * 30));

  return canvasBlob(canvas);
}

async function previewSnippet(file: File, kind: MediaKind): Promise<string> {
  if (kind === "model") return "暂无预览。原始模型已保存，可下载后查看。";
  try {
    const text = await file.slice(0, 3200).text();
    return text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() || kindLabel(kind);
  } catch {
    return kindLabel(kind);
  }
}

function kindLabel(kind: MediaKind): string {
  return ({ image: "图片", video: "视频", audio: "音频", model: "模型", html: "HTML", markdown: "Markdown", "text-file": "文本", file: "文件" })[kind];
}

function kindGlyph(kind: MediaKind): string {
  return ({ image: "I", video: "V", audio: "A", model: "3D", html: "H", markdown: "M", "text-file": "T", file: "F" })[kind];
}

function kindAccent(kind: MediaKind): string {
  return ({ image: "#4f7cff", video: "#f05272", audio: "#1aa36f", model: "#8b5cf6", html: "#f97316", markdown: "#2563eb", "text-file": "#64748b", file: "#475569" })[kind];
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const power = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)));
  return `${(size / 1024 ** power).toFixed(power === 0 ? 0 : 1)} ${units[power]}`;
}

function drawClampedText(context: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number): void {
  if (context.measureText(text).width <= maxWidth) {
    context.fillText(text, x, y);
    return;
  }
  let clipped = text;
  while (clipped.length > 1 && context.measureText(`${clipped}...`).width > maxWidth) clipped = clipped.slice(0, -1);
  context.fillText(`${clipped}...`, x, y);
}

function wrapText(context: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (context.measureText(next).width <= maxWidth) {
      line = next;
    } else {
      if (line) lines.push(line);
      line = word;
    }
    if (lines.length >= maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === 0) lines.push(text.slice(0, 80));
  return lines;
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

async function canvasBlob(canvas: HTMLCanvasElement, mimeType = "image/png", quality?: number): Promise<Blob> {
  // Per spec, toBlob() falls back to image/png if the requested type isn't
  // supported, so no feature-detection is needed here.
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, quality));
  if (!blob) throw new Error("无法生成预览图");
  return blob;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
