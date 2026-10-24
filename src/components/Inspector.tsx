import clsx from "clsx";
import { Wand2, AlertTriangle, ArrowUpRight, Check, Expand, ExternalLink, Eye, FolderOpen, Info, Link2, PanelRightClose, Plus, ShieldCheck } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { api, errorText } from "../lib/api";
import { ago, bytes, CATEGORY_LABEL, catColor, dateTime, num, plausibleTime } from "../lib/format";
import type { DirDetail, FileDetail, Recommendation } from "../lib/types";
import { FilePreview } from "../previews/FilePreview";
import { selKey, useApp } from "../store/app";
import { FileIcon } from "./FileIcon";
import { Badge, Button, CatDot, Empty, IconButton, Spinner } from "./ui";
import { MediaFacts, RelatedSection } from "./InspectorExtras";
import { openOrganizer } from "../views/Organizer";

export function Inspector() {
  const target = useApp((s) => s.inspector);
  const set = useApp((s) => s.set);
  return (
    <motion.aside
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 24 }}
      transition={{ type: "spring", stiffness: 380, damping: 36 }}
      className="glass edge-light flex w-[372px] shrink-0 flex-col overflow-hidden"
      aria-label="Inspector"
    >
      <div className="flex h-11 shrink-0 items-center justify-between pl-4 pr-2">
        <span className="text-xs font-semibold uppercase tracking-[0.08em] text-fg-3">Inspector</span>
        <IconButton label="Hide inspector (I)" onClick={() => set({ inspectorOpen: false })}>
          <PanelRightClose size={15} />
        </IconButton>
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={target ? `${target.kind}${target.id}` : "none"} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.14 }} className="flex min-h-0 flex-1 flex-col">
          {!target ? (
            <Empty icon={<Info size={18} />} title="Nothing selected">
              Select a file or folder to see what it is, preview it, and why CLARITY suggests reviewing it.
            </Empty>
          ) : target.kind === "file" ? (
            <FileInspector id={target.id} />
          ) : (
            <DirInspector id={target.id} />
          )}
        </motion.div>
      </AnimatePresence>
    </motion.aside>
  );
}

