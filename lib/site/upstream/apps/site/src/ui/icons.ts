import {
  ArrowUpRight,
  Camera,
  ChevronDown,
  Download,
  ExternalLink,
  FilePlus,
  FileText,
  Frame,
  GripHorizontal,
  Copy,
  LayoutGrid,
  LoaderCircle,
  Pause,
  Play,
  Pencil,
  Plus,
  RefreshCw,
  Maximize,
  Save,
  Trash2,
  Upload,
  X,
  createElement as createLucideElement,
  type IconNode,
} from "lucide";

const ICONS = {
  camera: Camera,
  chevronDown: ChevronDown,
  copy: Copy,
  delete: Trash2,
  download: Download,
  externalLink: ExternalLink,
  filePlus: FilePlus,
  fileText: FileText,
  fit: Maximize,
  frame: Frame,
  grid: LayoutGrid,
  loading: LoaderCircle,
  open: ArrowUpRight,
  pencil: Pencil,
  play: Play,
  pause: Pause,
  plus: Plus,
  refresh: RefreshCw,
  rename: Pencil,
  save: Save,
  upload: Upload,
  x: X,
  drag: GripHorizontal,
} satisfies Record<string, IconNode>;

export type SiteIconName = keyof typeof ICONS;

export function createIcon(
  name: SiteIconName,
  { className, size = 16, strokeWidth = 2 }: { className?: string; size?: number; strokeWidth?: number } = {},
): SVGElement {
  return createLucideElement(ICONS[name], {
    "aria-hidden": "true",
    class: className ? `ui-icon ${className}` : "ui-icon",
    focusable: "false",
    height: size,
    width: size,
    "stroke-width": strokeWidth,
  });
}
