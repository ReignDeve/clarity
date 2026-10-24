// Synthetic Storage Timeline for the browser demo (`pnpm dev`). Never used
// by the desktop app, where snapshots come from real scans in SQLite.

import type { Category, Comparison, Delta, TimelinePoint, TimelineRoot } from "./types";

const DAY = 86400;
const GB = 1024 ** 3;
const MB = 1024 ** 2;
const NOW = Math.floor(Date.now() / 1000);

const BASE: Partial<Record<Category, number>> = { video: 62 * GB, apps: 88 * GB, other: 40 * GB, images: 5.1 * GB, archives: 9 * GB, installers: 7.5 * GB, audio: 1.8 * GB, documents: 1.1 * GB, code: 0.8 * GB, system: 2.2 * GB };

function points(): TimelinePoint[] {
  const days = [120, 104, 91, 77, 60, 46, 33, 21, 12, 5, 0];
  return days.map((d, i) => {
    const growth = (120 - d) / 120;
    const categories: Partial<Record<Category, number>> = {};
    for (const [c, b] of Object.entries(BASE) as [Category, number][]) {
      const f = c === "video" ? 1 + growth * 0.32 : c === "installers" ? 1 + Math.sin(i) * 0.25 : c === "archives" && d < 30 ? 0.62 : 1 + growth * 0.06;
      categories[c] = Math.round(b * f);
    }
    const bytes = Object.values(categories).reduce((s, v) => s + (v ?? 0), 0);
    const legacy = i === 0;
    const complete = i !== 6;
    return {
      snapshotId: i + 1,
      takenAt: NOW - d * DAY - 3600,
      bytes,
      files: 180_000 + i * 2100,
      volumeTotal: 952 * GB,
      volumeUsed: bytes + 80 * GB,
      complete,
      legacy,
      hasDirs: complete && !legacy,
      hasFiles: complete && !legacy && i > 2,
      errors: 37,
      categories: complete && !legacy ? categories : {},
    };
  });
}

