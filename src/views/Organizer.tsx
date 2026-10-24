import clsx from "clsx";
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, ChevronDown, ChevronRight, CornerDownRight, Folder, FolderOpen, FolderPlus, Info, Pencil, Plus, Sparkles, Trash2, Undo2, Wand2, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { FileIcon } from "../components/FileIcon";
import { Modal } from "../components/Overlays";
import { Badge, Button, Checkbox, Empty, IconButton, Panel, Segmented, Spinner, Toggle } from "../components/ui";
import { api, errorText } from "../lib/api";
import { ago, bytes, CATEGORY_LABEL, catColor, num } from "../lib/format";
import type { Category, OrganizeMode, OrganizeOptions, OrganizePlan, OrganizeRule, OrganizeRun, PlanFile } from "../lib/types";
import { useApp } from "../store/app";

interface Row extends PlanFile {
  include: boolean;
  origDest: string;
  resolve: "skip" | "rename";
  suggestion: string | null;
}

const MODES: { value: OrganizeMode; label: string; hint: string }[] = [
  { value: "smart", label: "Smart", hint: "By type, with subfolders like PDFs, Screenshots or Photos only where there are enough files, and years for very large groups." },
  { value: "type", label: "By type", hint: "One folder per kind of file: Documents, Images, Videos, Audio, Archives, Installers…" },
  { value: "date", label: "By date", hint: "Year and month of the last change, e.g. 2025/03 March. Small months fold into their year." },
  { value: "custom", label: "Custom", hint: "Your own rules, checked from top to bottom." },
];

export function openOrganizer(root: string | null) {
  const s = useApp.getState();
  s.set({ organize: { root, back: s.view === "organize" ? (s.organize?.back ?? "overview") : s.view }, view: "organize", showScanSetup: false });
}

