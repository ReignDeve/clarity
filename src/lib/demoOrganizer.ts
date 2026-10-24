// Browser demo of the Smart Folder Organizer (DEMO DATA only). The desktop
// app analyses and moves real files in Rust (organizer.rs).

import type { Backend } from "./api";
import type { Category, OrganizePlan, OrganizeRun, PlanFile } from "./types";
import type { DemoFile } from "./demoFeatures";

const TOP: Record<Category, string> = { documents: "Documents", images: "Images", video: "Videos", audio: "Audio", archives: "Archives", installers: "Installers", code: "Code & data", apps: "Installers", system: "Other", other: "Other" };

export function demoOrganizer(ctx: { files: () => DemoFile[]; dirPath: (d: number) => string }): Pick<Backend, "organizeAnalyze" | "organizeConflicts" | "organizeApply" | "organizeCancel" | "organizeRuns" | "organizeUndo" | "onOrganizeProgress" | "onOrganizeFinished"> {
  const runs: OrganizeRun[] = [];
  const listeners: { p: ((x: { done: number; total: number; current: string }) => void)[]; f: ((x: { ok?: OrganizeRun; error?: string }) => void)[] } = { p: [], f: [] };
  let cancel = false;
  const inFolder = (root: string) => ctx.files().filter((f) => !f.removed && ctx.dirPath(f.dir).toLowerCase() === root.toLowerCase().replace(/\\$/, ""));

  return {
    organizeAnalyze: async (root, o) => {
      const files = inFolder(root);
      const pf: PlanFile[] = files.map((f, i) => {
        const ext = f.name.split(".").pop()!.toLowerCase();
        let dest = TOP[f.cat];
        let reason = `${dest.replace(/s$/, "")} file (.${ext})`;
        if (o.mode === "date") {
          const d = new Date(f.modified * 1000);
          dest = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")} ${d.toLocaleString("en", { month: "long", timeZone: "UTC" })}`;
          reason = `Modified ${d.toLocaleString("en", { month: "long", year: "numeric", timeZone: "UTC" })}`;
        } else if (o.mode === "smart" && f.cat === "documents" && ext === "pdf") dest = "Documents/PDFs";
        else if (o.mode === "smart" && f.cat === "images" && f.name.startsWith("IMG")) (dest = "Images/Photos"), (reason = "Photo (camera file name or format)");
        else if (o.mode === "custom") {
          const r = o.rules.find((r) => r.field === "ext" && r.value.split(/[ ,]/).some((x) => x.replace(".", "") === ext));
          dest = r ? r.dest : o.fallback === "smart" ? dest : "";
          reason = r ? `Rule: ext “${r.value}”` : "No rule matched";
        }
        return { id: i, name: f.name, size: f.size, modified: f.modified, created: f.created, category: f.cat, dest, reason, group: null, conflict: f.name.startsWith("Contract") ? "A file named “Contract_signed.pdf” already exists in Documents/PDFs." : null };
      });
      const counts = new Map<string, number>();
      for (const f of pf) if (f.dest) counts.set(f.dest.split("/")[0], (counts.get(f.dest.split("/")[0]) ?? 0) + 1);
      for (const f of pf) if (f.dest && (counts.get(f.dest.split("/")[0]) ?? 0) < o.minGroup && o.mode !== "custom") (f.dest = ""), (f.reason = "Too few similar files to justify a new folder");
      const folders = new Map<string, { files: number; bytes: number }>();
      for (const f of pf.filter((f) => f.dest)) {
        const e = folders.get(f.dest) ?? { files: 0, bytes: 0 };
        e.files++;
        e.bytes += f.size;
        folders.set(f.dest, e);
      }
      const plan: OrganizePlan = {
        root,
        mode: o.mode,
        files: pf,
        folders: [...folders.entries()].sort().map(([path, v]) => ({ path, ...v, exists: path === "Documents" })),
        skipped: [{ name: "movie.mp4.crdownload", reason: "Unfinished download or temporary file." }],
        existingSubfolders: ["Documents", "Old stuff"],
        moving: pf.filter((f) => f.dest).length,
        staying: pf.filter((f) => !f.dest).length,
        conflicts: pf.filter((f) => f.conflict).length,
      };
      return plan;
    },
    organizeConflicts: async (_root, files) => files.map((f) => ({ id: f.id, conflict: f.name.startsWith("Contract") && f.dest ? `A file named “${f.name}” already exists in ${f.dest}.` : null, suggestion: f.name.startsWith("Contract") ? f.name.replace(/(\.\w+)$/, " (2)$1") : null })),
    organizeApply: async (root, mode, items) => {
      cancel = false;
      let i = 0;
      const t = setInterval(() => {
        i = Math.min(items.length, i + Math.max(1, Math.ceil(items.length / 12)));
        listeners.p.forEach((cb) => cb({ done: i, total: items.length, current: items[Math.min(i, items.length - 1)]?.name ?? "" }));
        if (i >= items.length || cancel) {
          clearInterval(t);
          const done = items.slice(0, i);
          const run: OrganizeRun = { runId: runs.length + 1, root, mode, at: Math.floor(Date.now() / 1000), moved: done.length, skipped: items.length - done.length, failed: 0, bytes: done.reduce((s, x) => s + x.size, 0), cancelled: cancel, foldersCreated: new Set(done.map((x) => x.dest)).size, items: done.map((x) => ({ name: x.name, from: `${root}\\${x.name}`, to: `${root}\\${x.dest.replace(/\//g, "\\")}\\${x.renameTo ?? x.name}`, size: x.size, status: "moved", error: null })), undoneAt: null, restored: 0, kept: 0, canUndo: true };
          runs.unshift(run);
          listeners.f.forEach((cb) => cb({ ok: run }));
        }
      }, 140);
    },
    organizeCancel: async () => void (cancel = true),
    organizeRuns: async () => runs,
    organizeUndo: async (id) => {
      const r = runs.find((x) => x.runId === id)!;
      r.undoneAt = Math.floor(Date.now() / 1000);
      r.restored = r.items.length;
      r.canUndo = false;
      r.items = r.items.map((x) => ({ ...x, status: "restored" }));
      return r;
    },
    onOrganizeProgress: async (cb) => (listeners.p.push(cb), () => (listeners.p = listeners.p.filter((x) => x !== cb))),
    onOrganizeFinished: async (cb) => (listeners.f.push(cb), () => (listeners.f = listeners.f.filter((x) => x !== cb))),
  };
}
