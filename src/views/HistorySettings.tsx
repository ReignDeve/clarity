import clsx from "clsx";
import { Wand2, FolderInput, ChevronDown, FolderPlus, History as HistoryIcon, Lock, ScanSearch, Trash2, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { Badge, Button, Empty, IconButton, Panel, Segmented, Spinner, Toggle } from "../components/ui";
import { api, errorText } from "../lib/api";
import { bytes, dateTime, duration, num } from "../lib/format";
import type { History as H, OrganizeRun, ScanIssue, Settings as S } from "../lib/types";
import { useApp } from "../store/app";
import { ViewHeader } from "./Lists";
import { ResultModal } from "./Organizer";
import { checkForUpdates, download, installAndRestart } from "../lib/updates";
import { isNative } from "../lib/api";

export function History() {
  const version = useApp((s) => s.version);
  const [data, setData] = useState<H | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    api().history().then(setData);
  }, [version]);
  if (!data)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader title="Cleanup History">Everything CLARITY has removed, and every scan. Only confirmed removals are counted.</ViewHeader>
      <div className="grid min-h-0 flex-1 grid-cols-[1fr_380px] gap-3 pb-6">
        <Panel title="Cleanups" pad={false}>
          <div className="scroll h-full px-2 pb-2">
            {data.cleanups.length === 0 && <Empty icon={<HistoryIcon size={18} />} title="No cleanups yet">When you remove files with CLARITY, a record of each item appears here.</Empty>}
            {data.cleanups.map((c) => (
              <div key={c.id} className="rounded-[9px] hover:bg-hover">
                <button onClick={() => setOpen(open === c.id ? null : c.id)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left">
                  {c.mode === "move" ? <FolderInput size={15} className="text-accent" /> : c.mode === "recycle" ? <Trash2 size={15} className="text-fg-3" /> : <Trash2 size={15} className="text-danger" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm">
                      {num(c.succeeded)} item{c.succeeded === 1 ? "" : "s"} {c.mode === "move" ? "moved to another folder" : c.mode === "recycle" ? "moved to Recycle Bin" : "deleted permanently"}
                    </div>
                    <div className="text-2xs text-fg-4">{dateTime(c.at)}</div>
                  </div>
                  {c.failed + c.skipped > 0 && <Badge tone="warn">{c.failed + c.skipped} not removed</Badge>}
                  <span className="tabular text-sm font-medium">{bytes(c.bytesRemoved)}</span>
                  <ChevronDown size={14} className={clsx("text-fg-4 transition-transform", open === c.id && "rotate-180")} />
                </button>
                <AnimatePresence>
                  {open === c.id && (
                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                      <div className="mx-3 mb-3 rounded-[8px] shadow-[0_0_0_1px_var(--line)]">
                        {c.items.map((it, i) => (
                          <div key={i} className="flex items-center gap-3 border-b hairline px-3 py-1.5 text-xs last:border-0">
                            <Badge tone={it.status === "failed" ? "danger" : it.status === "skipped" ? "warn" : "ok"}>{it.status}</Badge>
                            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-2" title={it.error ?? it.path}>
                              {it.path}
                            </span>
                            <span className="tabular text-fg-3">{bytes(it.size)}</span>
                          </div>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            ))}
          </div>
        </Panel>
        <div className="flex min-h-0 flex-col gap-3">
        <OrganizeRuns />
        <Panel title="Scans" pad={false} className="min-h-0 flex-1">
          <div className="scroll h-full px-2 pb-2">
            {data.scans.map((s) => (
              <div key={s.id} className="flex items-center gap-3 rounded-[8px] px-3 py-2 hover:bg-hover">
                <ScanSearch size={14} className="shrink-0 text-fg-3" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{s.roots.join(", ")}</div>
                  <div className="text-2xs text-fg-4">
                    {dateTime(s.startedAt)} · {duration(s.durationMs)} · {num(s.files)} files{s.cancelled ? " · cancelled" : ""}
                  </div>
                </div>
                <span className="tabular text-xs text-fg-2">{bytes(s.bytes)}</span>
              </div>
            ))}
          </div>
        </Panel>
        </div>
      </div>
    </div>
  );
}

export function Settings() {
  const settings = useApp((s) => s.settings);
  const info = useApp((s) => s.info);
  const set = useApp((s) => s.set);
  const toast = useApp((s) => s.toast);
  const [issues, setIssues] = useState<ScanIssue[] | null>(null);
  if (!settings) return null;

  const save = async (patch: Partial<S>) => {
    const next = { ...settings, ...patch };
    set({ settings: next });
    try {
      const saved = await api().saveSettings(next);
      set({ settings: saved });
      useApp.getState().bump();
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  const addExclusion = async () => {
    const p = await api().pickFolder();
    if (p && !settings.exclusions.includes(p)) await save({ exclusions: [...settings.exclusions, p] });
  };

  return (
    <div className="scroll -mx-1 h-full px-1 pb-10">
      <ViewHeader title="Settings" />
      <div className="grid max-w-[920px] grid-cols-1 gap-3">
        <Panel title="Appearance">
          <Row label="Theme" hint="Follows Windows by default.">
            <Segmented value={settings.theme} onChange={(theme) => save({ theme })} options={[{ value: "system", label: "System" }, { value: "dark", label: "Dark" }, { value: "light", label: "Light" }]} size="sm" />
          </Row>
          <Row label="Motion" hint="Reduced motion keeps transitions short and still.">
            <Segmented value={settings.motion} onChange={(motion) => save({ motion })} options={[{ value: "system", label: "System" }, { value: "reduced", label: "Reduced" }, { value: "full", label: "Full" }]} size="sm" />
          </Row>
        </Panel>

        <Panel title="Review rules">
          <Row label="“Old” means unchanged for" hint="Used by suggestions and the overview.">
            <Segmented value={settings.oldDays} onChange={(oldDays) => save({ oldDays })} options={[{ value: 182, label: "6 months" }, { value: 365, label: "1 year" }, { value: 730, label: "2 years" }]} size="sm" />
          </Row>
          <Row label="“Large” means at least" hint="Threshold for the large & unchanged rule.">
            <Segmented value={settings.largeMb} onChange={(largeMb) => save({ largeMb })} options={[{ value: 100, label: "100 MB" }, { value: 500, label: "500 MB" }, { value: 1024, label: "1 GB" }, { value: 5120, label: "5 GB" }]} size="sm" />
          </Row>
          <Row label="Duplicate search ignores files under" hint="Smaller files rarely matter and slow the search down.">
            <Segmented value={settings.dupMinKb} onChange={(dupMinKb) => save({ dupMinKb })} options={[{ value: 1024, label: "1 MB" }, { value: 10240, label: "10 MB" }, { value: 102400, label: "100 MB" }, { value: 1048576, label: "1 GB" }]} size="sm" />
          </Row>
          <Row label="Show hidden & system files in lists">
            <Toggle checked={settings.showHidden} onChange={(showHidden) => save({ showHidden })} label="Show hidden files" />
          </Row>
        </Panel>

        <Panel title="Scanning">
          <Row label="Skip Windows system folders" hint="\Windows, $Recycle.Bin, System Volume Information, Recovery. They are protected from cleanup either way.">
            <Toggle checked={settings.skipSystem} onChange={(skipSystem) => save({ skipSystem })} label="Skip system folders" />
          </Row>
          <div className="py-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm">Excluded folders</div>
                <div className="text-xs text-fg-3">Never scanned, never suggested, never removed. Applies from the next scan.</div>
              </div>
              <Button size="sm" icon={<FolderPlus size={13} />} onClick={addExclusion}>
                Add folder
              </Button>
            </div>
            <div className="mt-2 space-y-1">
              {settings.exclusions.length === 0 && <div className="text-xs text-fg-4">No exclusions.</div>}
              {settings.exclusions.map((e) => (
                <div key={e} className="flex h-8 items-center gap-2 rounded-[7px] bg-hover px-3">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-2">{e}</span>
                  <IconButton label="Remove exclusion" onClick={() => save({ exclusions: settings.exclusions.filter((x) => x !== e) })}>
                    <X size={13} />
                  </IconButton>
                </div>
              ))}
            </div>
          </div>
          <Row label="Last scan problems" hint="Folders Windows did not let CLARITY read.">
            <Button size="sm" onClick={() => api().scanIssues().then(setIssues)}>
              Show
            </Button>
          </Row>
          {issues && (
            <div className="scroll mb-2 max-h-56 rounded-[8px] shadow-[0_0_0_1px_var(--line)]">
              {issues.length === 0 && <div className="p-3 text-xs text-fg-3">No problems recorded.</div>}
              {issues.map((i, k) => (
                <div key={k} className="border-b hairline px-3 py-1.5 text-xs last:border-0">
                  <div className="truncate font-mono text-[11px] text-fg-2">{i.path}</div>
                  <div className="text-fg-4">{i.message}</div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <UpdatesPanel save={save} />

        <Panel title="Timestamps on this PC">
          <p className="text-sm text-fg-2">{info?.lastAccess.explanation}</p>
          <p className="mt-2 text-xs text-fg-3">CLARITY therefore bases its suggestions on modification dates only, and never claims a file has not been opened for a certain time.</p>
        </Panel>

        <Panel title="Privacy & safety">
          <ul className="space-y-2 text-sm text-fg-2">
            <Bullet>Everything happens on this PC. CLARITY has no account, no telemetry, no network features.</Bullet>
            <Bullet>Scans only read metadata. File contents are read only to preview a file you select or to compare duplicates.</Bullet>
            <Bullet>Removals go to the Windows Recycle Bin by default. Permanent deletion always needs a second confirmation.</Bullet>
            <Bullet>Before removing anything, CLARITY checks again that the item still matches the scan, lies inside a folder you scanned, is not reached through a link, and is not in a protected Windows or application location.</Bullet>
          </ul>
          <div className="mt-4 flex items-center justify-between border-t hairline pt-3 text-xs text-fg-3">
            <span>
              CLARITY {info?.version}
              {api().demo && " · demo mode"}
            </span>
            <Button size="sm" tone="ghost" onClick={() => save({ onboarded: false }).then(() => location.reload())}>
              Show welcome again
            </Button>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b hairline py-3 last:border-0">
      <div>
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-fg-3">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Bullet({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <Lock size={13} className="mt-1 shrink-0 text-ok" />
      <span>{children}</span>
    </li>
  );
}

function OrganizeRuns() {
  const version = useApp((s) => s.version);
  const [runs, setRuns] = useState<OrganizeRun[] | null>(null);
  const [open, setOpen] = useState<OrganizeRun | null>(null);
  useEffect(() => {
    api().organizeRuns().then(setRuns, () => setRuns([]));
  }, [version]);
  if (!runs?.length) return null;
  return (
    <Panel title="Organized folders" pad={false} className="max-h-[45%]">
      <div className="scroll h-full px-2 pb-2">
        {runs.map((r) => (
          <button key={r.runId} onClick={() => setOpen(r)} className="flex w-full items-center gap-3 rounded-[8px] px-3 py-2 text-left hover:bg-hover">
            <Wand2 size={14} className={r.undoneAt ? "shrink-0 text-fg-4" : "shrink-0 text-accent"} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{r.root.split("\\").filter(Boolean).pop()}</div>
              <div className="text-2xs text-fg-4">
                {dateTime(r.at)} · {num(r.moved)} files{r.undoneAt ? " · undone" : ""}
              </div>
            </div>
            {r.canUndo && <Badge tone="accent">Undo available</Badge>}
          </button>
        ))}
      </div>
      <ResultModal run={open} onClose={() => setOpen(null)} />
    </Panel>
  );
}

function UpdatesPanel({ save }: { save: (p: Partial<S>) => Promise<void> }) {
  const u = useApp((s) => s.update);
  const settings = useApp((s) => s.settings);
  const info = useApp((s) => s.info);
  if (!settings) return null;
  const status =
    u.status === "checking" ? "Checking…"
    : u.status === "none" ? "CLARITY is up to date."
    : u.status === "available" ? `Version ${u.version} is available.`
    : u.status === "downloading" ? `Downloading ${u.version}${u.progress != null ? ` (${Math.round(u.progress * 100)}%)` : ""}…`
    : u.status === "ready" ? `Version ${u.version} is downloaded and ready.`
    : u.status === "installing" ? "Installing…"
    : u.status === "error" ? `Last check failed: ${u.error}`
    : "Not checked yet.";
  return (
    <Panel title="Updates">
      <Row label={`CLARITY ${info?.version ?? ""}`} hint={`${status}${u.checkedAt ? ` Last check ${dateTime(u.checkedAt)}.` : ""}`}>
        <div className="flex gap-2">
          {u.status === "available" && (
            <Button size="sm" onClick={() => void download()}>
              Download
            </Button>
          )}
          {u.status === "ready" && (
            <Button size="sm" tone="primary" onClick={() => void installAndRestart()}>
              Restart to update
            </Button>
          )}
          <Button size="sm" disabled={!isNative || ["checking", "downloading", "installing"].includes(u.status)} onClick={() => void checkForUpdates(true)}>
            Check now
          </Button>
        </div>
      </Row>
      <Row label="Install updates automatically" hint="Downloads new versions in the background. CLARITY only restarts when you click “Restart to update”.">
        <Toggle checked={settings.autoUpdate} onChange={(autoUpdate) => save({ autoUpdate })} label="Install updates automatically" />
      </Row>
      {u.notes && (u.status === "available" || u.status === "ready" || u.status === "downloading") && (
        <div className="mt-1 whitespace-pre-line rounded-[8px] bg-[var(--glass-0)] p-3 text-xs text-fg-2 shadow-[0_0_0_1px_var(--line)]">{u.notes}</div>
      )}
      <p className="mt-2 text-2xs text-fg-4">Updates come from CLARITY's release server (Nexus) and are verified with a signature before installing. Only the version and an anonymous device id are sent.</p>
    </Panel>
  );
}
