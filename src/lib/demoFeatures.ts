// Demo implementations (browser only, labelled DEMO DATA) of Media Explorer,
// relationships, activity and watchlist. The desktop app uses the Rust
// backend for all of these.

import type { Backend } from "./api";
import type { Activity, Category, FileRow, MediaItem, MediaMeta, MediaResult, RelatedFile, WatchAlert, WatchEntry, WatchRules } from "./types";

export interface DemoFile {
  id: number;
  dir: number;
  name: string;
  size: number;
  created: number;
  modified: number;
  cat: Category;
  removed: boolean;
}

interface Ctx {
  files: () => DemoFile[];
  dirPath: (dir: number) => string;
  within: (dir: number, anc: number) => boolean;
  row: (f: DemoFile) => FileRow;
}

const DAY = 86400;
const isMedia = (c: Category) => c === "images" || c === "video" || c === "audio";
const stem = (n: string) => n.toLowerCase().replace(/\.[^.]+$/, "").replace(/\.(en|de|fr)$/, "");

function hash(n: number) {
  let x = (n + 1) * 2654435761;
  x ^= x >>> 13;
  return Math.abs(x) % 360;
}

export function demoFeatures(ctx: Ctx): Pick<
  Backend,
  "fileRelations" | "planMove" | "executeMove" | "mediaQuery" | "mediaMeta" | "mediaIndexStart" | "thumbUrl" | "fileActivity" | "watchList" | "watchAdd" | "watchUpdate" | "watchPause" | "watchRemove" | "watchMarkSeen" | "onMediaProgress" | "onMediaFinished" | "onWatchAlerts"
