import clsx from "clsx";
import { AlertCircle, ArrowRight, CopyCheck, Lightbulb, RotateCw } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { FileIcon } from "../components/FileIcon";
import { Button, Empty, Figure, Panel, Spinner } from "../components/ui";
import { api, errorText } from "../lib/api";
import { ago, bytes, bytesParts, CATEGORY_LABEL, catColor, dateTime, duration, num, shortPath } from "../lib/format";
import type { CategoryStat, Overview as OV } from "../lib/types";
import { useApp, type View } from "../store/app";
import { AlertRow, useWatch } from "./Watchlist";

export function useOverview() {
  const version = useApp((s) => s.version);
  const [data, setData] = useState<OV | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api().overview().then(setData, (e) => setError(errorText(e)));
  }, [version]);
  return { data, error };
}

export function Overview() {
  const { data, error } = useOverview();
  const { data: watch } = useWatch();
  const go = useApp((s) => s.go);
  const inspect = useApp((s) => s.inspect);
  const dupRunning = useApp((s) => s.dupRunning);

  if (error) return <Empty title="Could not build the overview">{error}</Empty>;
  if (!data)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  const s = data.scan;
  const maxFolder = Math.max(1, ...data.topFolders.map((f) => f.size));

  return (
    <div className="@container">
    <div className="grid grid-cols-12 gap-3 pb-24">
      <Panel className="col-span-6 min-h-[340px] @min-[1100px]:col-span-5" title="Your storage">
        <Lens data={data} onCategory={(c) => go("large", { categories: [c] })} />
      </Panel>

      <Panel className="col-span-6 @min-[1100px]:col-span-7" title="Worth knowing" actions={<span className="text-2xs text-fg-4">From this scan</span>}>
        <div className="flex h-full flex-col gap-2">
          {(watch?.alerts.filter((a) => !a.seen).length ?? 0) > 0 && (
            <div className="rounded-[10px] bg-[var(--warn-soft)] px-2 py-1.5 shadow-[0_0_0_1px_var(--line)]">
              <div className="flex items-center justify-between px-2 pt-1 text-2xs font-semibold uppercase tracking-[0.1em] text-warn">
                Watchlist
                <button className="normal-case tracking-normal text-fg-3 hover:text-fg" onClick={() => go("analysis", { tab: "watchlist" })}>
                  Open watchlist →
                </button>
              </div>
              {watch!.alerts
                .filter((a) => !a.seen)
                .slice(0, 3)
                .map((a) => (
                  <AlertRow key={a.id} a={a} compact />
                ))}
            </div>
          )}
          {data.insights.length === 0 && <p className="py-6 text-sm text-fg-3">Nothing stands out. Your storage looks tidy for the folders you scanned.</p>}
          {data.insights.map((ins, i) => (
            <motion.button
              key={ins.text}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.04 * i }}
              onClick={() => go(ins.target as View)}
              className="group flex items-center gap-4 rounded-[10px] bg-[var(--glass-0)] px-4 py-3 text-left shadow-[0_0_0_1px_var(--line)] transition-colors hover:bg-hover"
            >
              <span className="h-8 w-[3px] shrink-0 rounded-full" style={{ background: i === 0 ? "var(--accent)" : i === 1 ? "var(--violet)" : "var(--fg-4)" }} />
              <div className="min-w-0 flex-1">
                <div className="text-[14.5px] font-medium tracking-tight text-fg">{ins.text}</div>
                <div className="mt-0.5 text-xs text-fg-3">{ins.detail}</div>
              </div>
              <ArrowRight size={15} className="shrink-0 text-fg-4 transition-transform group-hover:translate-x-0.5 group-hover:text-fg-2" />
            </motion.button>
          ))}
          {!data.duplicates && (
            <div className="mt-auto flex items-center gap-3 rounded-[10px] px-4 py-3 text-sm shadow-[0_0_0_1px_var(--line)] [border-style:dashed]">
              <CopyCheck size={16} className="text-fg-3" />
              <span className="flex-1 text-fg-2">Duplicates are found by comparing file contents. This reads files and takes a while.</span>
              <Button size="sm" tone="subtle" disabled={dupRunning} onClick={() => go("duplicates")}>
                {dupRunning ? "Running…" : "Find duplicates"}
              </Button>
            </div>
          )}
        </div>
      </Panel>

      <Panel className="col-span-6 @min-[1100px]:col-span-4" title="By type">
        <CategoryBars cats={data.categories} onClick={(c) => go("large", { categories: [c] })} />
      </Panel>

      <Panel className="col-span-6 @min-[1100px]:col-span-4" title="Largest folders" actions={<LinkBtn onClick={() => go("analysis")}>Map</LinkBtn>}>
        <div className="space-y-0.5">
          {data.topFolders.map((f) => (
            <button key={f.id} onClick={() => inspect({ kind: "dir", id: f.id })} onDoubleClick={() => go("explorer", { dir: f.id })} className="group w-full rounded-[7px] px-2 py-1.5 text-left hover:bg-hover">
              <div className="flex items-center gap-2 text-sm">
                <FileIcon category="folder" size={14} />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="tabular text-xs text-fg-2">{bytes(f.size)}</span>
              </div>
              <div className="ml-6 mt-1 h-[3px] overflow-hidden rounded-full bg-active">
                <div className="h-full rounded-full bg-[var(--c-folder)] opacity-70 transition-[width] duration-700" style={{ width: `${(f.size / maxFolder) * 100}%` }} />
              </div>
            </button>
          ))}
        </div>
      </Panel>

      <Panel className="col-span-12 @min-[1100px]:col-span-4" title="Largest files" actions={<LinkBtn onClick={() => go("large")}>All</LinkBtn>}>
        <div className="space-y-0.5">
          {data.largestFiles.slice(0, 8).map((f) => (
            <button key={f.id} onClick={() => inspect({ kind: "file", id: f.id })} className="flex w-full items-center gap-2.5 rounded-[7px] px-2 py-1.5 text-left hover:bg-hover">
              <FileIcon category={f.category} size={14} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{f.name}</div>
                <div className="truncate text-2xs text-fg-4">
                  {shortPath(f.dir, 44)} · {ago(f.modified)}
                </div>
              </div>
              <span className="tabular text-xs text-fg-2">{bytes(f.size)}</span>
            </button>
          ))}
        </div>
      </Panel>

      <Panel className="col-span-12 @min-[1100px]:col-span-5" title="Review suggestions">
        <div className="flex items-end justify-between gap-4">
          <div>
            <Figure value={bytesParts(data.recBytes)[0]} unit={bytesParts(data.recBytes)[1]} className="text-3xl" />
            <p className="mt-1 text-sm text-fg-3">
              in {num(data.recCount)} files and folders worth a second look. Each one says why it was flagged.
            </p>
          </div>
          <Button tone="subtle" icon={<Lightbulb size={14} />} onClick={() => go("suggestions")}>
            Review
          </Button>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <MiniStat label="Unchanged for 1+ year" value={bytes(data.oldBytes1y)} sub={`${num(data.oldCount1y)} files`} onClick={() => go("old")} />
          <MiniStat label="Unchanged for 2+ years" value={bytes(data.oldBytes2y)} sub="by modification date" onClick={() => go("old")} />
          {data.duplicates && <MiniStat label="Duplicate copies" value={bytes(data.duplicates[1])} sub={`${num(data.duplicates[0])} groups, verified`} onClick={() => go("duplicates")} />}
          {data.downloads && <MiniStat label="Downloads folder" value={bytes(data.downloads.bytes)} sub={`${bytes(data.downloads.oldBytes)} older than 6 months`} onClick={() => go("downloads")} />}
        </div>
      </Panel>

      <Panel className="col-span-12 @min-[1100px]:col-span-7" title="Where files pile up" actions={<span className="text-2xs text-fg-4">Folders holding the most data directly</span>}>
        <div className="grid grid-cols-2 gap-x-4">
          {data.hotspots.slice(0, 8).map((d) => (
            <button key={d.id} onClick={() => inspect({ kind: "dir", id: d.id })} onDoubleClick={() => go("explorer", { dir: d.id })} className="flex items-center gap-2.5 rounded-[7px] px-2 py-1.5 text-left hover:bg-hover">
              <FileIcon category="folder" size={14} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{d.name}</div>
                <div className="truncate font-mono text-2xs text-fg-4">{shortPath(d.path, 40)}</div>
              </div>
              <span className="tabular text-xs text-fg-2">{bytes(d.ownSize)}</span>
            </button>
          ))}
        </div>
      </Panel>

      <div className="col-span-12 flex flex-wrap items-center gap-x-5 gap-y-1 px-1 text-2xs text-fg-4">
        <span>
          Scanned {dateTime(s.finishedAt)} in {duration(s.durationMs)}
          {s.cached && " · loaded from the last session"}
        </span>
        <span>
          {num(s.files)} files · {num(s.dirs)} folders
        </span>
        {s.errors > 0 && (
          <span className="inline-flex items-center gap-1" title="Folders Windows did not allow CLARITY to read. Their size is not included.">
            <AlertCircle size={11} /> {num(s.errors)} unreadable items
          </span>
        )}
        {s.linksSkipped > 0 && <span title="Symbolic links and junctions point elsewhere and are not followed, so nothing is counted twice.">{num(s.linksSkipped)} links not followed</span>}
        {data.cloudBytes > 0 && <span>{bytes(data.cloudBytes)} cloud-only (not stored locally)</span>}
        {s.cancelled && <span className="text-warn">Scan was cancelled; results are partial</span>}
        {s.cached && (
          <button className="inline-flex items-center gap-1 text-accent hover:underline" onClick={() => useApp.getState().set({ showScanSetup: true })}>
            <RotateCw size={11} /> Rescan for current data
          </button>
        )}
      </div>
    </div>
    </div>
  );
}

function LinkBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-2xs font-medium text-fg-3 hover:bg-hover hover:text-fg">
      {children} <ArrowRight size={11} />
    </button>
  );
}

function MiniStat({ label, value, sub, onClick }: { label: string; value: string; sub: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="rounded-[9px] bg-[var(--glass-0)] px-3 py-2.5 text-left shadow-[0_0_0_1px_var(--line)] transition-colors hover:bg-hover">
      <div className="text-2xs text-fg-3">{label}</div>
      <div className="tabular mt-0.5 text-base font-semibold tracking-tight">{value}</div>
      <div className="text-2xs text-fg-4">{sub}</div>
    </button>
  );
}

export function CategoryBars({ cats, onClick }: { cats: CategoryStat[]; onClick: (c: CategoryStat["category"]) => void }) {
  const shown = cats.filter((c) => c.bytes > 0);
  const max = Math.max(1, ...shown.map((c) => c.bytes));
  return (
    <div className="space-y-0.5">
      {shown.map((c, i) => (
        <button key={c.category} onClick={() => onClick(c.category)} className="group w-full rounded-[7px] px-2 py-1.5 text-left hover:bg-hover" title={`Show ${CATEGORY_LABEL[c.category].toLowerCase()}`}>
          <div className="flex items-center gap-2 text-sm">
            <span className="h-2 w-2 rounded-[3px]" style={{ background: catColor(c.category) }} />
            <span className="flex-1 truncate">{CATEGORY_LABEL[c.category]}</span>
            <span className="tabular text-2xs text-fg-4">{num(c.count)}</span>
            <span className="tabular w-16 text-right text-xs text-fg-2">{bytes(c.bytes)}</span>
          </div>
          <div className="ml-4 mt-1 h-[3px] overflow-hidden rounded-full bg-active">
            <motion.div className="h-full rounded-full" style={{ background: catColor(c.category) }} initial={{ width: 0 }} animate={{ width: `${(c.bytes / max) * 100}%` }} transition={{ delay: 0.03 * i, duration: 0.6, ease: [0.2, 0.8, 0.2, 1] }} />
          </div>
        </button>
      ))}
    </div>
  );
}

