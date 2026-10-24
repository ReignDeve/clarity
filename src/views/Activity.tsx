import clsx from "clsx";
import { CalendarDays, Info, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FileList } from "../components/FileList";
import { Chip, Empty, IconButton, Panel, Segmented, Spinner } from "../components/ui";
import { api, errorText } from "../lib/api";
import { bytes, CATEGORY_LABEL, catColor, num } from "../lib/format";
import type { Activity, Category, DirRow } from "../lib/types";
import { useApp } from "../store/app";

const DAY = 86400;
const tzOffsetMin = () => -new Date().getTimezoneOffset();
const today = () => Math.floor((Date.now() / 1000 + tzOffsetMin() * 60) / DAY);
/** Local day number → Date (UTC fields hold the local calendar date). */
const dayDate = (d: number) => new Date(d * DAY * 1000);
const fmtDay = (d: number) => dayDate(d).toLocaleDateString(undefined, { timeZone: "UTC", weekday: "short", year: "numeric", month: "short", day: "numeric" });
const TYPES: Category[] = ["images", "video", "documents", "audio", "archives", "code", "installers", "apps", "system", "other"];

type Range = { kind: "last" } | { kind: "year"; year: number } | { kind: "focus"; fromDay: number; toDay: number };

export function ActivityView() {
  const version = useApp((s) => s.version);
  const focus = useApp((s) => s.activityFocus);
  const set = useApp((s) => s.set);
  const [field, setField] = useState<"created" | "modified">("modified");
  const [metric, setMetric] = useState<"files" | "bytes">("files");
  const [range, setRange] = useState<Range>(focus ? { kind: "focus", ...focus } : { kind: "last" });
  const [cats, setCats] = useState<Category[]>([]);
  const [loc, setLoc] = useState<number | null>(null);
  const [locs, setLocs] = useState<DirRow[]>([]);
  const [data, setData] = useState<Activity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    if (focus) {
      setRange({ kind: "focus", ...focus });
      set({ activityFocus: null });
    }
  }, [focus]);

  useEffect(() => {
    (async () => {
      const top = await api().listDir(null);
      const out: DirRow[] = [];
      for (const r of top.dirs) {
        out.push(r);
        out.push(...(await api().listDir(r.id)).dirs.slice(0, 15));
      }
      setLocs(out);
    })().catch(() => {});
  }, [version]);

  // The calendar always shows whole weeks (Monday first).
  const { fromDay, toDay } = useMemo(() => {
    let from: number, to: number;
    if (range.kind === "year") {
      from = Math.floor(Date.UTC(range.year, 0, 1) / 1000 / DAY);
      to = Math.floor(Date.UTC(range.year, 11, 31) / 1000 / DAY);
    } else if (range.kind === "focus") {
      // Widen short periods so they sit inside some context.
      const span = range.toDay - range.fromDay;
      from = range.fromDay - Math.max(14, Math.round(span * 0.2));
      to = Math.min(today(), range.toDay + Math.max(14, Math.round(span * 0.2)));
      if (to - from < 120) from = to - 120;
    } else {
      to = today();
      from = to - 364;
    }
    const dow = (dayDate(from).getUTCDay() + 6) % 7; // Monday = 0
    return { fromDay: from - dow, toDay: to };
  }, [range]);

  useEffect(() => {
    setData(null);
    setError(null);
    api()
      .fileActivity({ field, categories: cats, underDir: loc, fromDay, toDay, tzOffsetMin: tzOffsetMin() })
      .then(setData, (e) => setError(errorText(e)));
  }, [field, cats, loc, fromDay, toDay, version]);

  const years = useMemo(() => {
    if (!data?.firstDay || !data.lastDay) return [];
    const a = dayDate(data.firstDay).getUTCFullYear();
    const b = dayDate(data.lastDay).getUTCFullYear();
    return Array.from({ length: Math.min(30, b - a + 1) }, (_, i) => b - i);
  }, [data?.firstDay, data?.lastDay]);

  if (error) return <Empty title="Could not load activity">{error}</Empty>;

  const sel = selected != null ? data?.days.find((d) => d.day === selected) : null;
  const dayStart = (d: number) => d * DAY - tzOffsetMin() * 60;

  return (
    <div className="scroll -mx-1 h-full px-1 pb-24">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented size="sm" value={field} onChange={setField} options={[{ value: "modified", label: "Modified" }, { value: "created", label: "Created" }]} />
        <Segmented size="sm" value={metric} onChange={setMetric} options={[{ value: "files", label: "Number of files" }, { value: "bytes", label: "Data volume" }]} />
        <select
          value={range.kind === "year" ? String(range.year) : range.kind}
          onChange={(e) => setRange(e.target.value === "last" ? { kind: "last" } : { kind: "year", year: Number(e.target.value) })}
          className="h-7 rounded-[7px] bg-hover px-2 text-xs text-fg shadow-[0_0_0_1px_var(--line-2)] outline-none [&>option]:bg-[var(--glass-solid)]"
          aria-label="Period"
        >
          {range.kind === "focus" && <option value="focus">Timeline period</option>}
          <option value="last">Last 12 months</option>
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <select value={loc ?? ""} onChange={(e) => setLoc(e.target.value === "" ? null : Number(e.target.value))} className="h-7 max-w-[240px] rounded-[7px] bg-hover px-2 text-xs text-fg shadow-[0_0_0_1px_var(--line-2)] outline-none [&>option]:bg-[var(--glass-solid)]" aria-label="Location">
          <option value="">All scanned locations</option>
          {locs.map((l) => (
            <option key={l.id} value={l.id}>
              {l.path.length > 40 ? `…${l.path.slice(-38)}` : l.path}
            </option>
          ))}
        </select>
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        <Chip active={cats.length === 0} onClick={() => setCats([])}>
          All types
        </Chip>
        {TYPES.map((c) => (
          <Chip key={c} color={catColor(c)} active={cats.includes(c)} onClick={() => setCats(cats.includes(c) ? cats.filter((x) => x !== c) : [...cats, c])}>
            {CATEGORY_LABEL[c].split(" ")[0]}
          </Chip>
        ))}
      </div>

      <Panel
        title={field === "modified" ? "Files changed per day" : "Files created per day"}
        actions={
          data && (
            <span className="tabular text-2xs text-fg-3">
              {num(data.totalFiles)} files · {bytes(data.totalBytes)}
            </span>
          )
        }
      >
        {!data ? (
          <div className="flex h-40 items-center justify-center">
            <Spinner />
          </div>
        ) : (
          <Heatmap data={data} fromDay={fromDay} toDay={toDay} metric={metric} selected={selected} focus={range.kind === "focus" ? range : null} onSelect={(d) => setSelected(d === selected ? null : d)} />
        )}
        <div className="mt-3 flex flex-wrap items-start gap-x-6 gap-y-2 text-2xs text-fg-3">
          <span className="flex items-center gap-2">
            Less
            {[0, 1, 2, 3, 4].map((l) => (
              <span key={l} className="h-[10px] w-[10px] rounded-[2px]" style={{ background: level(l) }} />
            ))}
            More
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-[10px] w-[10px] rounded-[2px] shadow-[0_0_0_1.5px_var(--violet)]" /> observed by CLARITY (scan or cleanup)
          </span>
          <span className="flex max-w-[620px] items-start gap-1.5 text-fg-4">
            <Info size={12} className="mt-[1px] shrink-0" />
            Squares are file timestamps as the files report them. Copying or extracting files can change them, and they say nothing about when a file was opened. Only outlined days are activity CLARITY saw itself.
            {data && data.undated > 0 && ` ${num(data.undated)} files have no usable date (e.g. a 1980 placeholder) and are not shown.`}
          </span>
        </div>
      </Panel>

      {selected != null && (
        <div className="glass edge-light mt-3 flex h-[440px] flex-col overflow-hidden">
          <div className="flex shrink-0 items-center gap-3 px-4 py-3">
            <CalendarDays size={15} className="text-accent" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">{fmtDay(selected)}</div>
              <div className="text-xs text-fg-3">
                {sel ? `${num(sel.files)} files ${field} · ${bytes(sel.bytes)}` : `No files ${field} on this day`}
                {data?.observed
                  .filter((o) => o.day === selected)
                  .map((o) => ` · ${o.label}`)
                  .join("")}
              </div>
            </div>
            <IconButton label="Close" onClick={() => setSelected(null)}>
              <X size={14} />
            </IconButton>
          </div>
          {sel ? <FileList query={{ dateField: field, from: dayStart(selected), to: dayStart(selected) + DAY - 1, categories: cats, underDir: loc, includeHidden: true }} dateField={field} defaultSort="size" showReasons={false} /> : <div className="px-4 pb-4 text-sm text-fg-3">Pick a highlighted day to see its files.</div>}
        </div>
      )}
    </div>
  );
}

