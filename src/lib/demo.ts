// Demo backend: synthetic data for running the UI in a plain browser
// (`pnpm dev`). The UI labels this mode prominently. It is never used in
// the desktop app, where all data comes from real scans.

import type { Backend } from "./api";
import type {
  CategoryStat,
  Category,
  CleanupRun,
  DirRow,
  DupGroupView,
  FileQuery,
  FileRow,
  ItemCheck,
  ItemOutcome,
  Recommendation,
  ScanInfo,
  ScanRecord,
  Settings,
  TreeNode,
} from "./types";
import { REC_BITS } from "./types";
import { demoTimeline } from "./demoTimeline";
import { demoFeatures } from "./demoFeatures";
import { demoOrganizer } from "./demoOrganizer";

interface DDir { id: number; parent: number; name: string; dirs: number[]; files: number[]; removed: boolean; }
interface DFile { id: number; dir: number; name: string; size: number; created: number; modified: number; accessed: number; cat: Category; removed: boolean; }

const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

const CAT_BY_EXT: Record<string, Category> = {
  pdf: "documents", docx: "documents", xlsx: "documents", txt: "documents", md: "documents", pptx: "documents",
  jpg: "images", png: "images", heic: "images", psd: "images",
  mp4: "video", mkv: "video", mov: "video",
  mp3: "audio", flac: "audio", wav: "audio",
  zip: "archives", "7z": "archives", rar: "archives",
  msi: "installers", iso: "installers", exe: "apps", dll: "apps", pak: "apps",
  ts: "code", js: "code", json: "code", rs: "code", py: "code",
  log: "system", tmp: "system", dat: "system",
};

