import { AppWindow, Archive, Code2, File, FileText, Film, Folder, Image, Music, Package, Settings2 } from "lucide-react";
import { catColor } from "../lib/format";

const ICONS = {
  documents: FileText,
  images: Image,
  video: Film,
  audio: Music,
  archives: Archive,
  installers: Package,
  code: Code2,
  apps: AppWindow,
  system: Settings2,
  other: File,
  folder: Folder,
} as const;

export function FileIcon({ category, size = 16, boxed = false }: { category: string; size?: number; boxed?: boolean }) {
  const Icon = ICONS[category as keyof typeof ICONS] ?? File;
  if (!boxed) return <Icon size={size} strokeWidth={1.7} style={{ color: catColor(category) }} className="shrink-0" />;
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-[9px]"
      style={{
        width: size * 2.25,
        height: size * 2.25,
        background: `color-mix(in oklab, ${catColor(category)} 14%, transparent)`,
        boxShadow: `0 0 0 1px color-mix(in oklab, ${catColor(category)} 26%, transparent) inset`,
      }}
    >
      <Icon size={size} strokeWidth={1.7} style={{ color: catColor(category) }} />
    </span>
  );
}
