import clsx from "clsx";
import { AlertTriangle, ArrowDownRight, ArrowRight, ArrowUpRight, HardDrive, History, Unplug } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileIcon } from "../components/FileIcon";
import { Badge, Chip, Empty, Panel, Segmented, Spinner } from "../components/ui";
import { api, errorText } from "../lib/api";
import { bytes, CATEGORY_LABEL, catColor, date, dateTime, num, nowUnix } from "../lib/format";
import type { Category, Comparison, Delta, Highlight, TimelinePoint, TimelineRoot } from "../lib/types";
import { useApp } from "../store/app";

type Range = 7 | 30 | 90 | 365 | 0;
const RANGES: { value: Range; label: string }[] = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: 365, label: "1 year" },
  { value: 0, label: "All time" },
];

/** Signed size, e.g. "+5.2 GB" / "−1.1 GB". */
export function signedBytes(n: number): string {
  if (n === 0) return "±0 B";
  return `${n > 0 ? "+" : "−"}${bytes(Math.abs(n))}`;
}

const comparable = (p: TimelinePoint) => p.complete;

export function Timeline() {
  const version = useApp((s) => s.version);
  const scan = useApp((s) => s.scan);
  const [roots, setRoots] = useState<TimelineRoot[] | null>(null);
  const [root, setRoot] = useState<number | null>(null);
  const [range, setRange] = useState<Range>(90);
  const [mode, setMode] = useState<"total" | "types">("total");
  const [points, setPoints] = useState<TimelinePoint[] | null>(null);
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const [cmp, setCmp] = useState<Comparison | null>(null);
  const [cmpError, setCmpError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api()
      .timelineRoots()
      .then((r) => {
        setRoots(r);
        // Prefer the location of the current scan.
        const current = scan?.roots.map((x) => x.path.toLowerCase()) ?? [];
        setRoot((prev) => (prev != null && r.some((x) => x.id === prev) ? prev : (r.find((x) => current.includes(x.path.toLowerCase())) ?? r[0])?.id ?? null));
      }, (e) => setError(errorText(e)));
  }, [version]);

  useEffect(() => {
    if (root == null) return;
    const since = range ? nowUnix() - range * 86400 : 0;
    setPoints(null);
    api()
      .timelineSeries(root, since)
      .then((p) => {
        setPoints(p);
        // Default comparison: the two latest complete snapshots.
        const ok = p.filter(comparable);
        setTo(ok.length ? ok[ok.length - 1].snapshotId : null);
        setFrom(ok.length > 1 ? ok[ok.length - 2].snapshotId : null);
      }, (e) => setError(errorText(e)));
  }, [root, range, version]);

  useEffect(() => {
    setCmp(null);
    setCmpError(null);
    if (root == null || from == null || to == null || from === to) return;
    api().timelineCompare(root, from, to).then(setCmp, (e) => setCmpError(errorText(e)));
  }, [root, from, to]);

  if (error) return <Empty title="Could not load the timeline">{error}</Empty>;
  if (!roots || (root != null && !points))
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  if (roots.length === 0)
    return (
      <Empty icon={<History size={18} />} title="Your timeline starts with your next scan">
        After every scan CLARITY keeps a compact snapshot (totals, types, larger folders and files) so you can see what changed over time.
      </Empty>
    );

  const current = roots.find((r) => r.id === root)!;
  const pts = points ?? [];
  const pick = (p: TimelinePoint) => {
    if (!comparable(p)) return;
    // Clicking a point compares it with the latest complete snapshot; clicking
    // the latest one picks it as the end of the range instead.
    const latest = [...pts].reverse().find(comparable);
    if (latest && p.snapshotId === latest.snapshotId) setTo(p.snapshotId);
    else setFrom(p.snapshotId);
  };

  return (
    <div className="scroll -mx-1 h-full px-1 pb-24">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {roots.map((r) => (
          <Chip key={r.id} active={r.id === root} onClick={() => setRoot(r.id)}>
            {r.available ? <HardDrive size={11} /> : <Unplug size={11} />}
            <span className="max-w-[220px] truncate">{r.path}</span>
            <span className="text-fg-4">{r.snapshots}</span>
          </Chip>
        ))}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <Segmented size="sm" value={mode} onChange={setMode} options={[{ value: "total", label: "Total" }, { value: "types", label: "By type" }]} />
          <Segmented size="sm" value={range} onChange={setRange} options={RANGES} />
        </div>
      </div>

      {!current.available && (
        <Notice icon={<Unplug size={14} />}>
          {current.path} is not connected right now. Its history is still shown; new snapshots are added the next time you scan it.
        </Notice>
      )}

      <Panel className="mb-3" title="Storage over time" actions={<Legend mode={mode} points={pts} />} pad={false}>
        {pts.length === 0 ? (
          <div className="px-4 pb-6 pt-2 text-sm text-fg-3">No scans of this location in the selected period. {current.lastAt ? `The latest is from ${date(current.lastAt)}.` : ""}</div>
        ) : (
          <Chart points={pts} mode={mode} from={from} to={to} onPick={pick} />
        )}
      </Panel>

      {pts.filter(comparable).length < 2 ? (
        <div className="glass-thin px-5 py-4 text-sm text-fg-3">
          {pts.filter(comparable).length === 1 ? "Only one complete scan in this period. Scan again later, or widen the range, to see what changed." : "No complete scans in this period yet."}
        </div>
      ) : (
        <>
          <ComparePicker points={pts} from={from} to={to} setFrom={setFrom} setTo={setTo} />
          {cmpError && <Notice icon={<AlertTriangle size={14} />}>{cmpError}</Notice>}
          {!cmp && !cmpError && from !== to && (
            <div className="flex h-32 items-center justify-center">
              <Spinner />
            </div>
          )}
          <AnimatePresence mode="wait">{cmp && <CompareView key={`${cmp.from.snapshotId}-${cmp.to.snapshotId}`} c={cmp} />}</AnimatePresence>
        </>
      )}
    </div>
  );
}