function build() {
  const r = rng(42);
  const dirs: DDir[] = [];
  const files: DFile[] = [];
  const mkdir = (parent: number, name: string) => {
    const id = dirs.length;
    dirs.push({ id, parent, name, dirs: [], files: [], removed: false });
    if (parent >= 0) dirs[parent].dirs.push(id);
    return id;
  };
  const mkfile = (dir: number, name: string, size: number, ageDays: number) => {
    const ext = name.split(".").pop()!.toLowerCase();
    const modified = NOW - Math.floor(ageDays * DAY);
    const id = files.length;
    files.push({ id, dir, name, size: Math.floor(size), created: modified - Math.floor(r() * 200 * DAY), modified, accessed: modified + Math.floor(r() * 30 * DAY), cat: CAT_BY_EXT[ext] ?? "other", removed: false });
    dirs[dir].files.push(id);
  };
  const MB = 1024 * 1024;
  const GB = 1024 * MB;
  const root = mkdir(-1, "C:\\");
  const users = mkdir(root, "Users");
  const me = mkdir(users, "Alex");
  const dl = mkdir(me, "Downloads");
  const docs = mkdir(me, "Documents");
  const vids = mkdir(me, "Videos");
  const pics = mkdir(me, "Pictures");
  const music = mkdir(me, "Music");
  const proj = mkdir(me, "Projects");
  const pf = mkdir(root, "Program Files");
  const games = mkdir(root, "Games");

  ["Setup_Photoshop_2024.exe", "node-v18.12.0-x64.msi", "ubuntu-22.04-desktop-amd64.iso", "VSCodeUserSetup-x64.exe", "Win11_23H2_German_x64.iso"].forEach((n, i) =>
    mkfile(dl, n, n.endsWith(".iso") ? 4.7 * GB + i * 200 * MB : 80 * MB + r() * 300 * MB, 200 + i * 120));
  for (let i = 0; i < 60; i++) {
    const kinds = ["pdf", "zip", "jpg", "docx", "mp4", "png"];
    const ext = kinds[Math.floor(r() * kinds.length)];
    mkfile(dl, `download_${(1000 + i).toString(36)}.${ext}`, (ext === "mp4" ? 400 : ext === "zip" ? 120 : 6) * MB * r() + 200_000, r() * 900);
  }
  mkfile(dl, "Backup_Laptop_2022.zip", 12.4 * GB, 640);
  mkfile(dl, "Backup_Laptop_2022 (1).zip", 12.4 * GB, 600);

  const taxes = mkdir(docs, "Taxes");
  for (let y = 2018; y <= 2025; y++) mkfile(taxes, `Tax_Return_${y}.pdf`, 1.2 * MB + r() * 3 * MB, (2026 - y) * 365);
  const work = mkdir(docs, "Work");
  for (let i = 0; i < 80; i++) mkfile(work, `Report_${i + 1}.${["docx", "xlsx", "pdf", "pptx"][i % 4]}`, 300_000 + r() * 30 * MB, r() * 1400);
  mkfile(docs, "Thesis_final_v7.pdf", 48 * MB, 1100);
  mkfile(docs, "notes.md", 14_000, 4);

  const trips = ["Iceland 2021", "Lisbon 2023", "Wedding", "Drone footage"];
  trips.forEach((t, ti) => {
    const d = mkdir(vids, t);
    for (let i = 0; i < 6 + ti * 2; i++) mkfile(d, `CLIP_${String(i + 1).padStart(4, "0")}.${i % 3 ? "mp4" : "mov"}`, (0.3 + r() * 3.5) * GB, 300 + ti * 250 + r() * 60);
  });
  mkfile(vids, "Screen Recording 2024-03-02.mkv", 6.8 * GB, 590);

  for (let y = 2016; y <= 2025; y++) {
    const d = mkdir(pics, String(y));
    for (let i = 0; i < 120; i++) mkfile(d, `IMG_${y}${String(i).padStart(4, "0")}.${i % 7 ? "jpg" : "heic"}`, 2 * MB + r() * 6 * MB, (2026 - y) * 365 - r() * 300);
  }
  for (let i = 0; i < 140; i++) mkfile(music, `Track ${i + 1}.${i % 5 ? "mp3" : "flac"}`, (i % 5 ? 8 : 38) * MB * (0.6 + r() * 0.8), 900 + r() * 1000);

  ["web-shop", "portfolio-2021", "ml-experiments"].forEach((p, pi) => {
    const d = mkdir(proj, p);
    mkfile(d, "package.json", 2_000, 500 + pi * 300);
    const nm = mkdir(d, "node_modules");
    for (let i = 0; i < 40; i++) {
      const pkg = mkdir(nm, `pkg-${pi}-${i}`);
      for (let k = 0; k < 8; k++) mkfile(pkg, `index${k}.js`, 50_000 + r() * 2 * MB, 500 + pi * 300);
    }
    const src = mkdir(d, "src");
    for (let i = 0; i < 30; i++) mkfile(src, `module${i}.ts`, 2_000 + r() * 40_000, 500 + pi * 300 + r() * 20);
  });

  const apps = ["Adobe", "JetBrains", "Steam", "Microsoft Office", "NVIDIA Corporation"];
  apps.forEach((a) => {
    const d = mkdir(pf, a);
    for (let i = 0; i < 25; i++) mkfile(d, `${a.split(" ")[0].toLowerCase()}_${i}.dll`, 5 * MB + r() * 120 * MB, 100 + r() * 400);
  });
  ["Cyberpunk 2077", "Baldur's Gate 3"].forEach((g) => {
    const d = mkdir(games, g);
    for (let i = 0; i < 12; i++) mkfile(d, `data_${i}.pak`, 2 * GB + r() * 4 * GB, 200 + r() * 200);
  });
  // A few byte-identical copies for the demo duplicate view.
  mkfile(pics, "IMG_20190612_0042.jpg", 5.2 * MB, 2400);
  mkfile(docs, "IMG_20190612_0042.jpg", 5.2 * MB, 2400);
  mkfile(dl, "IMG_20190612_0042 (1).jpg", 5.2 * MB, 2390);
  mkfile(work, "Contract_signed.pdf", 2.4 * MB, 800);
  mkfile(dl, "Contract_signed.pdf", 2.4 * MB, 802);
  return { dirs, files, downloads: dl };
}