function level(l: number) {
  if (l === 0) return "var(--hover)";
  const a = [0, 0.28, 0.48, 0.7, 0.95][l];
  return `color-mix(in oklab, var(--accent) ${Math.round(a * 100)}%, transparent)`;
}

function Heatmap({ data, fromDay, toDay, metric, selected, focus, onSelect }: { data: Activity; fromDay: number; toDay: number; metric: "files" | "bytes"; selected: number | null; focus: { fromDay: number; toDay: number } | null; onSelect: (d: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [hover, setHover] = useState<{ day: number; x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const byDay = useMemo(() => new Map(data.days.map((d) => [d.day, d])), [data]);
  const observed = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const o of data.observed) m.set(o.day, [...(m.get(o.day) ?? []), o.label]);
    return m;
  }, [data]);
  // Quantile thresholds over non-empty days, so one huge day doesn't wash out the rest.
  const thresholds = useMemo(() => {
    const vals = data.days.map((d) => (metric === "files" ? d.files : d.bytes)).filter((v) => v > 0).sort((a, b) => a - b);
    if (!vals.length) return [1, 1, 1];
    const q = (p: number) => vals[Math.min(vals.length - 1, Math.floor(vals.length * p))];
    return [q(0.5), q(0.8), q(0.95)];
  }, [data, metric]);
  const lvl = (v: number) => (v <= 0 ? 0 : v <= thresholds[0] ? 1 : v <= thresholds[1] ? 2 : v <= thresholds[2] ? 3 : 4);

  const weeks = Math.ceil((toDay - fromDay + 1) / 7);
  const LEFT = 28;
  const TOP = 16;
  const cell = Math.max(8, Math.min(16, Math.floor((w - LEFT) / weeks) - 2));
  const pitch = cell + 2;
  const months: { x: number; label: string }[] = [];
  for (let wk = 0; wk < weeks; wk++) {
    const d = dayDate(fromDay + wk * 7);
    const prev = dayDate(fromDay + (wk - 1) * 7);
    if (wk === 0 || d.getUTCMonth() !== prev.getUTCMonth()) months.push({ x: LEFT + wk * pitch, label: d.toLocaleDateString(undefined, { timeZone: "UTC", month: "short" }) });
  }
  const hv = hover ? byDay.get(hover.day) : null;

  return (
    <div ref={ref} className="relative overflow-x-auto" onMouseLeave={() => setHover(null)}>
      {w > 0 && (
        <svg width={LEFT + weeks * pitch} height={TOP + 7 * pitch} className="block">
          {months.map((m, i) => (
            <text key={i} x={m.x} y={10} className="fill-[var(--fg-4)] text-[10px]">
              {m.label}
            </text>
          ))}
          {["Mon", "", "Wed", "", "Fri", "", ""].map((l, i) => (
            <text key={i} x={0} y={TOP + i * pitch + cell - 2} className="fill-[var(--fg-4)] text-[9px]">
              {l}
            </text>
          ))}
          {Array.from({ length: weeks * 7 }, (_, i) => {
            const day = fromDay + i;
            if (day > toDay) return null;
            const wk = Math.floor(i / 7);
            const dow = i % 7;
            const v = byDay.get(day);
            const val = v ? (metric === "files" ? v.files : v.bytes) : 0;
            const x = LEFT + wk * pitch;
            const y = TOP + dow * pitch;
            const obs = observed.has(day);
            const inFocus = focus && day >= focus.fromDay && day <= focus.toDay;
            return (
              <rect
                key={day}
                x={x}
                y={y}
                width={cell}
                height={cell}
                rx={2.5}
                fill={level(lvl(val))}
                stroke={day === selected ? "var(--fg)" : obs ? "var(--violet)" : inFocus ? "var(--accent-line)" : "none"}
                strokeWidth={day === selected ? 2 : 1.5}
                className={clsx("transition-[fill] duration-200", v && "cursor-pointer")}
                onMouseEnter={() => setHover({ day, x: x + cell / 2, y })}
                onClick={() => onSelect(day)}
              />
            );
          })}
        </svg>
      )}
      {hover && (
        <div className="glass-float pointer-events-none absolute z-10 min-w-[180px] px-3 py-2 text-xs" style={{ left: Math.min(Math.max(hover.x - 90, 0), Math.max(0, w - 200)), top: hover.y + 22 }}>
          <div className="font-medium">{fmtDay(hover.day)}</div>
          <div className="tabular text-fg-2">{hv ? `${num(hv.files)} files · ${bytes(hv.bytes)}` : "No files"}</div>
          {(observed.get(hover.day) ?? []).map((l, i) => (
            <div key={i} className="mt-0.5 text-violet">
              ● {l}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