> {
  const meta = (f: DemoFile): MediaMeta => {
    const h = hash(f.id);
    const portrait = f.cat === "images" && h % 4 === 0;
    return {
      width: f.cat === "audio" ? null : portrait ? 3024 : f.cat === "video" ? (h % 3 ? 3840 : 1920) : 4032,
      height: f.cat === "audio" ? null : portrait ? 4032 : f.cat === "video" ? (h % 3 ? 2160 : 1080) : 3024,
      durationMs: f.cat === "images" ? null : f.cat === "video" ? Math.round(f.size / 2_000) : Math.round(f.size / 40),
      frameRate: f.cat === "video" ? 29.97 : null,
      bitrate: f.cat === "audio" ? 320_000 : null,
      taken: f.cat === "images" ? f.modified - 3600 : null,
      camera: f.cat === "images" ? (h % 2 ? "iPhone 15 Pro" : "Sony ILCE-7M4") : null,
      title: f.cat === "audio" ? f.name.replace(/\.[^.]+$/, "") : null,
      artist: f.cat === "audio" ? "Demo Artist" : null,
      album: f.cat === "audio" ? "Demo Album" : null,
    };
  };
  const watch: WatchEntry[] = [
    { id: 1, path: "C:\\Users\\Alex\\Downloads", label: "Downloads", limitBytes: 30 * 1024 ** 3, growthBytes: 2 * 1024 ** 3, growthPct: null, notify: true, paused: false, createdAt: Date.now() / 1000 - 90 * DAY, available: true, unseenAlerts: 1, history: [80, 62, 45, 30, 14, 3].map((d, i) => ({ at: Math.floor(Date.now() / 1000) - d * DAY, bytes: (22 + i * 3.2) * 1024 ** 3, source: i < 3 ? "timeline" : "scan" })) },
    { id: 2, path: "E:\\Backups", label: "Backups (USB)", limitBytes: null, growthBytes: null, growthPct: 20, notify: false, paused: false, createdAt: Date.now() / 1000 - 60 * DAY, available: false, unseenAlerts: 0, history: [55, 20].map((d, i) => ({ at: Math.floor(Date.now() / 1000) - d * DAY, bytes: (40 + i * 2) * 1024 ** 3, source: "scan" })) },
  ];
  let alerts: WatchAlert[] = [{ id: 1, watchId: 1, label: "Downloads", path: watch[0].path, at: Math.floor(Date.now() / 1000) - 3 * DAY, kind: "limit", message: "Downloads is over its 30.0 GB limit (38.0 GB).", bytes: 38 * 1024 ** 3, prevBytes: 34.8 * 1024 ** 3, seen: false, notify: true }];

  return {
    thumbUrl: (id) => {
      const h = hash(id);
      const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='120'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='hsl(${h},45%,55%)'/><stop offset='1' stop-color='hsl(${(h + 60) % 360},40%,25%)'/></linearGradient></defs><rect width='160' height='120' fill='url(#g)'/><circle cx='${40 + (h % 80)}' cy='45' r='14' fill='rgba(255,255,255,.35)'/><path d='M0 120 L60 70 L95 100 L125 80 L160 110 L160 120Z' fill='rgba(0,0,0,.3)'/></svg>`;
      return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    },
    mediaQuery: async (q) => {
      const all = ctx.files().filter((f) => !f.removed && isMedia(f.cat) && (q.underDir == null || ctx.within(f.dir, q.underDir)));
      const s = (q.search ?? "").toLowerCase();
      const counts: MediaResult["counts"] = {};
      const formats = new Map<string, number>();
      let list = all.filter((f) => !s || f.name.toLowerCase().includes(s));
      for (const f of list) counts[f.cat === "images" ? "images" : f.cat === "video" ? "video" : "audio"] = (counts[f.cat === "images" ? "images" : f.cat === "video" ? "video" : "audio"] ?? 0) + 1;
      list = list.filter((f) => !q.kind || q.kind === "all" || (q.kind === "images" ? f.cat === "images" : q.kind === "video" ? f.cat === "video" : f.cat === "audio"));
      for (const f of list) formats.set(f.name.split(".").pop()!.toLowerCase(), (formats.get(f.name.split(".").pop()!.toLowerCase()) ?? 0) + 1);
      if (q.formats?.length) list = list.filter((f) => q.formats!.includes(f.name.split(".").pop()!.toLowerCase()));
      if (q.orientation) list = list.filter((f) => { const m = meta(f); if (!m.width || !m.height) return false; return q.orientation === "portrait" ? m.height > m.width : q.orientation === "landscape" ? m.width > m.height : m.width === m.height; });
      if (q.minPixels) list = list.filter((f) => (meta(f).width ?? 0) * (meta(f).height ?? 0) >= q.minPixels!);
      if (q.minDurationMs) list = list.filter((f) => (meta(f).durationMs ?? 0) >= q.minDurationMs!);
      if (q.maxDurationMs) list = list.filter((f) => (meta(f).durationMs ?? Infinity) <= q.maxDurationMs!);
      const key: Record<string, (f: DemoFile) => number | string> = { size: (f) => f.size, name: (f) => f.name.toLowerCase(), resolution: (f) => (meta(f).width ?? 0) * (meta(f).height ?? 0), duration: (f) => meta(f).durationMs ?? 0, taken: (f) => meta(f).taken ?? f.modified, date: (f) => f.modified };
      const k = key[q.sort ?? "date"] ?? key.date;
      list.sort((a, b) => (k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0));
      if (q.desc) list.reverse();
      const off = q.offset ?? 0;
      const items: MediaItem[] = list.slice(off, off + (q.limit || 300)).map((f) => ({ row: ctx.row(f), meta: meta(f), grouped: q.group && f.cat === "video" && f.name.startsWith("CLIP_0001") ? [{ id: -1, name: f.name.replace(/\.\w+$/, ".en.srt"), ext: "srt", size: 42_000 }] : [] }));
      return { total: list.length, totalBytes: list.reduce((a, f) => a + f.size, 0), items, formats: [...formats.entries()].sort((a, b) => b[1] - a[1]), counts, mediaTotal: all.length, metaKnown: all.length };
    },
    mediaMeta: async (id) => {
      const f = ctx.files()[id];
      return f && isMedia(f.cat) ? meta(f) : null;
    },
    mediaIndexStart: async () => {},
    onMediaProgress: async () => () => {},
    onMediaFinished: async () => () => {},
    onWatchAlerts: async () => () => {},
    fileRelations: async (id) => {
      const f = ctx.files()[id];
      if (!f) return [];
      const out: RelatedFile[] = [];
      for (const g of ctx.files()) {
        if (g.id === id || g.removed) continue;
        const sameDir = g.dir === f.dir;
        if (sameDir && stem(g.name) === stem(f.name) && g.name !== f.name) out.push({ id: g.id, kind: "export", label: "Same name, other format", confidence: "likely", reason: "Same name in the same folder.", row: ctx.row(g), path: `${ctx.dirPath(g.dir)}\\${g.name}` });
        else if (!sameDir && g.name === f.name && g.size === f.size) out.push({ id: g.id, kind: "copy", label: "Probable copy", confidence: "likely", reason: "Same name and exactly the same size in another folder.", row: ctx.row(g), path: `${ctx.dirPath(g.dir)}\\${g.name}` });
        else if (sameDir && f.cat === "video" && g.cat === "video" && out.length < 3 && g.name.slice(0, 5) === f.name.slice(0, 5)) out.push({ id: g.id, kind: "asset", label: "Clip from the same shoot", confidence: "possible", reason: "Numbered clip in the same folder.", row: ctx.row(g), path: `${ctx.dirPath(g.dir)}\\${g.name}` });
      }
      return out.slice(0, 8);
    },
    planMove: async (ids, destination) => ({
      destination,
      steps: ids.map((id) => {
        const f = ctx.files()[id];
        return { id, name: f.name, from: `${ctx.dirPath(f.dir)}\\${f.name}`, to: `${destination}\\${f.name}`, size: f.size, ok: true, blocked: null };
      }),
      movable: ids.length,
      bytes: ids.reduce((s, id) => s + ctx.files()[id].size, 0),
      crossDrive: !destination.toUpperCase().startsWith("C:"),
      error: null,
    }),
    executeMove: async (ids, destination) => {
      const outcomes = ids.map((id) => {
        const f = ctx.files()[id];
        f.removed = true;
        return { id, from: `${ctx.dirPath(f.dir)}\\${f.name}`, to: `${destination}\\${f.name}`, size: f.size, status: "moved" as const, error: null };
      });
      return { outcomes, moved: outcomes.length, bytes: outcomes.reduce((s, o) => s + o.size, 0) };
    },
    fileActivity: async (q) => {
      const tz = q.tzOffsetMin * 60;
      const days = new Map<number, { files: number; bytes: number }>();
      let first = Infinity, last = -Infinity, totalFiles = 0, totalBytes = 0;
      for (const f of ctx.files()) {
        if (f.removed || (q.categories?.length && !q.categories.includes(f.cat)) || (q.underDir != null && !ctx.within(f.dir, q.underDir))) continue;
        const ts = q.field === "created" ? f.created : f.modified;
        const d = Math.floor((ts + tz) / DAY);
        first = Math.min(first, d);
        last = Math.max(last, d);
        if (d < q.fromDay || d > q.toDay) continue;
        const e = days.get(d) ?? { files: 0, bytes: 0 };
        e.files++;
        e.bytes += f.size;
        days.set(d, e);
        totalFiles++;
        totalBytes += f.size;
      }
      const today = Math.floor((Date.now() / 1000 + tz) / DAY);
      const observed = [40, 21, 12, 5, 0].map((ago, i) => ({ day: today - ago, at: (today - ago) * DAY, kind: (i === 3 ? "cleanup" : "scan") as "scan" | "cleanup", label: i === 3 ? "12 items moved to the Recycle Bin (18.0 GB)" : "CLARITY scanned" }));
      const a: Activity = { days: [...days.entries()].map(([day, v]) => ({ day, ...v })).sort((x, y) => x.day - y.day), totalFiles, totalBytes, undated: 3, firstDay: Number.isFinite(first) ? first : null, lastDay: Number.isFinite(last) ? last : null, observed: observed.filter((o) => o.day >= q.fromDay && o.day <= q.toDay) };
      return a;
    },
    watchList: async () => ({ entries: watch.map((w) => ({ ...w, unseenAlerts: alerts.filter((a) => a.watchId === w.id && !a.seen).length })), alerts, current: { 1: 38 * 1024 ** 3 } }),
    watchAdd: async (path, rules: WatchRules) => {
      const id = Math.max(0, ...watch.map((w) => w.id)) + 1;
      watch.push({ id, path, label: rules.label || path.split("\\").filter(Boolean).pop() || path, limitBytes: rules.limitBytes ?? null, growthBytes: rules.growthBytes ?? null, growthPct: rules.growthPct ?? null, notify: !!rules.notify, paused: false, createdAt: Date.now() / 1000, available: true, history: [], unseenAlerts: 0 });
      return id;
    },
    watchUpdate: async (id, r) => {
      const w = watch.find((x) => x.id === id)!;
      Object.assign(w, { label: r.label || w.label, limitBytes: r.limitBytes ?? null, growthBytes: r.growthBytes ?? null, growthPct: r.growthPct ?? null, notify: !!r.notify });
    },
    watchPause: async (id, paused) => void (watch.find((x) => x.id === id)!.paused = paused),
    watchRemove: async (id) => {
      watch.splice(watch.findIndex((x) => x.id === id), 1);
      alerts = alerts.filter((a) => a.watchId !== id);
    },
    watchMarkSeen: async (ids) => void alerts.forEach((a) => (!ids.length || ids.includes(a.id)) && (a.seen = true)),
  };
}