function Notice({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="mb-3 flex gap-2 rounded-[9px] bg-[var(--warn-soft)] px-3 py-2 text-xs leading-relaxed text-warn">
      <span className="mt-[1px] shrink-0">{icon}</span>
      <span>{children}</span>
    </div>
  );
}

function Legend({ mode, points }: { mode: "total" | "types"; points: TimelinePoint[] }) {
  const hasVolume = points.some((p) => p.volumeUsed != null && p.bytes >= p.volumeUsed * 0.2);
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 whitespace-nowrap text-2xs text-fg-3">
      {mode === "total" ? (
        <>
          <span className="flex items-center gap-1.5">
            <span className="h-[2px] w-3 rounded bg-accent" /> Scanned
          </span>
          {hasVolume && (
            <span className="flex items-center gap-1.5">
              <span className="h-0 w-3 border-t border-dashed border-[var(--fg-3)]" /> Drive in use
            </span>
          )}
        </>
      ) : (
        <span>Stacked by file type (complete scans only)</span>
      )}
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full border border-[var(--fg-3)]" /> partial / totals only
      </span>
    </div>
  );
}

// ----------------------------------------------------------------- chart

const H = 230;
const PAD = { l: 58, r: 18, t: 14, b: 26 };
const TYPE_ORDER: Category[] = ["video", "apps", "other", "system", "archives", "installers", "images", "audio", "code", "documents"];