export function Organizer() {
  const org = useApp((s) => s.organize);
  const set = useApp((s) => s.set);
  const toast = useApp((s) => s.toast);
  const bump = useApp((s) => s.bump);
  const root = org?.root ?? null;
  const [opts, setOpts] = useState<OrganizeOptions>({ mode: "smart", minGroup: 3, keepRelated: true, rules: [{ field: "ext", value: "pdf", dest: "Documents/PDFs" }], fallback: "stay" });
  const [plan, setPlan] = useState<OrganizePlan | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [result, setResult] = useState<OrganizeRun | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const back = () => set({ view: org?.back ?? "overview", organize: null });
  const choose = async () => {
    const p = await api().pickFolder();
    if (p) set({ organize: { root: p, back: org?.back ?? "overview" } });
  };

  const analyze = async () => {
    if (!root) return;
    setLoading(true);
    setError(null);
    try {
      const p = await api().organizeAnalyze(root, opts);
      setPlan(p);
      setRows(p.files.map((f) => ({ ...f, include: !!f.dest, origDest: f.dest, resolve: "skip", suggestion: null })));
    } catch (e) {
      setError(errorText(e));
      setPlan(null);
    } finally {
      setLoading(false);
    }
  };
  // Re-analyze when the folder or the strategy changes (rules: on demand).
  useEffect(() => {
    void analyze();
  }, [root, opts.mode, opts.minGroup, opts.keepRelated, opts.fallback]);

  // Conflicts depend on the (possibly edited) destinations.
  const destKey = rows.map((r) => (r.include ? `${r.id}:${r.dest}` : "")).join("|");
  const firstRun = useRef(true);
  useEffect(() => {
    if (!root || !rows.length) return;
    if (firstRun.current) {
      firstRun.current = false;
    }
    const t = setTimeout(async () => {
      const q = rows.filter((r) => r.include && r.dest).map((r) => ({ id: r.id, name: r.name, dest: r.dest }));
      try {
        const info = await api().organizeConflicts(root, q);
        const m = new Map(info.map((i) => [i.id, i]));
        setRows((rs) => rs.map((r) => ({ ...r, conflict: m.get(r.id)?.conflict ?? null, suggestion: m.get(r.id)?.suggestion ?? null })));
      } catch {
        /* keep previous conflict info */
      }
    }, 250);
    return () => clearTimeout(t);
  }, [destKey, root]);

  useEffect(() => {
    let offP: (() => void) | undefined;
    let offF: (() => void) | undefined;
    void api().onOrganizeProgress((p) => setProgress(p)).then((f) => (offP = f));
    void api().onOrganizeFinished((r) => {
      setProgress(null);
      setCancelling(false);
      if (r.ok) {
        setResult(r.ok);
        bump();
      } else toast(r.error ?? "Organizing failed.", "error");
    }).then((f) => (offF = f));
    return () => {
      offP?.();
      offF?.();
    };
  }, []);

  const update = (pred: (r: Row) => boolean, patch: (r: Row) => Partial<Row>) => setRows((rs) => rs.map((r) => (pred(r) ? { ...r, ...patch(r) } : r)));

  const applyItems = rows
    .filter((r) => r.include && r.dest && (!r.conflict || (r.resolve === "rename" && r.suggestion)))
    .map((r) => ({ name: r.name, dest: r.dest, renameTo: r.conflict && r.resolve === "rename" ? r.suggestion : null, size: r.size, modified: r.modified }));
  const blockedConflicts = rows.filter((r) => r.include && r.dest && r.conflict && !(r.resolve === "rename" && r.suggestion)).length;
  const folders = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of rows) if (r.dest) m.set(r.dest, [...(m.get(r.dest) ?? []), r]);
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [rows]);
  const existing = new Set((plan?.existingSubfolders ?? []).map((s) => s.toLowerCase()));
  const newFolders = new Set(applyItems.map((i) => i.dest.split("/")[0]).filter((d) => !existing.has(d.toLowerCase()))).size;
  const staying = rows.filter((r) => !r.dest || !r.include).length;

  const start = async () => {
    if (!root) return;
    setConfirm(false);
    setProgress({ done: 0, total: applyItems.length, current: "" });
    try {
      await api().organizeApply(root, opts.mode, applyItems);
    } catch (e) {
      setProgress(null);
      toast(errorText(e), "error");
    }
  };

  if (!root) return <StartScreen onPick={choose} onBack={back} />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3 px-1">
        <div className="min-w-0">
          <button onClick={back} className="mb-1 flex items-center gap-1 text-xs text-fg-3 hover:text-fg">
            <ArrowLeft size={12} /> Back
          </button>
          <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight">
            <Wand2 size={18} className="text-accent" /> Organize folder
          </h1>
          <button onClick={choose} className="mt-0.5 max-w-[560px] truncate font-mono text-xs text-fg-3 hover:text-fg" title="Choose another folder">
            {root}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented value={opts.mode} onChange={(mode) => setOpts({ ...opts, mode })} options={MODES.map((m) => ({ value: m.value, label: m.label, title: m.hint }))} />
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2 px-1 text-xs text-fg-3">
        <span className="flex items-center gap-1.5">
          <Info size={12} /> {MODES.find((m) => m.value === opts.mode)?.hint}
        </span>
        <span className="ml-auto flex items-center gap-2">
          New folder only from
          <Segmented size="sm" value={opts.minGroup} onChange={(minGroup) => setOpts({ ...opts, minGroup })} options={[2, 3, 5, 10].map((n) => ({ value: n, label: `${n} files` }))} />
        </span>
        <span className="flex items-center gap-2">
          Keep related files together
          <Toggle checked={opts.keepRelated} onChange={(keepRelated) => setOpts({ ...opts, keepRelated })} label="Keep related files together" />
        </span>
      </div>

      {opts.mode === "custom" && <RulesEditor opts={opts} setOpts={setOpts} onApply={analyze} />}

      {error ? (
        <Empty icon={<AlertTriangle size={18} />} title="This folder cannot be organized" action={<Button onClick={choose}>Choose another folder</Button>}>
          {error}
        </Empty>
      ) : !plan || loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-fg-3">
          <Spinner /> Analyzing {root}…
        </div>
      ) : plan.files.length === 0 ? (
        <Empty icon={<Sparkles size={18} />} title="Nothing to organize here" action={<Button onClick={choose}>Choose another folder</Button>}>
          There are no loose files directly in this folder{plan.existingSubfolders.length ? ` (it has ${plan.existingSubfolders.length} subfolders, which are left as they are)` : ""}.
        </Empty>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(260px,2fr)_minmax(0,5fr)] gap-3">
          <BeforePanel plan={plan} rows={rows} />
          <Panel
            title="After"
            pad={false}
            actions={
              <span className="text-2xs text-fg-4">
                {folders.length} folders · click a file to change where it goes
              </span>
            }
          >
            <div className="scroll h-full px-2 pb-28">
              {folders.map(([dest, items], i) => (
                <FolderNode key={dest} dest={dest} items={items} index={i} isNew={!existing.has(dest.split("/")[0].toLowerCase())} folders={folders.map(([d]) => d)} root={root} update={update} />
              ))}
              <StayNode rows={rows.filter((r) => !r.dest)} folders={folders.map(([d]) => d)} update={update} />
            </div>
          </Panel>
        </div>
      )}

      {plan && plan.files.length > 0 && !error && (
        <div className="glass-float absolute bottom-5 left-1/2 z-30 flex h-[56px] -translate-x-1/2 items-center gap-5 whitespace-nowrap pl-5 pr-2">
          <div className="text-sm">
            <span className="font-semibold">{num(applyItems.length)}</span> <span className="text-fg-3">files into</span> <span className="font-semibold">{folders.length}</span> <span className="text-fg-3">folders</span>
            {newFolders > 0 && <span className="text-fg-3"> ({newFolders} new)</span>}
            <span className="text-fg-3"> · {num(staying)} stay</span>
            {blockedConflicts > 0 && <span className="text-warn"> · {blockedConflicts} conflicts skipped</span>}
          </div>
          <Button tone="ghost" onClick={analyze}>
            Reset
          </Button>
          <Button tone="primary" icon={<Wand2 size={14} />} disabled={!applyItems.length} onClick={() => setConfirm(true)}>
            Organize
          </Button>
        </div>
      )}

      <Modal open={confirm} onClose={() => setConfirm(false)} className="w-[480px]" label="Confirm organizing">
        <div className="p-6">
          <h2 className="text-lg font-semibold">Organize this folder?</h2>
          <ul className="mt-3 space-y-1.5 text-sm text-fg-2">
            <li>
              • Move <b>{num(applyItems.length)}</b> files ({bytes(applyItems.reduce((s, i) => s + i.size, 0))}) into {folders.length} folders, {newFolders} of them new.
            </li>
            {applyItems.some((i) => i.renameTo) && <li>• {applyItems.filter((i) => i.renameTo).length} files get a “(2)” name because the original name is taken.</li>}
            {blockedConflicts > 0 && <li>• {blockedConflicts} conflicting files stay where they are.</li>}
            <li>• Files only move inside {root.split("\\").filter(Boolean).pop()}. Nothing is deleted, overwritten or changed.</li>
            <li>• You can undo this afterwards, here or in Cleanup History.</li>
          </ul>
          <div className="mt-6 flex justify-end gap-2">
            <Button tone="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button tone="primary" icon={<Wand2 size={14} />} onClick={start}>
              Organize now
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={!!progress} onClose={() => {}} className="w-[460px]" label="Organizing">
        <div className="p-6">
          <h2 className="text-lg font-semibold">Organizing…</h2>
          <div className="mt-4 h-[5px] overflow-hidden rounded-full bg-active">
            <div className="h-full rounded-full bg-accent transition-[width] duration-150" style={{ width: `${progress && progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
          </div>
          <div className="mt-2 flex justify-between text-2xs text-fg-3">
            <span className="truncate">{progress?.current}</span>
            <span className="tabular">
              {num(progress?.done ?? 0)} / {num(progress?.total ?? 0)}
            </span>
          </div>
          <div className="mt-5 flex justify-end">
            <Button
              tone="ghost"
              disabled={cancelling}
              onClick={() => {
                setCancelling(true);
                void api().organizeCancel();
              }}
            >
              {cancelling ? "Stopping after this file…" : "Cancel"}
            </Button>
          </div>
        </div>
      </Modal>

      <ResultModal run={result} onClose={() => (setResult(null), analyze())} />
    </div>
  );
}

function StartScreen({ onPick, onBack }: { onPick: () => void; onBack: () => void }) {
  const info = useApp((s) => s.info);
  const set = useApp((s) => s.set);
  const quick = [
    { label: "Downloads", path: info?.downloadsPath },
    { label: "Desktop", path: info?.desktopPath },
    { label: "Documents", path: info?.documentsPath },
  ].filter((q): q is { label: string; path: string } => !!q.path);
  return (
    <div className="flex h-full items-center justify-center p-6">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="glass-float edge-light w-full max-w-[600px] p-8">
        <Wand2 size={22} className="text-accent" />
        <h2 className="mt-4 text-xl font-semibold tracking-tight">Tidy up a messy folder</h2>
        <p className="mt-2 text-sm text-fg-2">CLARITY looks at the loose files in a folder and proposes a clean structure. You see exactly what moves where, adjust anything, and confirm. It can be undone afterwards.</p>
        <div className="mt-6 grid grid-cols-3 gap-2">
          {quick.map((q) => (
            <button key={q.label} onClick={() => set({ organize: { root: q.path, back: useApp.getState().organize?.back ?? "overview" } })} className="rounded-[10px] bg-[var(--glass-0)] p-3 text-left shadow-[0_0_0_1px_var(--line)] transition-colors hover:bg-hover">
              <FolderOpen size={16} className="text-accent" />
              <div className="mt-2 text-sm font-medium">{q.label}</div>
              <div className="truncate font-mono text-2xs text-fg-4">{q.path}</div>
            </button>
          ))}
        </div>
        <div className="mt-6 flex justify-between">
          <Button tone="ghost" onClick={onBack}>
            Back
          </Button>
          <Button tone="primary" icon={<FolderOpen size={14} />} onClick={onPick}>
            Choose a folder…
          </Button>
        </div>
      </motion.div>
    </div>
  );
}

function BeforePanel({ plan, rows }: { plan: OrganizePlan; rows: Row[] }) {
  const [showSkipped, setShowSkipped] = useState(false);
  const cats = useMemo(() => {
    const m = new Map<Category, { n: number; b: number }>();
    for (const r of rows) {
      const e = m.get(r.category) ?? { n: 0, b: 0 };
      e.n++;
      e.b += r.size;
      m.set(r.category, e);
    }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [rows]);
  const max = Math.max(1, ...cats.map(([, v]) => v.n));
  return (
    <Panel title="Now" pad={false}>
      <div className="scroll h-full px-4 pb-28">
        <div className="flex items-baseline gap-2">
          <span className="tabular text-3xl font-semibold tracking-tight">{num(rows.length)}</span>
          <span className="text-sm text-fg-3">loose files · {bytes(rows.reduce((s, r) => s + r.size, 0))}</span>
        </div>
        <div className="mt-4 space-y-1.5">
          {cats.map(([c, v]) => (
            <div key={c} className="text-xs">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-[3px]" style={{ background: catColor(c) }} />
                <span className="flex-1 text-fg-2">{CATEGORY_LABEL[c]}</span>
                <span className="tabular text-fg-3">{num(v.n)}</span>
              </div>
              <div className="ml-4 mt-1 h-[3px] rounded-full bg-active">
                <div className="h-full rounded-full" style={{ width: `${(v.n / max) * 100}%`, background: catColor(c) }} />
              </div>
            </div>
          ))}
        </div>
        {plan.existingSubfolders.length > 0 && (
          <div className="mt-5">
            <div className="text-2xs font-semibold uppercase tracking-[0.1em] text-fg-4">Existing subfolders · left as they are</div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {plan.existingSubfolders.slice(0, 30).map((s) => (
                <Badge key={s}>
                  <Folder size={9} /> {s}
                </Badge>
              ))}
              {plan.existingSubfolders.length > 30 && <Badge>+{plan.existingSubfolders.length - 30}</Badge>}
            </div>
          </div>
        )}
        {plan.skipped.length > 0 && (
          <div className="mt-5">
            <button onClick={() => setShowSkipped(!showSkipped)} className="flex items-center gap-1 text-2xs font-semibold uppercase tracking-[0.1em] text-fg-4 hover:text-fg-2">
              {showSkipped ? <ChevronDown size={11} /> : <ChevronRight size={11} />} Not touched · {plan.skipped.length}
            </button>
            {showSkipped && (
              <div className="mt-1.5 space-y-1">
                {plan.skipped.map((s) => (
                  <div key={s.name} className="text-2xs">
                    <span className="text-fg-2">{s.name}</span> <span className="text-fg-4">· {s.reason}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

function DestPicker({ row, folders, update }: { row: Row; folders: string[]; update: (p: (r: Row) => boolean, f: (r: Row) => Partial<Row>) => void }) {
  return (
    <select
      value={row.dest}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        let v = e.target.value;
        if (v === "__new") {
          v = window.prompt("New folder (use / for subfolders):", row.dest || "Sorted")?.trim().replace(/\\/g, "/") ?? row.dest;
        }
        update((r) => r.id === row.id, () => ({ dest: v, include: !!v }));
      }}
      className="h-6 max-w-[150px] rounded-[6px] bg-transparent px-1 text-2xs text-fg-3 shadow-[0_0_0_1px_var(--line)] outline-none hover:text-fg [&>option]:bg-[var(--glass-solid)]"
      title="Change destination"
    >
      <option value="">Stay in place</option>
      {folders.map((f) => (
        <option key={f} value={f}>
          {f}
        </option>
      ))}
      {row.dest && !folders.includes(row.dest) && <option value={row.dest}>{row.dest}</option>}
      <option value="__new">New folder…</option>
    </select>
  );
}

function FileLine({ r, folders, update, root }: { r: Row; folders: string[]; update: (p: (r: Row) => boolean, f: (r: Row) => Partial<Row>) => void; root: string }) {
  const inspect = useApp((s) => s.inspect);
  const toast = useApp((s) => s.toast);
  const onInspect = async () => {
    const hit = await api().locatePath(`${root.replace(/\\$/, "")}\\${r.name}`).catch(() => null);
    if (hit) inspect(hit);
    else toast("This file is not in the current scan, so the Inspector cannot show it. Rescan the folder to inspect it.");
  };
  return (
    <div className={clsx("group rounded-[7px] px-2 py-1 hover:bg-hover", !r.include && "opacity-50")}>
      <div className="flex items-center gap-2">
        <Checkbox checked={r.include} onChange={(v) => update((x) => x.id === r.id, () => ({ include: v }))} label={`Include ${r.name}`} />
        <FileIcon category={r.category} size={13} />
        <button onClick={onInspect} className="min-w-0 flex-1 truncate text-left text-xs text-fg hover:underline" title={`${r.reason} · modified ${ago(r.modified)}`}>
          {r.name}
        </button>
        {r.group != null && r.group !== r.id && (
          <span className="shrink-0 text-2xs text-fg-4" title={r.reason}>
            <CornerDownRight size={10} className="inline" /> with group
          </span>
        )}
        <span className="tabular shrink-0 text-2xs text-fg-4">{bytes(r.size)}</span>
        <DestPicker row={r} folders={folders} update={update} />
      </div>
      {r.include && r.conflict && (
        <div className="ml-6 mt-1 flex flex-wrap items-center gap-2 text-2xs text-warn">
          <AlertTriangle size={11} /> {r.conflict}
          {r.suggestion && (
            <Segmented
              size="sm"
              value={r.resolve}
              onChange={(resolve) => update((x) => x.id === r.id, () => ({ resolve }))}
              options={[
                { value: "skip", label: "Leave it" },
                { value: "rename", label: `Keep both as “${r.suggestion}”` },
              ]}
            />
          )}
        </div>
      )}
      {r.dest !== r.origDest && r.include && <div className="ml-6 text-2xs text-accent">Changed by you (was {r.origDest || "stay"})</div>}
    </div>
  );
}

function FolderNode({ dest, items, index, isNew, folders, root, update }: { dest: string; items: Row[]; index: number; isNew: boolean; folders: string[]; root: string; update: (p: (r: Row) => boolean, f: (r: Row) => Partial<Row>) => void }) {
  const [open, setOpen] = useState(items.length <= 12);
  const [limit, setLimit] = useState(100);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(dest);
  const included = items.filter((r) => r.include);
  const conflicts = items.filter((r) => r.include && r.conflict).length;
  const depth = dest.split("/").length - 1;
  return (
    <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(index, 12) * 0.02 }} className="mb-1" style={{ marginLeft: depth * 14 }}>
      <div className="group flex items-center gap-2 rounded-[8px] px-2 py-1.5 hover:bg-hover">
        <button onClick={() => setOpen(!open)} className="text-fg-3">
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <Checkbox checked={included.length === items.length} indeterminate={included.length > 0 && included.length < items.length} onChange={(v) => update((r) => r.dest === dest, () => ({ include: v }))} label={`Include ${dest}`} />
        {isNew ? <FolderPlus size={15} className="text-accent" /> : <Folder size={15} className="text-[var(--c-folder)]" />}
        {renaming ? (
          <form
            className="flex flex-1 items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              const n = name.trim().replace(/\\/g, "/");
              if (n) update((r) => r.dest === dest, () => ({ dest: n }));
              setRenaming(false);
            }}
          >
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className="h-6 flex-1 rounded-[6px] bg-hover px-2 text-sm shadow-[0_0_0_1px_var(--accent-line)] outline-none" />
            <IconButton label="Cancel" type="button" onClick={() => setRenaming(false)}>
              <X size={12} />
            </IconButton>
          </form>
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{dest.split("/").pop()}</span>
        )}
        {depth > 0 && !renaming && <span className="hidden truncate text-2xs text-fg-4 sm:inline">{dest}</span>}
        {isNew && <Badge tone="accent">new</Badge>}
        {conflicts > 0 && <Badge tone="warn">{conflicts} conflict{conflicts === 1 ? "" : "s"}</Badge>}
        <span className="tabular text-2xs text-fg-3">
          {num(included.length)} · {bytes(included.reduce((s, r) => s + r.size, 0))}
        </span>
        {!renaming && (
          <IconButton label="Rename folder" onClick={() => (setName(dest), setRenaming(true))} className="opacity-0 group-hover:opacity-100">
            <Pencil size={12} />
          </IconButton>
        )}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden pl-6">
            {items.slice(0, limit).map((r) => (
              <FileLine key={r.id} r={r} folders={folders} update={update} root={root} />
            ))}
            {items.length > limit && (
              <button onClick={() => setLimit(limit + 200)} className="px-2 py-1 text-2xs text-accent hover:underline">
                Show {Math.min(200, items.length - limit)} more of {num(items.length - limit)}
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function StayNode({ rows, folders, update }: { rows: Row[]; folders: string[]; update: (p: (r: Row) => boolean, f: (r: Row) => Partial<Row>) => void }) {
  const [open, setOpen] = useState(false);
  if (!rows.length) return null;
  return (
    <div className="mt-3 border-t hairline pt-2">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left hover:bg-hover">
        {open ? <ChevronDown size={13} className="text-fg-3" /> : <ChevronRight size={13} className="text-fg-3" />}
        <span className="flex-1 text-sm text-fg-2">Stay where they are</span>
        <span className="tabular text-2xs text-fg-3">{num(rows.length)}</span>
      </button>
      {open &&
        rows.slice(0, 300).map((r) => (
          <div key={r.id} className="flex items-center gap-2 rounded-[7px] px-2 py-1 pl-8 hover:bg-hover">
            <FileIcon category={r.category} size={13} />
            <span className="min-w-0 flex-1 truncate text-xs text-fg-2" title={r.reason}>
              {r.name}
            </span>
            <span className="truncate text-2xs text-fg-4">{r.reason}</span>
            <DestPicker row={r} folders={folders} update={update} />
          </div>
        ))}
    </div>
  );
}

const FIELDS: { value: OrganizeRule["field"]; label: string; placeholder: string }[] = [
  { value: "ext", label: "Extension is", placeholder: "pdf, docx" },
  { value: "name", label: "Name contains", placeholder: "invoice" },
  { value: "category", label: "Type is", placeholder: "images" },
  { value: "olderThanDays", label: "Unchanged for (days)", placeholder: "365" },
  { value: "largerThanMb", label: "Larger than (MB)", placeholder: "500" },
];

function RulesEditor({ opts, setOpts, onApply }: { opts: OrganizeOptions; setOpts: (o: OrganizeOptions) => void; onApply: () => void }) {
  const setRule = (i: number, patch: Partial<OrganizeRule>) => setOpts({ ...opts, rules: opts.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const input = "h-7 rounded-[7px] bg-hover px-2 text-xs shadow-[0_0_0_1px_var(--line-2)] outline-none focus:shadow-[0_0_0_1.5px_var(--accent-line)]";
  return (
    <div className="glass mb-3 px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-[0.08em] text-fg-3">Rules · first match wins</span>
        <span className="flex items-center gap-2 text-xs text-fg-3">
          Files without a matching rule
          <Segmented size="sm" value={opts.fallback} onChange={(fallback) => setOpts({ ...opts, fallback })} options={[{ value: "stay", label: "stay" }, { value: "smart", label: "are sorted smartly" }]} />
        </span>
      </div>
      <div className="space-y-1.5">
        {opts.rules.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="tabular w-4 text-2xs text-fg-4">{i + 1}</span>
            <select value={r.field} onChange={(e) => setRule(i, { field: e.target.value as OrganizeRule["field"] })} className={clsx(input, "[&>option]:bg-[var(--glass-solid)]")}>
              {FIELDS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            <input value={r.value} onChange={(e) => setRule(i, { value: e.target.value })} placeholder={FIELDS.find((f) => f.value === r.field)?.placeholder} className={clsx(input, "w-36")} />
            <ArrowRight size={12} className="text-fg-4" />
            <input value={r.dest} onChange={(e) => setRule(i, { dest: e.target.value })} placeholder="Folder/Subfolder" className={clsx(input, "min-w-0 flex-1")} />
            <IconButton label="Remove rule" onClick={() => setOpts({ ...opts, rules: opts.rules.filter((_, j) => j !== i) })}>
              <Trash2 size={12} />
            </IconButton>
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between">
        <Button size="sm" tone="ghost" icon={<Plus size={12} />} onClick={() => setOpts({ ...opts, rules: [...opts.rules, { field: "ext", value: "", dest: "" }] })}>
          Add rule
        </Button>
        <Button size="sm" tone="subtle" onClick={onApply}>
          Apply rules to preview
        </Button>
      </div>
    </div>
  );
}

export function ResultModal({ run, onClose }: { run: OrganizeRun | null; onClose: () => void }) {
  const toast = useApp((s) => s.toast);
  const bump = useApp((s) => s.bump);
  const [state, setState] = useState<OrganizeRun | null>(run);
  const [busy, setBusy] = useState(false);
  useEffect(() => setState(run), [run]);
  const undo = async () => {
    if (!state) return;
    setBusy(true);
    try {
      const r = await api().organizeUndo(state.runId);
      setState(r);
      bump();
      toast(r.kept ? `Restored ${r.restored} files; ${r.kept} were left in place (see details).` : `Restored all ${r.restored} files.`, r.kept ? "info" : "ok");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const problems = state?.items.filter((i) => i.status !== "moved" && i.status !== "restored") ?? [];
  return (
    <Modal open={!!run} onClose={onClose} className="w-[min(640px,92vw)]" label="Organize result">
      {state && (
        <div className="p-6">
          <div className="flex items-center gap-3">
            {state.undoneAt ? <Undo2 size={22} className="text-accent" /> : <CheckCircle2 size={22} className={state.moved ? "text-ok" : "text-warn"} />}
            <h2 className="text-lg font-semibold">{state.undoneAt ? `Undone · ${num(state.restored)} files back in place` : state.cancelled ? `Stopped after ${num(state.moved)} files` : `Organized ${num(state.moved)} files`}</h2>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2">
            <Stat label="Moved" value={num(state.moved)} sub={bytes(state.bytes)} />
            <Stat label="New folders" value={num(state.foldersCreated)} sub={state.undoneAt ? "removed again if empty" : "created"} />
            <Stat label="Not moved" value={num(state.skipped + state.failed)} sub={state.failed ? `${state.failed} failed` : "skipped"} />
          </div>
          {problems.length > 0 && (
            <div className="scroll mt-4 max-h-[30vh] rounded-[10px] shadow-[0_0_0_1px_var(--line)]">
              {problems.map((p, i) => (
                <div key={i} className="flex items-start gap-2 border-b hairline px-3 py-1.5 text-xs last:border-0">
                  <Badge tone={p.status === "failed" ? "danger" : "warn"}>{p.status}</Badge>
                  <span className="min-w-0 flex-1">
                    <span className="text-fg-2">{p.name}</span> <span className="text-fg-4">· {p.error}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
          <p className="mt-3 text-2xs text-fg-4">Recorded in Cleanup History. The analysis views reflect the new structure after the next scan of this folder.</p>
          <div className="mt-5 flex justify-end gap-2">
            {state.canUndo && (
              <Button icon={<Undo2 size={14} />} disabled={busy} onClick={undo}>
                {busy ? "Undoing…" : "Undo"}
              </Button>
            )}
            <Button tone="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-[10px] bg-[var(--glass-0)] px-4 py-3 shadow-[0_0_0_1px_var(--line)]">
      <div className="text-2xs uppercase tracking-[0.08em] text-fg-3">{label}</div>
      <div className="tabular text-xl font-semibold">{value}</div>
      <div className="text-2xs text-fg-4">{sub}</div>
    </div>
  );
}
