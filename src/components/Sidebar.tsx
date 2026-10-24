import clsx from "clsx";
import { Images, ArrowDownToLine, CopyCheck, FolderTree, History, LayoutGrid, Lightbulb, Maximize2, RefreshCw, Settings, Hourglass, PieChart, HardDrive, Usb, Network } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { bytes } from "../lib/format";
import { useApp, type View } from "../store/app";
import { Meter } from "./ui";

interface Item {
  view: View;
  label: string;
  icon: ReactNode;
  key?: string;
}

const GROUPS: { title?: string; items: Item[] }[] = [
  {
    title: "Understand",
    items: [
      { view: "overview", label: "Overview", icon: <LayoutGrid size={15} />, key: "1" },
      { view: "analysis", label: "Storage Analysis", icon: <PieChart size={15} />, key: "2" },
      { view: "media", label: "Media", icon: <Images size={15} />, key: "9" },
      { view: "explorer", label: "File Explorer", icon: <FolderTree size={15} />, key: "3" },
    ],
  },
  {
    title: "Review",
    items: [
      { view: "suggestions", label: "Suggestions", icon: <Lightbulb size={15} />, key: "4" },
      { view: "old", label: "Old & Unused Files", icon: <Hourglass size={15} />, key: "5" },
      { view: "large", label: "Large Files", icon: <Maximize2 size={15} />, key: "6" },
      { view: "duplicates", label: "Duplicates", icon: <CopyCheck size={15} />, key: "7" },
      { view: "downloads", label: "Downloads", icon: <ArrowDownToLine size={15} />, key: "8" },
    ],
  },
  {
    items: [
      { view: "history", label: "Cleanup History", icon: <History size={15} /> },
      { view: "settings", label: "Settings", icon: <Settings size={15} />, key: "," },
    ],
  },
];

export function Sidebar() {
  const view = useApp((s) => s.view);
  const go = useApp((s) => s.go);
  const drives = useApp((s) => s.drives);
  const scan = useApp((s) => s.scan);
  const scanning = useApp((s) => s.scanning);
  const showSetup = useApp((s) => s.showScanSetup);
  const set = useApp((s) => s.set);
  const counts = useApp((s) => s.navCounts);

  return (
    <nav className="glass edge-light flex w-[232px] shrink-0 flex-col py-3">
      <div className="scroll flex-1 px-2.5">
        {GROUPS.map((g, gi) => (
          <div key={gi} className={clsx(gi > 0 && "mt-4")}>
            {g.title && <div className="px-2.5 pb-1.5 text-2xs font-semibold uppercase tracking-[0.12em] text-fg-4">{g.title}</div>}
            {g.items.map((it) => {
              const active = view === it.view && !showSetup;
              const count = counts?.[it.view];
              return (
                <button
                  key={it.view}
                  onClick={() => go(it.view)}
                  title={it.key ? `${it.label}  (Ctrl+${it.key})` : it.label}
                  className={clsx("group relative flex h-8 w-full items-center gap-2.5 rounded-[8px] px-2.5 text-sm transition-colors", active ? "text-fg" : "text-fg-2 hover:bg-hover hover:text-fg")}
                >
                  {active && (
                    <motion.span
                      layoutId="nav-active"
                      className="absolute inset-0 rounded-[8px] bg-active shadow-[0_0_0_1px_var(--line),0_1px_0_var(--sheen)_inset]"
                      transition={{ type: "spring", stiffness: 500, damping: 38 }}
                    />
                  )}
                  <span className={clsx("relative transition-colors", active ? "text-accent" : "text-fg-3 group-hover:text-fg-2")}>{it.icon}</span>
                  <span className="relative flex-1 text-left font-[450]">{it.label}</span>
                  {count != null && count > 0 && (it.view === "analysis" ? <span className="tabular relative rounded-full bg-accent px-1.5 text-2xs font-semibold text-[var(--on-accent)]" title="New watchlist alerts">{count}</span> : <span className="tabular relative text-2xs text-fg-4">{count}</span>)}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="mx-2.5 mt-3 border-t hairline pt-3">
        <div className="flex items-center justify-between px-2.5 pb-2">
          <span className="text-2xs font-semibold uppercase tracking-[0.12em] text-fg-4">Drives</span>
        </div>
        <div className="space-y-0.5">
          {drives.map((d) => {
            const used = d.total - d.free;
            const scanned = scan?.roots.some((r) => r.path.toUpperCase().startsWith(d.mount.toUpperCase()));
            const Icon = d.kind === "removable" ? Usb : d.kind === "network" ? Network : HardDrive;
            return (
              <div key={d.mount} className="rounded-[8px] px-2.5 py-1.5" title={`${d.label || "Local Disk"} (${d.mount}) · ${d.fileSystem} · ${bytes(d.free)} free of ${bytes(d.total)}`}>
                <div className="flex items-center gap-2 text-xs">
                  <Icon size={13} className={scanned ? "text-accent" : "text-fg-3"} />
                  <span className="font-medium text-fg-2">{d.mount.replace("\\", "")}</span>
                  <span className="truncate text-fg-3">{d.label || "Local Disk"}</span>
                  <span className="tabular ml-auto text-2xs text-fg-4">{bytes(d.free)} free</span>
                </div>
                <Meter value={used} max={d.total} className="mt-1.5" color={used / d.total > 0.9 ? "var(--warn)" : scanned ? "var(--accent)" : "var(--fg-4)"} />
              </div>
            );
          })}
        </div>
        <button
          disabled={scanning}
          onClick={() => set({ showScanSetup: true })}
          className="mt-2 flex h-8 w-full items-center justify-center gap-2 rounded-[8px] text-xs font-medium text-fg-2 shadow-[0_0_0_1px_var(--line-2)] transition-colors hover:bg-hover hover:text-fg disabled:opacity-40"
        >
          <RefreshCw size={13} className={scanning ? "spin" : ""} />
          {scanning ? "Scanning…" : scan ? "New scan" : "Choose what to scan"}
        </button>
      </div>
    </nav>
  );
}