/** Signature ring: scanned data by type, set against the volume it lives on. */
function Lens({ data, onCategory }: { data: OV; onCategory: (c: CategoryStat["category"]) => void }) {
  const [hover, setHover] = useState<CategoryStat | null>(null);
  const s = data.scan;
  const vols = s.roots.filter((r) => r.volumeTotal != null);
  // De-duplicate roots on the same volume.
  const seen = new Set<string>();
  let volTotal = 0;
  let volFree = 0;
  for (const r of vols) {
    const k = `${r.volumeTotal}-${r.volumeFree}`;
    if (seen.has(k)) continue;
    seen.add(k);
    volTotal += r.volumeTotal!;
    volFree += r.volumeFree!;
  }
  const volUsed = volTotal - volFree;
  // Against the whole volume a small folder scan would be an invisible
  // sliver; then the ring shows the scanned data alone.
  const relative = volTotal > 0 && s.bytes / volTotal >= 0.03;
  const base = relative ? volTotal : Math.max(1, s.bytes);

  const R = 98;
  const C = 2 * Math.PI * R;
  const segs = useMemo(() => {
    let off = 0;
    const out: { c: CategoryStat; len: number; off: number }[] = [];
    for (const c of data.categories.filter((c) => c.bytes > 0)) {
      const len = (c.bytes / base) * C;
      out.push({ c, len, off });
      off += len;
    }
    return { out, end: off };
  }, [data, base]);
  const unscanned = relative ? Math.max(0, volUsed - s.bytes) : 0;
  const [big, unit] = bytesParts(hover ? hover.bytes : s.bytes);

  return (
    <div className="@container h-full">
    <div className="flex h-full flex-col items-center justify-center gap-5 @min-[520px]:flex-row @min-[520px]:gap-6">
      <div className="relative h-[236px] w-[236px] shrink-0">
        <svg viewBox="0 0 236 236" className="h-full w-full -rotate-90" onMouseLeave={() => setHover(null)}>
          <defs>
            <radialGradient id="lens-glass" cx="0.4" cy="0.35" r="0.75">
              <stop offset="0" stopColor="white" stopOpacity="0.07" />
              <stop offset="1" stopColor="white" stopOpacity="0" />
            </radialGradient>
          </defs>
          <circle cx="118" cy="118" r={R} fill="none" stroke="var(--line)" strokeWidth="16" />
          {unscanned > 0 && <circle cx="118" cy="118" r={R} fill="none" stroke="var(--fg-4)" strokeOpacity="0.35" strokeWidth="16" strokeDasharray={`${(unscanned / base) * C} ${C}`} strokeDashoffset={-segs.end} />}
          {segs.out.map(({ c, len, off }, i) => (
            <motion.circle
              key={c.category}
              cx="118"
              cy="118"
              r={R}
              fill="none"
              stroke={catColor(c.category)}
              strokeWidth={hover?.category === c.category ? 22 : 16}
              strokeDasharray={`${Math.max(0, len - 1.5)} ${C}`}
              strokeDashoffset={-off}
              initial={{ opacity: 0 }}
              animate={{ opacity: hover && hover.category !== c.category ? 0.35 : 1 }}
              transition={{ delay: 0.05 * i, duration: 0.35 }}
              style={{ cursor: "pointer", transition: "stroke-width 160ms" }}
              onMouseEnter={() => setHover(c)}
              onClick={() => onCategory(c.category)}
            />
          ))}
          <circle cx="118" cy="118" r="80" fill="url(#lens-glass)" />
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-2xs uppercase tracking-[0.12em] text-fg-3">{hover ? CATEGORY_LABEL[hover.category] : "Scanned"}</span>
          <Figure value={big} unit={unit} className="text-[34px] leading-tight" />
          <span className="tabular text-2xs text-fg-3">{hover ? `${num(hover.count)} files` : volTotal > 0 ? `of ${bytes(volUsed)} in use` : `${num(s.files)} files`}</span>
        </div>
      </div>
      <div className="w-full min-w-0 flex-1 space-y-2.5">
        {volTotal > 0 && (
          <>
            <Row label="Capacity" value={bytes(volTotal)} />
            <Row label="In use" value={bytes(volUsed)} dot="var(--fg-2)" />
            <Row label="Free" value={bytes(volFree)} dot="var(--line-2)" />
            <div className="h-px bg-[var(--line)]" />
          </>
        )}
        <Row label="Scanned" value={bytes(s.bytes)} dot="var(--accent)" />
        {volTotal > 0 && Math.max(0, volUsed - s.bytes) > 0 && <Row label="Not scanned" value={bytes(Math.max(0, volUsed - s.bytes))} dot={relative ? "var(--fg-4)" : undefined} hint="Space Windows reports as used but CLARITY did not count: the skipped Windows folder, restore points and shadow copies (System Volume Information), the Recycle Bin, excluded or unreadable folders, NTFS metadata, and anything outside your selection." />}
        {volTotal > 0 && Math.max(0, volUsed - s.bytes) > 0 && <p className="-mt-1 pl-4 text-2xs leading-relaxed text-fg-4">Windows folder, restore points, Recycle Bin, excluded or unreadable folders.</p>}
        <p className="pt-1 text-2xs leading-relaxed text-fg-4">Hover the ring for a type, click it to see those files.</p>
      </div>
    </div>
    </div>
  );
}

function Row({ label, value, dot, hint }: { label: string; value: string; dot?: string; hint?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm" title={hint}>
      {dot && <span className={clsx("h-2 w-2 rounded-full")} style={{ background: dot }} />}
      <span className="flex-1 text-fg-3">{label}</span>
      <span className="tabular font-medium">{value}</span>
    </div>
  );
}