export function demoTimeline() {
  const pts = points();
  const roots: TimelineRoot[] = [
    { id: 1, path: "C:\\", snapshots: pts.length, firstAt: pts[0].takenAt, lastAt: pts[pts.length - 1].takenAt, available: true },
    { id: 2, path: "E:\\", snapshots: 3, firstAt: NOW - 70 * DAY, lastAt: NOW - 18 * DAY, available: false },
  ];
  const usb: TimelinePoint[] = [70, 40, 18].map((d, i) => ({ snapshotId: 100 + i, takenAt: NOW - d * DAY, bytes: (31 + i * 6) * GB, files: 4200 + i * 300, volumeTotal: 64 * GB, volumeUsed: (33 + i * 6) * GB, complete: true, legacy: false, hasDirs: true, hasFiles: true, errors: 0, categories: { video: (20 + i * 5) * GB, images: 9 * GB, documents: 2 * GB } }));

  const d = (path: string, before: number, after: number, category: Category | null = null): Delta => ({
    path,
    name: path.split("\\").pop()!,
    before,
    after,
    delta: after - before,
    status: before === 0 ? "added" : after === 0 ? "removed" : "changed",
    category,
  });

  return {
    roots: async () => roots,
    series: async (root: number, since: number) => (root === 2 ? usb : pts).filter((p) => p.takenAt >= since),
    compare: async (root: number, from: number, to: number): Promise<Comparison> => {
      const all = root === 2 ? usb : pts;
      let a = all.find((p) => p.snapshotId === from)!;
      let b = all.find((p) => p.snapshotId === to)!;
      if (a.takenAt > b.takenAt) [a, b] = [b, a];
      const delta = b.bytes - a.bytes;
      const detail = a.hasDirs && b.hasDirs;
      const files = a.hasFiles && b.hasFiles;
      const span = Math.round((b.takenAt - a.takenAt) / DAY);
      const k = Math.max(0.15, Math.min(1, span / 120));
      const grew = detail ? [d("C:\\Users\\Alex\\Videos\\Drone footage", 9.4 * GB, 9.4 * GB + 14 * GB * k, "video"), d("C:\\Users\\Alex\\Downloads", 34 * GB, 34 * GB + 5.2 * GB * k), d("C:\\Users\\Alex\\Projects\\web-shop\\node_modules", 0, 690 * MB)] : [];
      const shrank = detail ? [d("C:\\Users\\Alex\\Documents\\Old Backups", 3.4 * GB, 0, "archives"), d("C:\\Games\\Cyberpunk 2077", 46 * GB, 46 * GB - 1.1 * GB * k)] : [];
      const added = files ? [d("C:\\Users\\Alex\\Videos\\Drone footage\\CLIP_0009.mp4", 0, 3.6 * GB, "video"), d("C:\\Users\\Alex\\Downloads\\Win11_23H2_German_x64.iso", 0, 5.5 * GB, "installers"), d("C:\\Users\\Alex\\Videos\\Screen Recording 2024-03-02.mkv", 0, 6.8 * GB, "video")] : [];
      const deleted = files ? [d("C:\\Users\\Alex\\Documents\\Old Backups\\phone-2021.zip", 3.4 * GB, 0, "archives")] : [];
      const modified = files ? [d("C:\\Users\\Alex\\AppData\\Local\\Docker\\wsl\\disk\\docker_data.vhdx", 12.1 * GB, 15.3 * GB, "system")] : [];
      const sum = (x: Delta[]) => x.reduce((s, i) => s + i.delta, 0);
      const cats = detail
        ? (Object.keys(BASE) as Category[]).map((c) => ({ category: c, before: a.categories[c] ?? 0, after: b.categories[c] ?? 0, delta: (b.categories[c] ?? 0) - (a.categories[c] ?? 0) })).filter((c) => c.delta !== 0).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
        : [];
      const warnings = [!a.complete && "The earlier scan was cancelled, so its totals are partial and folder or file changes cannot be compared.", !b.complete && "The later scan was cancelled, so its totals are partial and folder or file changes cannot be compared.", a.legacy && "The earlier scan was made before the timeline existed; only its total size is known."].filter(Boolean) as string[];
      const fmt = (n: number) => `${(Math.abs(n) / GB).toFixed(1)} GB`;
      const highlights: Comparison["highlights"] = [
        { text: `${root === 2 ? "E:" : "C:"} ${delta >= 0 ? "grew by" : "shrank by"} ${fmt(delta)}`, detail: `Between these scans, ${span} days apart.`, delta, path: root === 2 ? "E:\\" : "C:\\", kind: "total", category: null },
        ...(detail ? [{ text: `Downloads grew by ${fmt(grew[1].delta)}`, detail: `${fmt(grew[1].before)} → ${fmt(grew[1].after)}`, delta: grew[1].delta, path: grew[1].path, kind: "dir" as const, category: null }, { text: `“Drone footage” grew by ${fmt(grew[0].delta)}`, detail: grew[0].path, delta: grew[0].delta, path: grew[0].path, kind: "dir" as const, category: null }] : []),
        ...(cats[0] ? [{ text: `Video grew by ${fmt(cats.find((c) => c.category === "video")?.delta ?? 0)}`, detail: "Across all folders", delta: cats.find((c) => c.category === "video")?.delta ?? 0, path: null, kind: "category" as const, category: "video" as const }] : []),
        ...(files ? [{ text: `${added.length} large files added (${fmt(sum(added))})`, detail: "Files of 10 MB or more.", delta: sum(added), path: added[0].path, kind: "file" as const, category: null }] : []),
      ];
      return {
        root: root === 2 ? "E:\\" : "C:\\",
        from: a,
        to: b,
        delta,
        filesDelta: b.files - a.files,
        volumeUsedDelta: a.volumeUsed != null && b.volumeUsed != null ? b.volumeUsed - a.volumeUsed : null,
        categories: cats,
        grew,
        shrank,
        added: { items: added, count: added.length, bytes: sum(added) },
        deleted: { items: deleted, count: deleted.length, bytes: sum(deleted) },
        modified: { items: modified, count: modified.length, bytes: sum(modified) },
        highlights,
        warnings,
        hasFolderDetail: detail,
        hasFileDetail: files,
        fileMin: 10 * MB,
        dirMin: 16 * MB,
      };
    },
  };
}