function Chart({ points, mode, from, to, onPick }: { points: TimelinePoint[]; mode: "total" | "types"; from: number | null; to: number | null; onPick: (p: TimelinePoint) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const typed = points.filter((p) => Object.keys(p.categories).length > 0);
  const series = mode === "types" ? typed : points;
  // The drive line only shares the scale when the scan covers a good part of
  // the drive; for a small folder it would flatten the scanned line to zero.
  const showVolume = mode === "total" && series.some((p) => p.volumeUsed != null && p.bytes >= p.volumeUsed * 0.2);

  const geo = useMemo(() => {
    const t0 = Math.min(...series.map((p) => p.takenAt));
    const t1 = Math.max(...series.map((p) => p.takenAt), t0 + 3600);
    const vals = showVolume ? series.flatMap((p) => [p.bytes, p.volumeUsed ?? p.bytes]) : series.map((p) => p.bytes);
    let lo = mode === "types" ? 0 : Math.min(...vals);
    let hi = Math.max(...vals, 1);
    // Zoom in on the band where things change, but never pretend precision.
    const span = Math.max(hi - lo, hi * 0.04);
    lo = Math.max(0, lo - span * 0.25);
    hi = hi + span * 0.15;
    // Scans only minutes apart would sit on top of each other on a time
    // axis; then they are spaced evenly in order instead.
    const byIndex = series.length > 1 && t1 - t0 < 6 * 3600;
    const order = new Map(series.map((p, i) => [p.takenAt, i]));
    const x = (t: number) =>
      series.length === 1
        ? (PAD.l + w - PAD.r) / 2
        : byIndex
          ? PAD.l + ((order.get(t) ?? 0) / (series.length - 1)) * (w - PAD.l - PAD.r)
          : PAD.l + ((t - t0) / (t1 - t0)) * (w - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
    const ticks = Array.from({ length: 4 }, (_, i) => lo + ((hi - lo) * i) / 3);
    return { x, y, ticks, t0, t1 };
  }, [series, w, mode, showVolume]);

  // Gaps much longer than the usual scan interval are drawn dashed.
  const gaps = useMemo(() => {
    const iv = series.slice(1).map((p, i) => p.takenAt - series[i].takenAt).sort((a, b) => a - b);
    const median = iv.length ? iv[Math.floor(iv.length / 2)] : 0;
    return series.slice(1).map((p, i) => median > 0 && p.takenAt - series[i].takenAt > Math.max(median * 3, 14 * 86400));
  }, [series]);

  const fromP = points.find((p) => p.snapshotId === from);
  const toP = points.find((p) => p.snapshotId === to);
  const hovered = hover != null ? series[hover] : null;

  const path = (vals: number[]) => vals.map((v, i) => `${i ? "L" : "M"}${geo.x(series[i].takenAt).toFixed(1)},${geo.y(v).toFixed(1)}`).join(" ");

  const stacks = useMemo(() => {
    if (mode !== "types" || !w) return [];
    const acc = series.map(() => 0);
    return TYPE_ORDER.map((c) => {
      const lower = [...acc];
      series.forEach((p, i) => (acc[i] += p.categories[c] ?? 0));
      const upper = [...acc];
      if (upper.every((v, i) => v === lower[i])) return null;
      const top = upper.map((v, i) => `${i ? "L" : "M"}${geo.x(series[i].takenAt).toFixed(1)},${geo.y(v).toFixed(1)}`).join(" ");
      const bottom = lower
        .map((v, i) => [geo.x(series[i].takenAt).toFixed(1), geo.y(v).toFixed(1)])
        .reverse()
        .map(([px, py]) => `L${px},${py}`)
        .join(" ");
      return { c, d: `${top} ${bottom} Z` };
    }).filter(Boolean) as { c: Category; d: string }[];
  }, [series, mode, w, geo]);

  return (
    <div ref={ref} className="relative px-1 pb-2" onMouseLeave={() => setHover(null)}>
      {w > 0 && series.length > 0 && (
        <svg width={w} height={H} className="block">
          <defs>
            <linearGradient id="tl-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--accent)" stopOpacity="0.28" />
              <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {geo.ticks.map((t, i) => (
            <g key={i}>
              <line x1={PAD.l} x2={w - PAD.r} y1={geo.y(t)} y2={geo.y(t)} stroke="var(--line)" />
              <text x={PAD.l - 8} y={geo.y(t) + 3} textAnchor="end" className="fill-[var(--fg-4)] text-[10px] tabular-nums">
                {bytes(t, 0)}
              </text>
            </g>
          ))}
          {fromP && toP && (
            <rect x={geo.x(Math.min(fromP.takenAt, toP.takenAt))} y={PAD.t} width={Math.max(2, Math.abs(geo.x(toP.takenAt) - geo.x(fromP.takenAt)))} height={H - PAD.t - PAD.b} fill="var(--accent-soft)" rx={4} />
          )}
          {mode === "types" ? (
            stacks.map((s) => <motion.path key={s.c} d={s.d} fill={catColor(s.c)} fillOpacity={0.55} stroke={catColor(s.c)} strokeOpacity={0.8} strokeWidth={0.8} initial={{ opacity: 0 }} animate={{ opacity: 1 }} />)
          ) : (
            <>
              {series.length > 1 && (
                <motion.path
                  key={`area-${series.length}`}
                  d={`${path(series.map((p) => p.bytes))} L${geo.x(series[series.length - 1].takenAt)},${H - PAD.b} L${geo.x(series[0].takenAt)},${H - PAD.b} Z`}
                  fill="url(#tl-area)"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                />
              )}
              {series.slice(1).map((p, i) => (
                <line key={`s${i}`} x1={geo.x(series[i].takenAt)} y1={geo.y(series[i].bytes)} x2={geo.x(p.takenAt)} y2={geo.y(p.bytes)} stroke="var(--accent)" strokeWidth={2} strokeLinecap="round" strokeDasharray={gaps[i] ? "3 4" : undefined} opacity={gaps[i] ? 0.6 : 1} />
              ))}
              {showVolume && (
                <path d={series.map((p, i) => (p.volumeUsed == null ? "" : `${i && series[i - 1].volumeUsed != null ? "L" : "M"}${geo.x(p.takenAt).toFixed(1)},${geo.y(p.volumeUsed).toFixed(1)}`)).join(" ")} fill="none" stroke="var(--fg-3)" strokeWidth={1.2} strokeDasharray="4 4" />
              )}
            </>
          )}
          {hovered && <line x1={geo.x(hovered.takenAt)} x2={geo.x(hovered.takenAt)} y1={PAD.t} y2={H - PAD.b} stroke="var(--line-2)" />}
          {series.map((p, i) => {
            const on = p.snapshotId === from || p.snapshotId === to;
            const solid = p.complete && !p.legacy;
            return (
              <g key={p.snapshotId} onMouseEnter={() => setHover(i)} onClick={() => onPick(p)} style={{ cursor: p.complete ? "pointer" : "default" }}>
                <circle cx={geo.x(p.takenAt)} cy={geo.y(p.bytes)} r={14} fill="transparent" />
                <circle cx={geo.x(p.takenAt)} cy={geo.y(p.bytes)} r={on ? 5.5 : 3.8} fill={solid ? (on ? "var(--accent-strong)" : "var(--accent)") : "var(--glass-solid)"} stroke={solid ? "var(--glass-solid)" : "var(--fg-3)"} strokeWidth={solid ? 2 : 1.5} className="transition-all duration-150" />
              </g>
            );
          })}
          <text x={PAD.l} y={H - 6} className="fill-[var(--fg-4)] text-[10px]">
            {date(geo.t0)}
          </text>
          <text x={w - PAD.r} y={H - 6} textAnchor="end" className="fill-[var(--fg-4)] text-[10px]">
            {date(geo.t1)}
          </text>
        </svg>
      )}
      {mode === "types" && typed.length === 0 && <div className="absolute inset-0 flex items-center justify-center text-sm text-fg-3">No type breakdown in this period (only partial or older scans).</div>}
      {hovered && (
        <div className="glass-float pointer-events-none absolute top-2 z-10 min-w-[190px] px-3 py-2 text-xs" style={{ left: Math.min(Math.max(geo.x(hovered.takenAt) - 95, 8), w - 210) }}>
          <div className="font-medium text-fg">{dateTime(hovered.takenAt)}</div>
          <div className="tabular mt-1 flex justify-between gap-4 text-fg-2">
            <span>Scanned</span>
            <span>{bytes(hovered.bytes)}</span>
          </div>
          {hover! > 0 && (
            <div className="tabular flex justify-between gap-4 text-fg-3">
              <span>vs. previous</span>
              <span>{signedBytes(hovered.bytes - series[hover! - 1].bytes)}</span>
            </div>
          )}
          {hovered.volumeUsed != null && (
            <div className="tabular flex justify-between gap-4 text-fg-3">
              <span>Drive in use</span>
              <span>{bytes(hovered.volumeUsed)}</span>
            </div>
          )}
          <div className="mt-1 text-2xs text-fg-4">{!hovered.complete ? "Scan was cancelled: partial total, not comparable" : hovered.legacy ? "Older scan: total only" : `${num(hovered.files)} files · click to compare`}</div>
        </div>
      )}
    </div>
  );
}

function ComparePicker({ points, from, to, setFrom, setTo }: { points: TimelinePoint[]; from: number | null; to: number | null; setFrom: (n: number) => void; setTo: (n: number) => void }) {
  const ok = points.filter(comparable);
  const sel = (value: number | null, onChange: (n: number) => void, label: string) => (
    <label className="flex items-center gap-2 text-xs text-fg-3">
      {label}
      <select
        value={value ?? ""}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-7 rounded-[7px] bg-hover px-2 text-xs text-fg shadow-[0_0_0_1px_var(--line-2)] outline-none [&>option]:bg-[var(--glass-solid)]"
      >
        {ok.map((p) => (
          <option key={p.snapshotId} value={p.snapshotId}>
            {dateTime(p.takenAt)} · {bytes(p.bytes)}
            {p.legacy ? " (total only)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 px-1">
      <span className="text-sm font-medium">Compare</span>
      {sel(from, setFrom, "from")}
      <ArrowRight size={13} className="text-fg-4" />
      {sel(to, setTo, "to")}
      <span className="text-2xs text-fg-4">Tip: click a point in the chart to compare it with the latest scan.</span>
    </div>
  );
}

// -------------------------------------------------------------- comparison

function useInvestigate() {
  const inspect = useApp((s) => s.inspect);
  const go = useApp((s) => s.go);
  const toast = useApp((s) => s.toast);
  return async (path: string | null, opts?: { category?: Category | null }) => {
    if (opts?.category) {
      go("large", { categories: [opts.category] });
      return;
    }
    if (!path) return;
    const hit = await api().locatePath(path).catch(() => null);
    if (!hit) {
      toast("This item is not in the current scan: it was removed, or lies outside the scanned folders.");
      return;
    }
    if (hit.kind === "dir") {
      inspect(hit);
      go("explorer", { dir: hit.id });
    } else inspect(hit);
  };
}

function CompareView({ c }: { c: Comparison }) {
  const investigate = useInvestigate();
  const [tab, setTab] = useState<"added" | "deleted" | "modified">("added");
  const days = Math.max(0, Math.round((c.to.takenAt - c.from.takenAt) / 86400));
  const grewMax = Math.max(1, ...c.grew.map((d) => Math.abs(d.delta)), ...c.shrank.map((d) => Math.abs(d.delta)));
  const fileTabs = { added: c.added, deleted: c.deleted, modified: c.modified };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} className="@container space-y-3">
      <div className="glass edge-light flex flex-wrap items-center gap-x-8 gap-y-3 px-5 py-4">
        <div>
          <div className={clsx("tabular text-[30px] font-semibold leading-tight tracking-tight", c.delta > 0 ? "text-warn" : c.delta < 0 ? "text-ok" : "text-fg")}>{signedBytes(c.delta)}</div>
          <div className="text-xs text-fg-3">
            {date(c.from.takenAt)} → {date(c.to.takenAt)} · {days === 0 ? "same day" : `${days} day${days === 1 ? "" : "s"}`}
          </div>
        </div>
        <Stat label="Scanned" value={`${bytes(c.from.bytes)} → ${bytes(c.to.bytes)}`} />
        <button
          onClick={() => {
            const tz = -new Date().getTimezoneOffset() * 60;
            useApp.getState().set({ analysisTab: "activity", activityFocus: { fromDay: Math.floor((c.from.takenAt + tz) / 86400), toDay: Math.floor((c.to.takenAt + tz) / 86400) } });
          }}
          className="ml-auto flex items-center gap-1 rounded-[7px] px-2 py-1 text-xs text-fg-3 shadow-[0_0_0_1px_var(--line-2)] hover:bg-hover hover:text-fg"
          title="Show which files were created or changed in this period"
        >
          File activity in this period <ArrowRight size={12} />
        </button>
        <Stat label="Files" value={`${c.filesDelta >= 0 ? "+" : "−"}${num(Math.abs(c.filesDelta))}`} />
        {c.volumeUsedDelta != null && <Stat label="Drive in use" value={signedBytes(c.volumeUsedDelta)} hint="Everything on the drive, including what was not scanned." />}
      </div>

      {c.warnings.map((w) => (
        <Notice key={w} icon={<AlertTriangle size={14} />}>
          {w}
        </Notice>
      ))}

      {c.highlights.length > 0 && (
        <div className="grid grid-cols-1 gap-2 @min-[720px]:grid-cols-2">
          {c.highlights.map((h, i) => (
            <HighlightCard key={i} h={h} i={i} onClick={() => investigate(h.path, { category: h.kind === "category" ? h.category : null })} />
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 @min-[900px]:grid-cols-2">
        <Panel title="Folders that grew" actions={<span className="text-2xs text-fg-4">most specific first</span>}>
          {!c.hasFolderDetail ? <NoDetail /> : c.grew.length === 0 ? <Quiet>No folder grew noticeably.</Quiet> : c.grew.map((d) => <DeltaRow key={d.path} d={d} max={grewMax} onClick={() => investigate(d.path)} />)}
        </Panel>
        <Panel title="Folders that shrank">
          {!c.hasFolderDetail ? <NoDetail /> : c.shrank.length === 0 ? <Quiet>No folder shrank noticeably.</Quiet> : c.shrank.map((d) => <DeltaRow key={d.path} d={d} max={grewMax} onClick={() => investigate(d.path)} />)}
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-3 @min-[900px]:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Panel title="By type">{c.categories.length === 0 ? <NoDetail /> : <CategoryDeltas c={c} />}</Panel>
        <Panel
          title="Large files"
          pad={false}
          actions={
            <Segmented
              size="sm"
              value={tab}
              onChange={setTab}
              options={[
                { value: "added", label: `Added ${c.added.count}` },
                { value: "deleted", label: `Removed ${c.deleted.count}` },
                { value: "modified", label: `Changed ${c.modified.count}` },
              ]}
            />
          }
        >
          <div className="px-2 pb-3">
            {!c.hasFileDetail ? (
              <div className="px-2">
                <NoDetail files />
              </div>
            ) : fileTabs[tab].items.length === 0 ? (
              <Quiet>Nothing here.</Quiet>
            ) : (
              <>
                {fileTabs[tab].items.map((d) => (
                  <button key={d.path} onClick={() => investigate(d.path)} className="flex w-full items-center gap-2.5 rounded-[7px] px-2 py-1.5 text-left hover:bg-hover">
                    <FileIcon category={d.category ?? "other"} size={14} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{d.name}</div>
                      <div className="truncate font-mono text-2xs text-fg-4">{d.path}</div>
                    </div>
                    <div className="text-right">
                      <div className={clsx("tabular text-xs font-medium", d.delta > 0 ? "text-warn" : "text-ok")}>{signedBytes(d.delta)}</div>
                      {tab === "modified" && (
                        <div className="tabular text-2xs text-fg-4">
                          {bytes(d.before)} → {bytes(d.after)}
                        </div>
                      )}
                    </div>
                  </button>
                ))}
                {fileTabs[tab].count > fileTabs[tab].items.length && <div className="px-2 pt-1 text-2xs text-fg-4">Showing the {fileTabs[tab].items.length} biggest of {num(fileTabs[tab].count)}.</div>}
              </>
            )}
          </div>
        </Panel>
      </div>
      <p className="px-1 text-2xs leading-relaxed text-fg-4">
        Snapshots stay compact: files of {bytes(c.fileMin)} or more and folders of {bytes(c.dirMin)} or more are tracked individually. Smaller ones are included in the totals and type figures. Folders that crossed the {bytes(c.dirMin)} line count as new or gone.
      </p>
    </motion.div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div title={hint}>
      <div className="text-2xs uppercase tracking-[0.1em] text-fg-4">{label}</div>
      <div className="tabular text-sm font-medium text-fg">{value}</div>
    </div>
  );
}

function HighlightCard({ h, i, onClick }: { h: Highlight; i: number; onClick: () => void }) {
  const up = h.delta > 0;
  const clickable = h.kind === "category" || !!h.path;
  return (
    <motion.button
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.03 * i }}
      onClick={clickable ? onClick : undefined}
      className={clsx("group flex items-center gap-3 rounded-[10px] bg-[var(--glass-0)] px-4 py-3 text-left shadow-[0_0_0_1px_var(--line)] transition-colors", clickable ? "hover:bg-hover" : "cursor-default")}
    >
      <span className={clsx("flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px]", up ? "bg-[var(--warn-soft)] text-warn" : "bg-[var(--ok-soft)] text-ok")}>{up ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-fg">{h.text}</div>
        <div className="truncate text-xs text-fg-3">{h.detail}</div>
      </div>
      {clickable && <ArrowRight size={14} className="shrink-0 text-fg-4 transition-transform group-hover:translate-x-0.5" />}
    </motion.button>
  );
}

function DeltaRow({ d, max, onClick }: { d: Delta; max: number; onClick: () => void }) {
  return (
    <button onClick={onClick} className="w-full rounded-[7px] px-2 py-1.5 text-left hover:bg-hover" title={d.path}>
      <div className="flex items-center gap-2 text-sm">
        <FileIcon category="folder" size={13} />
        <span className="min-w-0 flex-1 truncate">{d.name}</span>
        {d.status !== "changed" && <Badge tone={d.status === "added" ? "warn" : "ok"}>{d.status === "added" ? "new" : "gone"}</Badge>}
        <span className={clsx("tabular text-xs font-medium", d.delta > 0 ? "text-warn" : "text-ok")}>{signedBytes(d.delta)}</span>
      </div>
      <div className="ml-5 mt-0.5 flex items-center gap-2">
        <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-active">
          <motion.div className={clsx("h-full rounded-full", d.delta > 0 ? "bg-warn" : "bg-ok")} initial={{ width: 0 }} animate={{ width: `${(Math.abs(d.delta) / max) * 100}%` }} transition={{ duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }} />
        </div>
        <span className="tabular w-[120px] shrink-0 truncate text-right text-2xs text-fg-4">
          {bytes(d.before)} → {bytes(d.after)}
        </span>
      </div>
    </button>
  );
}

function CategoryDeltas({ c }: { c: Comparison }) {
  const max = Math.max(1, ...c.categories.map((x) => Math.abs(x.delta)));
  const go = useApp((s) => s.go);
  return (
    <div className="space-y-1">
      {c.categories.slice(0, 10).map((x) => (
        <button key={x.category} onClick={() => go("large", { categories: [x.category] })} className="grid w-full grid-cols-[110px_1fr_74px] items-center gap-2 rounded-[6px] px-1 py-1 text-left text-xs hover:bg-hover">
          <span className="flex items-center gap-1.5 truncate text-fg-2">
            <span className="h-2 w-2 shrink-0 rounded-[3px]" style={{ background: catColor(x.category) }} />
            {CATEGORY_LABEL[x.category].split(" ")[0]}
          </span>
          {/* Diverging bar: shrink to the left, growth to the right. */}
          <div className="relative h-2">
            <div className="absolute inset-y-0 left-1/2 w-px bg-[var(--line-2)]" />
            <motion.div
              className="absolute inset-y-0 rounded-full"
              style={{ background: catColor(x.category), [x.delta > 0 ? "left" : "right"]: "50%" }}
              initial={{ width: 0 }}
              animate={{ width: `${(Math.abs(x.delta) / max) * 50}%` }}
              transition={{ duration: 0.5 }}
            />
          </div>
          <span className={clsx("tabular text-right font-medium", x.delta > 0 ? "text-warn" : "text-ok")}>{signedBytes(x.delta)}</span>
        </button>
      ))}
    </div>
  );
}

function NoDetail({ files }: { files?: boolean }) {
  return <Quiet>{files ? "File-level detail is not available for this pair: one of the scans is partial, from before the timeline, or older than the detail CLARITY keeps (the 24 most recent scans)." : "Not available for this pair: one of the scans is partial or from before the timeline existed."}</Quiet>;
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="py-3 text-xs leading-relaxed text-fg-3">{children}</p>;
}