function useDetail<T>(load: () => Promise<T>, deps: unknown[]) {
  const version = useApp((s) => s.version);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    load().then(
      (d) => !cancelled && setData(d),
      (e) => !cancelled && setError(errorText(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [...deps, version]);
  return { data, error };
}

function FileInspector({ id }: { id: number }) {
  const { data: d, error } = useDetail<FileDetail>(() => api().fileDetail(id), [id]);
  const info = useApp((s) => s.info);
  const selection = useApp((s) => s.selection);
  const toggleSelect = useApp((s) => s.toggleSelect);
  const set = useApp((s) => s.set);
  const go = useApp((s) => s.go);
  const toast = useApp((s) => s.toast);
  if (error) return <Empty title="Could not load details">{error}</Empty>;
  if (!d || d.row.id !== id)
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  const r = d.row;
  const selected = selection.has(selKey("file", r.id));
  const accessReliable = info?.lastAccess.enabled === true;
  const act = (p: Promise<void>) => p.catch((e) => toast(errorText(e), "error"));

  return (
    <div className="scroll flex-1 pb-4">
      <div className="flex items-start gap-3 px-4 pb-3">
        <FileIcon category={r.category} size={17} boxed />
        <div className="min-w-0 flex-1">
          <h2 className="selectable break-words text-[15px] font-semibold leading-snug text-fg">{r.name}</h2>
          <p className="mt-0.5 text-xs text-fg-3">
            {CATEGORY_LABEL[r.category]}
            {r.ext && <span className="font-mono"> · .{r.ext}</span>}
          </p>
        </div>
      </div>

      <div className="relative mx-3 h-[244px] overflow-hidden rounded-[10px] bg-[var(--glass-0)] shadow-[0_0_0_1px_var(--line)]">
        <FilePreview detail={d} />
        {d.preview !== "none" && !r.cloud && d.live.exists && (
          <button
            onClick={() => set({ quickLook: r.id })}
            title="Quick look (Enter)"
            className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-[6px] bg-[var(--glass-2)] text-fg-2 opacity-70 shadow-[0_0_0_1px_var(--line-2)] backdrop-blur transition-opacity hover:opacity-100"
          >
            <Expand size={12} />
          </button>
        )}
      </div>

      <div className="mt-3 flex gap-2 px-3">
        <Button tone={selected ? "subtle" : "primary"} size="sm" className="flex-1" disabled={!!d.protected || !d.live.exists} icon={selected ? <Check size={13} /> : <Plus size={13} />} onClick={() => toggleSelect({ kind: "file", id: r.id, name: r.name, path: d.path, size: r.size })}>
          {selected ? "Selected for cleanup" : "Select for cleanup"}
        </Button>
        {d.canOpen && (
          <Button size="sm" icon={<ExternalLink size={13} />} onClick={() => act(api().openFile(r.id))} title="Open with the default Windows application">
            Open
          </Button>
        )}
        <IconButton label="Show in Windows Explorer" onClick={() => act(api().reveal({ kind: "file", id: r.id }))} className="h-7 w-8 shadow-[0_0_0_1px_var(--line-2)]">
          <FolderOpen size={14} />
        </IconButton>
      </div>

      {d.protected && (
        <Notice tone="ok" icon={<ShieldCheck size={14} />}>
          Protected: {d.protected} CLARITY will not remove it.
        </Notice>
      )}
      {d.live.changed && <Notice icon={<AlertTriangle size={14} />}>This file changed after the scan. Rescan before cleaning it up.</Notice>}

      <Section title="Details">
        <MediaFacts d={d} Fact={Fact} />
        <Fact label="Size">
          <span className="tabular">{bytes(r.size)}</span>
          <span className="tabular text-fg-4"> · {num(r.size)} bytes</span>
          {d.live.onDisk != null && Math.abs(d.live.onDisk - r.size) > 4096 && <div className="text-2xs text-fg-3">Uses {bytes(d.live.onDisk)} on disk</div>}
        </Fact>
        <Fact label="Location">
          <button className="selectable break-all text-left font-mono text-[11px] text-fg-2 hover:text-accent" onClick={() => go("explorer", { dir: r.dirId })} title="Open in File Explorer view">
            {r.dir}
          </button>
        </Fact>
        <Fact label="Modified">
          {dateTime(r.modified)} <span className="text-fg-4">· {ago(r.modified)}</span>
          {r.modified > 0 && !plausibleTime(r.modified) && (
            <div className="text-2xs text-fg-4">Placeholder date. Archives and installers often stamp files with 1980 or a future date, so CLARITY ignores it for age-based suggestions.</div>
          )}
        </Fact>
        <Fact label="Created">
          {dateTime(r.created)} <span className="text-fg-4">· {ago(r.created)}</span>
          {r.created > r.modified + 60 && <div className="text-2xs text-fg-4">Created after last modification: usually copied or downloaded here.</div>}
        </Fact>
        <Fact label="Last accessed">
          {accessReliable ? (
            <>
              {dateTime(r.accessed)} <Badge title={info?.lastAccess.explanation}>approximate</Badge>
            </>
          ) : (
            <span className="text-fg-3" title={info?.lastAccess.explanation}>
              Not reliable on this PC
            </span>
          )}
        </Fact>
        <Fact label="Observed usage">
          <span className="text-fg-3">Unknown. CLARITY does not monitor when files are opened.</span>
        </Fact>
        {d.live.hardLinks != null && d.live.hardLinks > 1 && (
          <Fact label="Hard links">
            <span className="inline-flex items-center gap-1">
              <Link2 size={12} /> {d.live.hardLinks} names share this data
            </span>
          </Fact>
        )}
        {(r.hidden || r.readonly || r.system) && <Fact label="Attributes">{[r.hidden && "Hidden", r.readonly && "Read-only", r.system && "System"].filter(Boolean).join(", ")}</Fact>}
      </Section>

      <RelatedSection d={d} Section={Section} />

      {d.recommendations.length > 0 && (
        <Section title="Why review this">
          {d.recommendations.map((rec, i) => (
            <RecNote key={i} rec={rec} onDuplicates={() => go("duplicates")} />
          ))}
        </Section>
      )}
    </div>
  );
}

function DirInspector({ id }: { id: number }) {
  const { data: d, error } = useDetail<DirDetail>(() => api().dirDetail(id), [id]);
  const selection = useApp((s) => s.selection);
  const toggleSelect = useApp((s) => s.toggleSelect);
  const go = useApp((s) => s.go);
  const inspect = useApp((s) => s.inspect);
  const toast = useApp((s) => s.toast);
  if (error) return <Empty title="Could not load details">{error}</Empty>;
  if (!d || d.row.id !== id)
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  const r = d.row;
  const selected = selection.has(selKey("dir", r.id));
  const total = d.categoryBytes.reduce((s, c) => s + c.bytes, 0) || 1;
  return (
    <div className="scroll flex-1 pb-4">
      <div className="flex items-start gap-3 px-4 pb-3">
        <FileIcon category="folder" size={17} boxed />
        <div className="min-w-0 flex-1">
          <h2 className="selectable break-words text-[15px] font-semibold leading-snug text-fg">{r.name}</h2>
          <p className="selectable mt-0.5 break-all font-mono text-[11px] text-fg-3">{r.path}</p>
        </div>
      </div>
      <div className="mx-3 rounded-[10px] bg-[var(--glass-0)] p-3 shadow-[0_0_0_1px_var(--line)]">
        <div className="flex items-baseline justify-between">
          <span className="tabular text-2xl font-semibold tracking-tight text-fg">{bytes(r.size)}</span>
          <span className="tabular text-xs text-fg-3">{num(r.files)} files</span>
        </div>
        <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-active">
          {d.categoryBytes.map((c) => (
            <div key={c.category} style={{ width: `${(c.bytes / total) * 100}%`, background: catColor(c.category) }} title={`${CATEGORY_LABEL[c.category]}: ${bytes(c.bytes)}`} />
          ))}
        </div>
        <div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1">
          {d.categoryBytes.slice(0, 6).map((c) => (
            <div key={c.category} className="flex items-center gap-1.5 text-2xs text-fg-3">
              <CatDot category={c.category} size={6} />
              <span className="truncate">{CATEGORY_LABEL[c.category]}</span>
              <span className="tabular ml-auto text-fg-2">{bytes(c.bytes)}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-3 flex gap-2 px-3">
        <Button tone={selected ? "subtle" : "primary"} size="sm" className="flex-1" disabled={!!d.protected} icon={selected ? <Check size={13} /> : <Plus size={13} />} onClick={() => toggleSelect({ kind: "dir", id: r.id, name: r.name, path: r.path, size: r.size })}>
          {selected ? "Folder selected" : "Select folder"}
        </Button>
        <Button size="sm" icon={<ArrowUpRight size={13} />} onClick={() => go("explorer", { dir: r.id })}>
          Browse
        </Button>
        <IconButton label="Organize this folder" onClick={() => openOrganizer(r.path)} className="h-7 w-8 shadow-[0_0_0_1px_var(--line-2)]" disabled={!!d.protected && !d.isRoot}>
          <Wand2 size={14} />
        </IconButton>
        <IconButton label="Watch this folder for growth" onClick={() => useApp.getState().set({ watchEdit: { path: r.path } })} className="h-7 w-8 shadow-[0_0_0_1px_var(--line-2)]">
          <Eye size={14} />
        </IconButton>
        <IconButton label="Show in Windows Explorer" onClick={() => api().reveal({ kind: "dir", id: r.id }).catch((e) => toast(errorText(e), "error"))} className="h-7 w-8 shadow-[0_0_0_1px_var(--line-2)]">
          <FolderOpen size={14} />
        </IconButton>
      </div>
      {d.protected && (
        <Notice tone="ok" icon={<ShieldCheck size={14} />}>
          {d.protected} CLARITY will not remove this folder.
        </Notice>
      )}
      {r.unreadable && <Notice icon={<AlertTriangle size={14} />}>Windows denied access to part of this folder; sizes may be incomplete.</Notice>}
      <Section title="Details">
        <Fact label="Directly inside">{bytes(r.ownSize)}</Fact>
        <Fact label="Subfolders">{num(r.subdirs)}</Fact>
        <Fact label="Last change inside">
          {dateTime(r.latestModified)} <span className="text-fg-4">· {ago(r.latestModified)}</span>
        </Fact>
      </Section>
      {d.children.length > 0 && (
        <Section title="Largest subfolders">
          {d.children.map((c) => (
            <button key={c.id} onClick={() => inspect({ kind: "dir", id: c.id })} className="flex w-full items-center gap-2 rounded-[6px] px-1 py-1 text-left text-xs hover:bg-hover">
              <FileIcon category="folder" size={13} />
              <span className="min-w-0 flex-1 truncate text-fg-2">{c.name}</span>
              <span className="tabular text-fg-3">{bytes(c.size)}</span>
            </button>
          ))}
        </Section>
      )}
      {d.recommendations.length > 0 && (
        <Section title="Why review this">
          {d.recommendations.map((rec, i) => (
            <RecNote key={i} rec={rec} />
          ))}
        </Section>
      )}
    </div>
  );
}

function RecNote({ rec, onDuplicates }: { rec: Recommendation; onDuplicates?: () => void }) {
  return (
    <div className="mb-2 rounded-[9px] bg-[var(--glass-0)] p-3 shadow-[0_0_0_1px_var(--line)]">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs font-semibold text-fg">{rec.title.split(":")[0]}</span>
        <RiskBadge risk={rec.risk} />
      </div>
      <p className="text-xs leading-relaxed text-fg-2">{rec.reason}</p>
      <p className="mt-1.5 text-2xs leading-relaxed text-fg-3">
        <span className="font-medium text-fg-2">Consider: </span>
        {rec.riskNote}
      </p>
      {rec.kind === "duplicate" && onDuplicates && (
        <button onClick={onDuplicates} className="mt-2 text-xs font-medium text-accent hover:underline">
          Compare copies →
        </button>
      )}
    </div>
  );
}

export function RiskBadge({ risk }: { risk: Recommendation["risk"] }) {
  return (
    <Badge tone={risk === "low" ? "ok" : risk === "medium" ? "warn" : "danger"} title="How careful to be before removing it">
      {risk === "low" ? "Low risk" : risk === "medium" ? "Check first" : "Be careful"}
    </Badge>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-4 px-4">
      <h4 className="mb-2 text-2xs font-semibold uppercase tracking-[0.1em] text-fg-4">{title}</h4>
      {children}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_1fr] gap-2 border-b hairline py-[7px] text-xs last:border-0">
      <span className="text-fg-3">{label}</span>
      <div className="min-w-0 text-fg">{children}</div>
    </div>
  );
}

function Notice({ children, icon, tone = "warn" }: { children: ReactNode; icon: ReactNode; tone?: "warn" | "ok" }) {
  return (
    <div className={clsx("mx-3 mt-3 flex gap-2 rounded-[9px] p-2.5 text-xs leading-relaxed", tone === "warn" ? "bg-[var(--warn-soft)] text-warn" : "bg-[var(--ok-soft)] text-ok")}>
      <span className="mt-[1px] shrink-0">{icon}</span>
      <span>{children}</span>
    </div>
  );
}