export function createDemoBackend(): Backend {
  let { dirs, files, downloads } = build();
  let settings: Settings = { theme: "system", motion: "system", oldDays: 365, largeMb: 500, dupMinKb: 10240, skipSystem: true, exclusions: [], onboarded: false, lastRoots: [], showHidden: true };
  let hasScan = false;
  let dupsComputed = false;
  const scans: ScanRecord[] = [];
  const cleanups: CleanupRun[] = [];
  const listeners: Record<string, ((p: any) => void)[]> = {};
  const emit = (n: string, p: unknown) => (listeners[n] ?? []).forEach((cb) => cb(p));
  const on = (n: string) => async (cb: (p: any) => void) => {
    (listeners[n] ??= []).push(cb);
    return () => (listeners[n] = listeners[n].filter((x) => x !== cb));
  };
  const wait = <T,>(v: T, ms = 60) => new Promise<T>((res) => setTimeout(() => res(v), ms));

  const timeline = demoTimeline();
  const dirPath = (id: number): string => {
    const parts: string[] = [];
    for (let d = id; d >= 0; d = dirs[d].parent) parts.unshift(dirs[d].name);
    return parts.join("\\").replace("C:\\\\", "C:\\");
  };
  // Aggregates are memoised and dropped whenever the demo "cleans up".
  let memo = new Map<string, number>();
  const cached = (k: string, f: () => number) => {
    let v = memo.get(k);
    if (v === undefined) memo.set(k, (v = f()));
    return v;
  };
  const size = (id: number): number => cached(`s${id}`, () => (dirs[id].removed ? 0 : dirs[id].files.reduce((s, f) => s + (files[f].removed ? 0 : files[f].size), 0) + dirs[id].dirs.reduce((s, c) => s + size(c), 0)));
  const count = (id: number): number => cached(`c${id}`, () => (dirs[id].removed ? 0 : dirs[id].files.filter((f) => !files[f].removed).length + dirs[id].dirs.reduce((s, c) => s + count(c), 0)));
  const latest = (id: number): number => cached(`l${id}`, () => Math.max(0, ...dirs[id].files.map((f) => files[f].modified), ...dirs[id].dirs.map(latest)));
  const within = (d: number, anc: number) => { for (; d >= 0; d = dirs[d].parent) if (d === anc) return true; return false; };
  const dupGroups = [[files.find((f) => f.name === "Backup_Laptop_2022.zip")!.id, files.find((f) => f.name === "Backup_Laptop_2022 (1).zip")!.id], files.filter((f) => f.name.startsWith("IMG_20190612_0042")).map((f) => f.id), files.filter((f) => f.name === "Contract_signed.pdf").map((f) => f.id)];

  const masks = () => {
    const m = new Map<number, number>();
    const bit = (k: string) => 1 << REC_BITS.indexOf(k as any);
    for (const f of files) {
      if (f.removed) continue;
      let v = 0;
      const ageD = (NOW - f.modified) / DAY;
      if (f.size >= settings.largeMb * 1024 * 1024 && ageD > settings.oldDays) v |= bit("largeOld");
      if ((f.cat === "installers" || (f.name.endsWith(".exe") && within(f.dir, downloads))) && ageD > 90) v |= bit("oldInstaller");
      if (within(f.dir, downloads) && ageD > 180 && f.size > 10e6) v |= bit("oldDownload");
      if (f.cat === "archives" && f.size > 100e6 && ageD > settings.oldDays) v |= bit("archiveReview");
      if (f.cat === "video" && f.size > 1024 ** 3) v |= bit("largeVideo");
      if (dupsComputed && dupGroups.some((g) => g.includes(f.id))) v |= bit("duplicate");
      if (v) m.set(f.id, v);
    }
    return m;
  };
  const row = (f: DFile, m = masks()): FileRow => ({ id: f.id, name: f.name, dir: dirPath(f.dir), dirId: f.dir, ext: f.name.split(".").pop()!.toLowerCase(), size: f.size, created: f.created, modified: f.modified, accessed: f.accessed, category: f.cat, cloud: false, hidden: false, readonly: false, system: false, recs: m.get(f.id) ?? 0 });
  const dirRow = (id: number): DirRow => ({ id, name: dirs[id].name, path: dirPath(id), size: size(id), ownSize: dirs[id].files.reduce((s, f) => s + (files[f].removed ? 0 : files[f].size), 0), files: count(id), subdirs: dirs[id].dirs.length, latestModified: latest(id), unreadable: false });
  const info = (): ScanInfo => ({ id: "demo", startedAt: NOW - 3600, finishedAt: NOW - 3540, durationMs: 41_200, roots: [{ id: 0, path: "C:\\", size: size(0), files: count(0), volumeTotal: 1024 ** 4 * 0.93, volumeFree: 1024 ** 4 * 0.93 - size(0) * 1.4 }], files: count(0), dirs: dirs.length, bytes: size(0), errors: 37, linksSkipped: 12, excluded: 3, cancelled: false, cached: false });

  const recs = (): Recommendation[] => {
    const m = masks();
    const out: Recommendation[] = [];
    const label: Record<string, [string, string, "low" | "medium" | "high", string]> = {
      oldInstaller: ["Old installer", "Installers are usually only needed once; most can be downloaded again.", "low", "Keep it if this exact version is no longer available."],
      archiveReview: ["Large archive", "Review whether you still need it, or whether its contents exist elsewhere.", "medium", "Archives are often the only copy of a backup."],
      largeOld: ["Large, unchanged file", "That does not mean it is unused, but it is a good candidate to review.", "medium", "An old modification date only means the content has not changed."],
      oldDownload: ["Old download", "Downloads are often kept by accident after being used once.", "low", "Make sure it is not the only copy of something you received."],
      largeVideo: ["Large video", "Videos are usually the largest personal files.", "medium", "Personal recordings may be irreplaceable."],
    };
    for (const [id, v] of m) {
      const f = files[id];
      const kind = (["oldInstaller", "archiveReview", "largeOld", "oldDownload", "largeVideo"] as const).find((k) => v & (1 << REC_BITS.indexOf(k)));
      if (!kind) continue;
      const [t, why, risk, note] = label[kind];
      out.push({ kind, target: { kind: "file", id }, name: f.name, path: dirPath(f.dir) + "\\" + f.name, size: f.size, category: f.cat, title: `${t}: ${f.name}`, reason: `This file has not been modified in ${Math.round((NOW - f.modified) / DAY / 30)} months. ${why}`, risk, riskNote: note, action: "Review", modified: f.modified });
    }
    dirs.filter((d) => d.name === "node_modules" && !d.removed).forEach((d) => out.push({ kind: "buildArtifacts", target: { kind: "dir", id: d.id }, name: d.name, path: dirPath(d.id), size: size(d.id), category: "folder", title: `Build output: ${d.name}`, reason: `This “node_modules” folder contains generated files and has not changed in ${Math.round((NOW - latest(d.id)) / DAY / 30)} months.`, risk: "low", riskNote: "Reinstalling dependencies needs an internet connection.", action: "Move to Recycle Bin", modified: latest(d.id) }));
    if (dupsComputed) dupGroups.forEach((g, i) => { const live = g.filter((x) => !files[x].removed); if (live.length > 1) out.push({ kind: "duplicate", target: { kind: "dupGroup", id: i }, name: files[live[0]].name, path: "", size: files[live[0]].size * (live.length - 1), category: files[live[0]].cat, title: `${live.length} identical copies of ${files[live[0]].name}`, reason: "These files have byte-for-byte identical content.", risk: "low", riskNote: "Keep the copy in the location you actually use.", action: "Choose which copy to keep", modified: files[live[0]].modified }); });
    return out.sort((a, b) => b.size - a.size);
  };

  const query = (q: FileQuery) => {
    const m = masks();
    const cut = q.olderThanDays ? NOW - q.olderThanDays * DAY : null;
    const s = (q.search ?? "").toLowerCase();
    let list = files.filter((f) => {
      if (f.removed) return false;
      if (q.categories?.length && !q.categories.includes(f.cat)) return false;
      if (q.minSize && f.size < q.minSize) return false;
      const dt = q.dateField === "created" ? f.created : q.dateField === "accessed" ? f.accessed : f.modified;
      if (cut && dt >= cut) return false;
      if (q.from && dt < q.from) return false;
      if (q.to && dt > q.to) return false;
      if (q.recMask && !((m.get(f.id) ?? 0) & q.recMask)) return false;
      if (q.underDir != null && !within(f.dir, q.underDir)) return false;
      if (s && !f.name.toLowerCase().includes(s)) return false;
      return true;
    });
    const key: Record<string, (f: DFile) => number | string> = { size: (f) => f.size, name: (f) => f.name.toLowerCase(), modified: (f) => f.modified, created: (f) => f.created, accessed: (f) => f.accessed, type: (f) => f.name.split(".").pop()!, path: (f) => dirPath(f.dir), reason: (f) => m.get(f.id) ?? 0 };
    const k = key[q.sort ?? "size"] ?? key.size;
    list.sort((a, b) => (k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0));
    if (q.desc) list.reverse();
    return { list, m };
  };

  const tree = (id: number, depth: number): TreeNode => {
    const node: TreeNode = { id, kind: "dir", name: dirs[id].name, size: size(id), category: null, children: [] };
    if (depth === 0) return node;
    const kids: TreeNode[] = dirs[id].dirs.filter((c) => !dirs[c].removed && size(c) > 0).map((c) => tree(c, depth - 1));
    let loose = 0, n = 0;
    for (const f of dirs[id].files) { const fr = files[f]; if (fr.removed) continue; if (fr.size >= node.size / 50) kids.push({ id: f, kind: "file", name: fr.name, size: fr.size, category: fr.cat, children: [] }); else { loose += fr.size; n++; } }
    if (loose) kids.push({ id: -1, kind: "files", name: `${n} smaller files`, size: loose, category: null, children: [] });
    kids.sort((a, b) => b.size - a.size);
    node.children = kids.slice(0, 40);
    return node;
  };
  const crumbs = (id: number) => { const c = []; for (let d = id; d >= 0; d = dirs[d].parent) c.unshift({ id: d, name: dirs[d].name }); return c; };
  const cats = (pred: (f: DFile) => boolean): CategoryStat[] => {
    const m = new Map<Category, CategoryStat>();
    for (const f of files) { if (f.removed || !pred(f)) continue; const c = m.get(f.cat) ?? { category: f.cat, bytes: 0, count: 0 }; c.bytes += f.size; c.count++; m.set(f.cat, c); }
    return [...m.values()].sort((a, b) => b.bytes - a.bytes);
  };

  return {
    demo: true,
    appInfo: () => wait({ version: "0.1.0-demo", lastAccess: { enabled: false, systemManaged: true, explanation: "Demo mode: in the desktop app CLARITY reads this from Windows." }, downloadsPath: "C:\\Users\\Alex\\Downloads", homePath: "C:\\Users\\Alex", onedrivePaths: ["C:\\Users\\Alex\\OneDrive"], hasIndex: hasScan, cacheSavedAt: null, scanning: false }),
    drives: () => wait([{ mount: "C:\\", label: "Windows", fileSystem: "NTFS", kind: "fixed", total: 1024 ** 4 * 0.93, free: 1024 ** 4 * 0.93 - size(0) * 1.4 }, { mount: "D:\\", label: "Data", fileSystem: "NTFS", kind: "fixed", total: 2 * 1024 ** 4 * 0.91, free: 1.2 * 1024 ** 4 }, { mount: "E:\\", label: "USB Stick", fileSystem: "exFAT", kind: "removable", total: 64 * 1024 ** 3, free: 21 * 1024 ** 3 }]),
    settings: () => wait(settings),
    saveSettings: async (s) => (settings = s),
    startScan: async (roots) => {
      const t0 = Date.now();
      const total = count(0);
      const tick = setInterval(() => {
        const k = Math.min(1, (Date.now() - t0) / 2600);
        emit("scan-progress", { files: Math.floor(total * k), dirs: Math.floor(dirs.length * k), bytes: Math.floor(size(0) * k), errors: Math.floor(37 * k), current: dirPath(Math.floor((dirs.length - 1) * k)), elapsedMs: Date.now() - t0 });
        if (k >= 1) {
          clearInterval(tick);
          hasScan = true;
          scans.unshift({ id: scans.length + 1, startedAt: NOW, durationMs: 2600, roots, files: total, bytes: size(0), errors: 37, cancelled: false });
          emit("scan-finished", { cancelled: false, kept: false, info: info() });
        }
      }, 120);
    },
    cancelScan: async () => {},
    loadCachedScan: async () => null,
    overview: () => {
      const m = masks();
      const rs = recs();
      const all = files.filter((f) => !f.removed);
      const old1 = all.filter((f) => NOW - f.modified > settings.oldDays * DAY);
      const old2 = all.filter((f) => NOW - f.modified > 730 * DAY);
      const dlBytes = size(downloads);
      const insights = [
        { text: `${rs.filter((r) => r.kind === "largeOld").length} large files worth reviewing`, detail: "Large files whose content has not changed for a long time.", target: "old" },
        ...(dupsComputed ? [{ text: `${(dupGroups.reduce((s, g) => s + files[g[0]].size * (g.length - 1), 0) / 1024 ** 3).toFixed(1)} GB of confirmed duplicate content`, detail: `${dupGroups.length} groups of byte-identical files.`, target: "duplicates" }] : []),
        { text: `Your Downloads folder contains ${(dlBytes / 1024 ** 3).toFixed(1)} GB`, detail: "Most of it has not been modified in over 6 months.", target: "downloads" },
        { text: `${(rs.filter((r) => r.kind === "buildArtifacts").reduce((s, r) => s + r.size, 0) / 1024 ** 2).toFixed(0)} MB in regenerable build folders`, detail: "Folders like node_modules that have not changed in months.", target: "suggestions" },
      ];
      return wait({
        scan: info(),
        categories: cats(() => true),
        largestFiles: [...all].sort((a, b) => b.size - a.size).slice(0, 10).map((f) => row(f, m)),
        topFolders: dirs[0].dirs.map(dirRow).sort((a, b) => b.size - a.size),
        hotspots: dirs.map((d) => dirRow(d.id)).filter((d) => d.ownSize > 0).sort((a, b) => b.ownSize - a.ownSize).slice(0, 8),
        cloudBytes: 0,
        oldBytes1y: old1.reduce((s, f) => s + f.size, 0),
        oldBytes2y: old2.reduce((s, f) => s + f.size, 0),
        oldCount1y: old1.length,
        recCount: rs.length,
        recBytes: rs.reduce((s, r) => s + r.size, 0),
        downloads: { dirId: downloads, path: dirPath(downloads), bytes: dlBytes, files: count(downloads), oldBytes: dirs[downloads].files.filter((f) => NOW - files[f].modified > 180 * DAY).reduce((s, f) => s + files[f].size, 0) },
        duplicates: dupsComputed ? [dupGroups.length, dupGroups.reduce((s, g) => s + files[g[0]].size * (g.length - 1), 0)] : null,
        insights,
      });
    },
    queryFiles: (q) => {
      const { list, m } = query(q);
      const off = q.offset ?? 0;
      return wait({ total: list.length, totalBytes: list.reduce((s, f) => s + f.size, 0), offset: off, items: list.slice(off, off + (q.limit || 200)).map((f) => row(f, m)) }, 30);
    },
    listDir: (dir) => {
      if (dir == null) return wait({ dir: null, crumbs: [], dirs: [dirRow(0)], files: [], fileTotal: 0 });
      const m = masks();
      const fl = dirs[dir].files.filter((f) => !files[f].removed).map((f) => row(files[f], m)).sort((a, b) => b.size - a.size);
      return wait({ dir: dirRow(dir), crumbs: crumbs(dir), dirs: dirs[dir].dirs.filter((c) => !dirs[c].removed).map(dirRow).sort((a, b) => b.size - a.size), files: fl, fileTotal: fl.length });
    },
    tree: (dir, depth = 2) => wait({ root: tree(dir ?? 0, depth), crumbs: crumbs(dir ?? 0), roots: [dirRow(0)] }),
    recommendations: () => wait(recs()),
    fileDetail: (id) => {
      const f = files[id];
      const ext = f.name.split(".").pop()!.toLowerCase();
      const preview = ext === "pdf" ? "pdf" : ["jpg", "png", "heic"].includes(ext) ? "image" : ["mp4", "mov", "mkv"].includes(ext) ? "video" : ["mp3", "flac"].includes(ext) ? "audio" : ext === "zip" ? "archive" : ["ts", "js", "json", "md", "txt"].includes(ext) ? "text" : "none";
      const grp = dupsComputed ? dupGroups.findIndex((g) => g.includes(id)) : -1;
      return wait({ row: row(f), path: dirPath(f.dir) + "\\" + f.name, preview, canOpen: !["exe", "msi", "dll"].includes(ext), recommendations: recs().filter((r) => (r.target.kind === "file" && r.target.id === id) || (r.target.kind === "dupGroup" && r.target.id === grp)), live: { exists: !f.removed, changed: false, hardLinks: 1, onDisk: f.size }, protected: within(f.dir, 8) ? "Inside a protected system or application location (c:\\program files)." : null, duplicateGroup: grp >= 0 ? grp : null });
    },
    dirDetail: (id) => wait({ row: dirRow(id), children: dirs[id].dirs.map(dirRow).sort((a, b) => b.size - a.size).slice(0, 6), categoryBytes: cats((f) => within(f.dir, id)), recommendations: recs().filter((r) => r.target.kind === "dir" && r.target.id === id), protected: id === 0 ? "Scanned root folder." : within(id, 8) ? "Inside a protected system or application location." : null, isRoot: id === 0 }),
    startDuplicates: async () => {
      let k = 0;
      const t = setInterval(() => {
        k += 0.08;
        emit("dup-progress", { stage: k < 0.3 ? 3 : k < 0.9 ? 4 : 5, doneBytes: Math.min(1, k) * 30e9, totalBytes: 30e9, candidates: 1240 });
        if (k >= 1) { clearInterval(t); dupsComputed = true; emit("dup-finished", { cancelled: false }); }
      }, 150);
    },
    cancelDuplicates: async () => {},
    duplicates: () => {
      const m = masks();
      const groups: DupGroupView[] = dupGroups.map((g, i) => ({ id: i, size: files[g[0]].size, hash: "demo" + i, reclaimable: files[g[0]].size * (g.filter((x) => !files[x].removed).length - 1), files: g.filter((x) => !files[x].removed).map((x) => row(files[x], m)), hardlinked: [] })).filter((g) => g.files.length > 1);
      return wait({ running: false, computed: dupsComputed, finishedAt: NOW, minSize: 1024 * 1024, filesConsidered: 1240, hashedBytes: 30e9, unreadable: 0, reclaimable: groups.reduce((s, g) => s + g.reclaimable, 0), groups });
    },
    previewUrl: async () => { throw "Previews of real files are only available in the desktop app."; },
    previewText: async (id) => ({ text: files[id].name.endsWith(".json") ? '{\n  "name": "web-shop",\n  "private": true,\n  "scripts": { "dev": "vite" }\n}\n' : `// ${files[id].name}\nexport function total(items: { price: number }[]): number {\n  return items.reduce((sum, i) => sum + i.price, 0);\n}\n`, truncated: false, binary: false, encoding: "UTF-8", totalBytes: files[id].size }),
    previewArchive: async (id) => ({ format: "ZIP", entries: [{ name: "Documents/", isDir: true, size: 0, compressed: 0, encrypted: false }, { name: "Documents/report.pdf", isDir: false, size: 2_400_000, compressed: 2_100_000, encrypted: false }, { name: "Pictures/IMG_0001.jpg", isDir: false, size: 4_200_000, compressed: 4_150_000, encrypted: false }], totalEntries: 3, truncated: false, uncompressedTotal: files[id].size * 1.1, compressedTotal: files[id].size, supported: true, note: "Demo listing" }),
    openFile: async () => { throw "Opening files is only available in the desktop app."; },
    reveal: async () => { throw "Explorer integration is only available in the desktop app."; },
    reviewCleanup: async (items, mode) => {
      const checks: ItemCheck[] = items.map((it) => {
        const isF = it.kind === "file";
        const name = isF ? files[it.id].name : dirs[it.id].name;
        const sz = isF ? files[it.id].size : size(it.id);
        const prot = isF ? within(files[it.id].dir, 8) : it.id === 0 || within(it.id, 8);
        return { item: it, path: isF ? dirPath(files[it.id].dir) + "\\" + name : dirPath(it.id), name, size: sz, freeable: sz, ok: !prot, blocked: prot ? "Inside a protected system or application location." : null, warnings: !isF && dirs[it.id].name === "node_modules" ? [] : [] };
      });
      return wait({ checks, selectedBytes: checks.reduce((s, c) => s + c.size, 0), removableBytes: checks.filter((c) => c.ok).reduce((s, c) => s + c.size, 0), freeableBytes: checks.filter((c) => c.ok).reduce((s, c) => s + c.freeable, 0), blocked: checks.filter((c) => !c.ok).length, recycleAvailable: mode === "recycle" || true }, 300);
    },
    executeCleanup: async (items, mode) => {
      const outcomes: ItemOutcome[] = items.map((it) => {
        const isF = it.kind === "file";
        const prot = isF ? within(files[it.id].dir, 8) : within(it.id, 8);
        const sz = isF ? files[it.id].size : size(it.id);
        const path = isF ? dirPath(files[it.id].dir) + "\\" + files[it.id].name : dirPath(it.id);
        if (prot) return { item: it, path, size: sz, freed: 0, status: "skipped", error: "Protected location." };
        if (isF) files[it.id].removed = true; else dirs[it.id].removed = true;
        return { item: it, path, size: sz, freed: mode === "permanent" ? sz : 0, status: mode === "recycle" ? "recycled" : "deleted", error: null };
      });
      memo = new Map();
      const ok = outcomes.filter((o) => o.status === "recycled" || o.status === "deleted");
      const run: CleanupRun = { id: cleanups.length + 1, at: Math.floor(Date.now() / 1000), mode, requested: items.length, succeeded: ok.length, failed: 0, skipped: outcomes.length - ok.length, bytesRemoved: ok.reduce((s, o) => s + o.size, 0), bytesFreed: ok.reduce((s, o) => s + o.freed, 0), items: outcomes.map((o) => ({ path: o.path, size: o.size, status: o.status, error: o.error })) };
      cleanups.unshift(run);
      return wait({ runId: run.id, mode, outcomes, succeeded: ok.length, failed: 0, skipped: run.skipped, bytesRemoved: run.bytesRemoved, bytesFreed: run.bytesFreed }, 700);
    },
    history: () => wait({ scans, cleanups }),
    scanIssues: () => wait([{ path: "C:\\System Volume Information", message: "Access is denied. (os error 5)" }, { path: "C:\\Users\\Alex\\AppData\\Local\\Packages\\Locked", message: "Access is denied. (os error 5)" }]),
    pickFolder: async () => "D:\\Projects",
    timelineRoots: () => timeline.roots(),
    timelineSeries: (root, since) => timeline.series(root, since),
    timelineCompare: (root, from, to) => timeline.compare(root, from, to),
    ...demoFeatures({ files: () => files, dirPath, within, row: (f) => row(f as DFile) }),
    ...demoOrganizer({ files: () => files, dirPath }),
    locatePath: async (path) => {
      const p = path.toLowerCase().replace(/\\$/, "");
      const d = dirs.find((x) => !x.removed && dirPath(x.id).toLowerCase().replace(/\\$/, "") === p);
      if (d) return { kind: "dir", id: d.id };
      const f = files.find((x) => !x.removed && `${dirPath(x.dir)}\\${x.name}`.toLowerCase() === p);
      return f ? { kind: "file", id: f.id } : null;
    },
    onScanProgress: on("scan-progress"),
    onScanFinished: on("scan-finished"),
    onDupProgress: on("dup-progress"),
    onDupFinished: on("dup-finished"),
    window: { minimize() {}, toggleMaximize() {}, close() {}, startDragging() {} },
  };
  // Silence "assigned but never used" for rebuild support.
  void ((x: unknown) => ({ dirs, files, downloads } = x as never));
}
