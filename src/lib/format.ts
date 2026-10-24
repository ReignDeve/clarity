import type { Category, RecKind } from "./types";
import { REC_BITS } from "./types";

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/** Binary units labelled like Windows Explorer (1 GB = 1024³ bytes). */
export function bytes(n: number, digits?: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  let i = 0;
  let v = n;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  if (i === 0) return `${n} B`;
  const d = digits ?? (v >= 100 ? 0 : 1);
  return `${v.toFixed(d)} ${UNITS[i]}`;
}

/** Split for typographic display: ["4.2", "GB"]. */
export function bytesParts(n: number): [string, string] {
  const s = bytes(n);
  const i = s.lastIndexOf(" ");
  return [s.slice(0, i), s.slice(i + 1)];
}

const nf = new Intl.NumberFormat();
export const num = (n: number) => nf.format(n);

const df = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });
const dtf = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** Mirrors `plausible_time` in model.rs: 1980-style placeholders and future dates. */
export function plausibleTime(unix: number, now = nowUnix()): boolean {
  return unix >= 631_152_000 && unix <= now + 86_400;
}

export function date(unix: number): string {
  return unix > 0 ? df.format(unix * 1000) : "Unknown";
}
export function dateTime(unix: number): string {
  return unix > 0 ? dtf.format(unix * 1000) : "Unknown";
}

export function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

/** "3 days", "18 months", "2.4 years" — the age of a timestamp. */
export function age(unix: number, now = nowUnix()): string {
  if (unix <= 0) return "unknown";
  if (!plausibleTime(unix, now)) return "unknown date";
  const s = Math.max(0, now - unix);
  const d = s / 86400;
  if (d < 1) {
    const h = Math.floor(s / 3600);
    return h <= 0 ? "just now" : `${h} h`;
  }
  if (d < 60) return `${Math.floor(d)} day${Math.floor(d) === 1 ? "" : "s"}`;
  if (d < 730) return `${Math.floor(d / 30)} months`;
  const y = d / 365.25;
  return Math.abs(y - Math.round(y)) < 0.15 ? `${Math.round(y)} years` : `${y.toFixed(1)} years`;
}

export function ago(unix: number): string {
  const a = age(unix);
  return a.startsWith("unknown") || a === "just now" ? a : `${a} ago`;
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${Math.max(s, 0)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const CATEGORY_LABEL: Record<Category | "folder", string> = {
  documents: "Documents",
  images: "Images",
  video: "Video",
  audio: "Audio",
  archives: "Archives",
  installers: "Installers & disk images",
  code: "Code & data",
  apps: "Applications",
  system: "System & temporary",
  other: "Other",
  folder: "Folder",
};

export const catColor = (c: string) => `var(--c-${c})`;

export const REC_LABEL: Record<RecKind, string> = {
  largeOld: "Large & unchanged",
  oldInstaller: "Old installer",
  oldDownload: "Old download",
  archiveReview: "Old archive",
  largeVideo: "Large video",
  duplicate: "Duplicate",
  buildArtifacts: "Build output",
  staleProject: "Inactive project",
  tempFolder: "Forgotten work folder",
};

export function recKinds(mask: number): RecKind[] {
  return REC_BITS.filter((_, i) => mask & (1 << i));
}

export function recBit(kind: RecKind): number {
  return 1 << REC_BITS.indexOf(kind);
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Shorten a path in the middle: C:\Users\…\Project\file */
export function shortPath(p: string, max = 60): string {
  if (p.length <= max) return p;
  const parts = p.split("\\");
  if (parts.length <= 3) return "…" + p.slice(p.length - max + 1);
  let head = parts[0] + "\\" + parts[1];
  let tail = parts[parts.length - 1];
  let i = parts.length - 2;
  while (i > 1 && head.length + tail.length + parts[i].length + 4 < max) {
    tail = parts[i] + "\\" + tail;
    i--;
  }
  if (i <= 1) return p;
  head = head.length > max / 2 ? parts[0] : head;
  return `${head}\\…\\${tail}`;
}
