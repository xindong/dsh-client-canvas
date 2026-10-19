type ModelObject = InstanceType<import("three")["Object3D"]>;
type ModelCamera = InstanceType<import("three")["PerspectiveCamera"]>;
type ModelGeometry = InstanceType<import("three")["BufferGeometry"]>;

const MODEL_PREVIEW_BACKGROUND = 0xe8edf3;

export async function renderModelPreview(file: File, spec?: { width?: number; height?: number }): Promise<Blob> {
  const THREE = await import("three");
  const extension = file.name.toLowerCase().split(".").pop() ?? "glb";
  const width = spec?.width ?? 1024;
  const height = spec?.height ?? 768;
  let object: ModelObject | null = null;
  let objectUrlToRevoke: string | null = null;

  const { scene, camera, renderer } = createModelScene(THREE, width, height);
  try {
    const sourceUrl = URL.createObjectURL(file);
    objectUrlToRevoke = sourceUrl;
    object = await loadModelObject(THREE, sourceUrl, extension);
    applyFallbackMaterials(THREE, object);
    scene.add(object);
    frameObject(THREE, object, camera);
    renderer.render(scene, camera);
    return await canvasToBlob(renderer.domElement);
  } finally {
    if (object) disposeObject(THREE, object);
    renderer.dispose();
    if (objectUrlToRevoke) URL.revokeObjectURL(objectUrlToRevoke);
  }
}

function createModelScene(
  THREE: typeof import("three"),
  width: number,
  height: number,
): {
  scene: InstanceType<typeof THREE.Scene>;
  camera: ModelCamera;
  renderer: InstanceType<typeof THREE.WebGLRenderer>;
} {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(MODEL_PREVIEW_BACKGROUND);

  const camera = new THREE.PerspectiveCamera(35, width / height, 0.01, 10000);
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    preserveDrawingBuffer: true,
  });
  renderer.setSize(width, height, false);
  renderer.setPixelRatio(1);

  const ambient = new THREE.AmbientLight(0xffffff, 1.4);
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(4, 7, 6);
  const fill = new THREE.DirectionalLight(0xaecbfa, 1.1);
  fill.position.set(-5, 2, 3);
  scene.add(ambient, key, fill);

  return { scene, camera, renderer };
}

async function loadModelObject(
  THREE: typeof import("three"),
  url: string,
  extension: string,
): Promise<ModelObject> {
  switch (extension) {
    case "glb":
    case "gltf": {
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
      return normalizeLoadedModel(THREE, await new GLTFLoader().loadAsync(url));
    }
    case "obj": {
      const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
      return normalizeLoadedModel(THREE, await new OBJLoader().loadAsync(url));
    }
    case "fbx": {
      const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
      return normalizeLoadedModel(THREE, await new FBXLoader().loadAsync(url));
    }
    case "stl": {
      const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
      return normalizeLoadedModel(THREE, await new STLLoader().loadAsync(url));
    }
    case "ply": {
      const { PLYLoader } = await import("three/examples/jsm/loaders/PLYLoader.js");
      return normalizeLoadedModel(THREE, await new PLYLoader().loadAsync(url));
    }
    case "dae": {
      const { ColladaLoader } = await import("three/examples/jsm/loaders/ColladaLoader.js");
      return normalizeLoadedModel(THREE, await new ColladaLoader().loadAsync(url));
    }
    case "3mf": {
      const { ThreeMFLoader } = await import("three/examples/jsm/loaders/3MFLoader.js");
      return normalizeLoadedModel(THREE, await new ThreeMFLoader().loadAsync(url));
    }
    case "3ds": {
      const { TDSLoader } = await import("three/examples/jsm/loaders/TDSLoader.js");
      return normalizeLoadedModel(THREE, await new TDSLoader().loadAsync(url));
    }
    case "vrml":
    case "wrl": {
      const { VRMLLoader } = await import("three/examples/jsm/loaders/VRMLLoader.js");
      return normalizeLoadedModel(THREE, await new VRMLLoader().loadAsync(url));
    }
    default:
      throw new Error("此模型格式暂不支持本地预览，原文件已保存。");
  }
}

function normalizeLoadedModel(THREE: typeof import("three"), loaded: unknown): ModelObject {
  if (loaded instanceof THREE.Object3D) return loaded;
  if (loaded instanceof THREE.BufferGeometry) return meshFromGeometry(THREE, loaded);

  const maybeScene = loaded as { scene?: unknown };
  if (maybeScene.scene instanceof THREE.Object3D) return maybeScene.scene;
  if (maybeScene.scene instanceof THREE.BufferGeometry) return meshFromGeometry(THREE, maybeScene.scene);

  throw new Error("Loaded model result is not renderable");
}

function meshFromGeometry(THREE: typeof import("three"), geometry: ModelGeometry): ModelObject {
  if (!geometry.attributes.normal) {
    geometry.computeVertexNormals();
  }
  return new THREE.Mesh(geometry, createModelMaterial(THREE));
}

function applyFallbackMaterials(THREE: typeof import("three"), object: ModelObject): void {
  object.traverse((child) => {
    const mesh = child as { isMesh?: boolean; material?: unknown };
    if (mesh.isMesh && !mesh.material) {
      mesh.material = createModelMaterial(THREE);
    }
  });
}

function createModelMaterial(THREE: typeof import("three")) {
  return new THREE.MeshStandardMaterial({
    color: 0xb7c0cc,
    roughness: 0.82,
    metalness: 0.08,
  });
}

function frameObject(THREE: typeof import("three"), object: ModelObject, camera: ModelCamera): void {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z);

  if (
    !Number.isFinite(center.x) ||
    !Number.isFinite(center.y) ||
    !Number.isFinite(center.z) ||
    !Number.isFinite(maxDimension) ||
    maxDimension <= 0
  ) {
    throw new Error("Loaded model has no finite bounds");
  }

  object.position.sub(center);
  camera.position.set(maxDimension * 1.3, maxDimension * 1.05, maxDimension * 1.9);
  camera.lookAt(0, 0, 0);
  camera.near = Math.max(maxDimension / 1000, 0.01);
  camera.far = maxDimension * 20;
  camera.updateProjectionMatrix();
}

function disposeObject(THREE: typeof import("three"), object: ModelObject): void {
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

async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.86));
  if (blob) return blob;
  const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (png) return png;
  throw new Error("Model preview encoding failed");
}
