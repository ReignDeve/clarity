import clsx from "clsx";
import { ArrowRight, Check, FolderPlus, HardDrive, Lock, MousePointerClick, Network, ScanSearch, ShieldCheck, Usb, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { api, errorText } from "../lib/api";
import { bytes, duration, num } from "../lib/format";
import { useApp } from "../store/app";
import { Logo } from "./TitleBar";
import { Button, IconButton, Toggle } from "./ui";

export async function startScan(roots: string[]) {
  const st = useApp.getState();
  try {
    st.set({ scanning: true, progress: null, scanRoots: roots, showScanSetup: false, inspector: null });
    if (st.settings && !st.settings.onboarded) {
      const s = await api().saveSettings({ ...st.settings, onboarded: true });
      st.set({ settings: s });
    }
    await api().startScan(roots);
  } catch (e) {
    st.set({ scanning: false });
    st.toast(errorText(e), "error");
  }
}

/** First-launch welcome. */
export function Onboarding() {
  const [step, setStep] = useState(0);
  return (
    <div className="flex h-full items-center justify-center p-8">
      <AnimatePresence mode="wait">
        {step === 0 ? (
          <motion.div key="welcome" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="glass-float edge-light w-full max-w-[640px] p-10">
            <Logo size={34} />
            <h1 className="mt-6 text-[28px] font-semibold leading-tight tracking-tight">
              Understand your storage.
              <br />
              <span className="text-fg-3">Decide what stays. Reclaim your space.</span>
            </h1>
            <p className="mt-4 max-w-[480px] text-base text-fg-2">CLARITY shows you what fills your drives, which files have not changed in a long time, and which ones exist more than once. Then you decide.</p>
            <div className="mt-8 grid grid-cols-3 gap-3">
              <Principle icon={<Lock size={16} />} title="Stays on this PC">
                No account, no cloud, no telemetry. File names never leave your computer.
              </Principle>
              <Principle icon={<ScanSearch size={16} />} title="Scanning is read-only">
                A scan only reads metadata. It never moves or deletes anything.
              </Principle>
              <Principle icon={<MousePointerClick size={16} />} title="You decide">
                Nothing is removed without your review, and it goes to the Recycle Bin by default.
              </Principle>
            </div>
            <div className="mt-9 flex justify-end">
              <Button tone="primary" icon={<ArrowRight size={14} />} onClick={() => setStep(1)}>
                Choose what to scan
              </Button>
            </div>
          </motion.div>
        ) : (
          <motion.div key="setup" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-[720px]">
            <ScanSetup />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Principle({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[10px] bg-[var(--glass-0)] p-4 shadow-[0_0_0_1px_var(--line)]">
      <div className="text-accent">{icon}</div>
      <div className="mt-2.5 text-sm font-semibold">{title}</div>
      <p className="mt-1 text-xs leading-relaxed text-fg-3">{children}</p>
    </div>
  );
}

export function ScanSetup({ onCancel }: { onCancel?: () => void }) {
  const drives = useApp((s) => s.drives);
  const info = useApp((s) => s.info);
  const settings = useApp((s) => s.settings);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(settings?.lastRoots?.length ? settings.lastRoots : drives.filter((d) => d.kind === "fixed").slice(0, 1).map((d) => d.mount)));
  const [custom, setCustom] = useState<string[]>(() => (settings?.lastRoots ?? []).filter((r) => !drives.some((d) => d.mount === r)));

  const toggle = (p: string) => {
    const n = new Set(picked);
    if (n.has(p)) n.delete(p);
    else n.add(p);
    setPicked(n);
  };
  const addFolder = async () => {
    const p = await api().pickFolder();
    if (!p) return;
    if (!custom.includes(p)) setCustom([...custom, p]);
    setPicked(new Set(picked).add(p));
  };
  const quick = [info?.homePath && { path: info.homePath, label: "Your user folder" }, info?.downloadsPath && { path: info.downloadsPath, label: "Downloads" }].filter(Boolean) as { path: string; label: string }[];
  const folders = [...quick.filter((q) => !custom.includes(q.path)), ...custom.map((c) => ({ path: c, label: "" }))];

  return (
    <div className="glass-float edge-light w-full p-7">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">What should CLARITY look at?</h2>
          <p className="mt-1 text-sm text-fg-3">Pick whole drives for the full picture, or single folders for a quick look.</p>
        </div>
        {onCancel && (
          <IconButton label="Close" onClick={onCancel}>
            <X size={15} />
          </IconButton>
        )}
      </div>

      <div className="mt-5 grid grid-cols-2 gap-2.5">
        {drives.map((d) => {
          const used = d.total - d.free;
          const on = picked.has(d.mount);
          const Icon = d.kind === "removable" ? Usb : d.kind === "network" ? Network : HardDrive;
          return (
            <button key={d.mount} onClick={() => toggle(d.mount)} className={clsx("flex items-center gap-3.5 rounded-[11px] p-3.5 text-left transition-all", on ? "bg-accent-soft shadow-[0_0_0_1.5px_var(--accent-line)]" : "bg-[var(--glass-0)] shadow-[0_0_0_1px_var(--line)] hover:bg-hover")}>
              <UsageRing used={used} total={d.total} on={on} icon={<Icon size={15} />} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {d.label || "Local Disk"} <span className="text-fg-3">({d.mount.replace("\\", "")})</span>
                </div>
                <div className="tabular mt-0.5 text-xs text-fg-3">
                  {bytes(used)} used of {bytes(d.total)} · {d.fileSystem || d.kind}
                </div>
              </div>
              <Tick on={on} />
            </button>
          );
        })}
      </div>

      <div className="mt-5 text-2xs font-semibold uppercase tracking-[0.1em] text-fg-4">Folders</div>
      <div className="mt-2 space-y-1.5">
        {folders.map((f) => (
          <button key={f.path} onClick={() => toggle(f.path)} className={clsx("flex h-10 w-full items-center gap-3 rounded-[9px] px-3 text-left transition-all", picked.has(f.path) ? "bg-accent-soft shadow-[0_0_0_1.5px_var(--accent-line)]" : "bg-[var(--glass-0)] shadow-[0_0_0_1px_var(--line)] hover:bg-hover")}>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-2">{f.path}</span>
            {f.label && <span className="text-xs text-fg-3">{f.label}</span>}
            <Tick on={picked.has(f.path)} />
          </button>
        ))}
        <button onClick={addFolder} className="flex h-10 w-full items-center gap-2 rounded-[9px] px-3 text-sm text-fg-2 shadow-[0_0_0_1px_var(--line)] [border-style:dashed] hover:bg-hover hover:text-fg">
          <FolderPlus size={15} /> Add a folder…
        </button>
      </div>

      {(info?.onedrivePaths ?? []).length > 0 && settings && (
        <div className="mt-5 flex items-center justify-between gap-4 rounded-[10px] bg-[var(--glass-0)] px-4 py-3 shadow-[0_0_0_1px_var(--line)]">
          <div className="min-w-0">
            <div className="text-sm font-medium">Skip OneDrive</div>
            <div className="truncate text-xs text-fg-3" title={info!.onedrivePaths.join(", ")}>
              Leaves out {info!.onedrivePaths.join(", ")}. Synced files are often cloud-only, and removing them deletes them everywhere.
            </div>
          </div>
          <Toggle
            label="Skip OneDrive"
            checked={info!.onedrivePaths.every((p) => settings.exclusions.some((e) => e.toLowerCase() === p.toLowerCase()))}
            onChange={async (on) => {
              const od = info!.onedrivePaths.map((p) => p.toLowerCase());
              const rest = settings.exclusions.filter((e) => !od.includes(e.toLowerCase()));
              const next = { ...settings, exclusions: on ? [...rest, ...info!.onedrivePaths] : rest };
              useApp.getState().set({ settings: next });
              useApp.getState().set({ settings: await api().saveSettings(next) });
            }}
          />
        </div>
      )}

      <div className="mt-6 flex items-center justify-between gap-4">
        <p className="flex items-center gap-2 text-xs text-fg-3">
          <ShieldCheck size={14} className="shrink-0 text-ok" />
          {settings?.skipSystem ? "Windows system folders are skipped." : "System folders are included but always protected."}
          {settings?.exclusions.length ? ` ${settings.exclusions.length} excluded folder(s).` : ""} Nothing is changed during a scan.
        </p>
        <Button tone="primary" disabled={picked.size === 0} icon={<ScanSearch size={14} />} onClick={() => startScan([...picked])}>
          Start scan
        </Button>
      </div>
    </div>
  );
}

function Tick({ on }: { on: boolean }) {
  return <span className={clsx("flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full transition-all", on ? "bg-accent text-[var(--on-accent)]" : "shadow-[0_0_0_1.2px_var(--fg-4)]")}>{on && <Check size={11} strokeWidth={3} />}</span>;
}

function UsageRing({ used, total, on, icon }: { used: number; total: number; on: boolean; icon: React.ReactNode }) {
  const r = 17;
  const c = 2 * Math.PI * r;
  const pct = total ? used / total : 0;
  return (
    <div className="relative h-11 w-11 shrink-0">
      <svg viewBox="0 0 44 44" className="h-full w-full -rotate-90">
        <circle cx="22" cy="22" r={r} fill="none" stroke="var(--line-2)" strokeWidth="3.5" />
        <circle cx="22" cy="22" r={r} fill="none" stroke={pct > 0.9 ? "var(--warn)" : on ? "var(--accent)" : "var(--fg-3)"} strokeWidth="3.5" strokeLinecap="round" strokeDasharray={`${c * pct} ${c}`} className="transition-all duration-500" />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-fg-2">{icon}</span>
    </div>
  );
}

export function ScanProgressView() {
  const p = useApp((s) => s.progress);
  const roots = useApp((s) => s.scanRoots);
  const drives = useApp((s) => s.drives);
  const [cancelling, setCancelling] = useState(false);
  // A reference point only: for whole-drive scans, the drive's used space.
  const driveRoots = roots.map((r) => drives.find((d) => d.mount.toLowerCase() === r.toLowerCase())).filter(Boolean);
  const reference = driveRoots.length === roots.length && roots.length > 0 ? driveRoots.reduce((s, d) => s + (d!.total - d!.free), 0) : null;

  return (
    <div className="flex h-full items-center justify-center p-8">
      <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} className="glass-float edge-light w-full max-w-[620px] p-8">
        <div className="flex items-center gap-5">
          <ScanLens />
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-semibold tracking-tight">Reading your storage…</h2>
            <p className="mt-0.5 truncate text-sm text-fg-3">{roots.join(", ")}</p>
          </div>
        </div>
        <div className="mt-7 grid grid-cols-4 gap-px overflow-hidden rounded-[11px] bg-[var(--line)] shadow-[0_0_0_1px_var(--line)]">
          <Counter label="Files" value={num(p?.files ?? 0)} />
          <Counter label="Folders" value={num(p?.dirs ?? 0)} />
          <Counter label="Data found" value={bytes(p?.bytes ?? 0)} />
          <Counter label="Elapsed" value={duration(p?.elapsedMs ?? 0)} />
        </div>
        <div className="mt-5 h-[3px] overflow-hidden rounded-full bg-active">
          <div className="shimmer h-full w-full" />
        </div>
        <div className="mt-3 flex items-center justify-between gap-4 text-xs text-fg-3">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{p?.current || "Starting…"}</span>
          {reference != null && (
            <span className="tabular shrink-0" title="Used space reported by Windows. Excluded and inaccessible folders mean a scan may finish below this.">
              Drive reports {bytes(reference)} in use
            </span>
          )}
        </div>
        <div className="mt-6 flex items-center justify-between">
          <span className="text-xs text-fg-4">{p && p.errors > 0 ? `${num(p.errors)} items could not be read (usually protected by Windows)` : "Read-only. You can keep using your PC."}</span>
          <Button
            tone="ghost"
            disabled={cancelling}
            onClick={() => {
              setCancelling(true);
              void api().cancelScan();
            }}
          >
            {cancelling ? "Stopping…" : "Cancel scan"}
          </Button>
        </div>
      </motion.div>
    </div>
  );
}

function Counter({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[var(--glass-solid)] px-4 py-3.5">
      <div className="tabular text-lg font-semibold tracking-tight">{value}</div>
      <div className="text-2xs uppercase tracking-[0.1em] text-fg-4">{label}</div>
    </div>
  );
}

function ScanLens() {
  return (
    <div className="relative h-14 w-14 shrink-0">
      <svg viewBox="0 0 56 56" className="h-full w-full">
        <circle cx="28" cy="28" r="22" fill="none" stroke="var(--line-2)" strokeWidth="4" />
        <g className="spin" style={{ transformOrigin: "28px 28px", animationDuration: "1.8s" }}>
          <circle cx="28" cy="28" r="22" fill="none" stroke="var(--accent)" strokeWidth="4" strokeLinecap="round" strokeDasharray="34 140" />
          <circle cx="28" cy="28" r="22" fill="none" stroke="var(--violet)" strokeWidth="4" strokeLinecap="round" strokeDasharray="14 140" strokeDashoffset="-44" />
        </g>
      </svg>
    </div>
  );
}
