import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import { ArrowDown, ArrowUp, Film, Image as ImageIcon, LayoutGrid, Layers, List, Music, Play } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Thumb } from "../components/Thumb";
import { Badge, Checkbox, Chip, Empty, Segmented, Spinner } from "../components/ui";
import { api, errorText } from "../lib/api";
import { ago, bytes, date, num } from "../lib/format";
import type { MediaItem, MediaKind, MediaMeta, MediaQuery, MediaResult, MediaSort } from "../lib/types";
import { selKey, useApp } from "../store/app";
import { SearchBox } from "./Lists";

const PAGE = 300;

export function fmtDuration(ms: number | null | undefined): string {
  if (!ms) return "";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

export function resolutionLabel(m: MediaMeta | null | undefined): string {
  if (!m?.width || !m.height) return "";
  const p = Math.min(m.width, m.height);
  const tag = m.durationMs ? (p >= 2160 ? " · 4K" : p >= 1440 ? " · 1440p" : p >= 1080 ? " · 1080p" : p >= 720 ? " · 720p" : "") : ` · ${((m.width * m.height) / 1e6).toFixed(1)} MP`;
  return `${m.width} × ${m.height}${tag}`;
}

function detailLine(it: MediaItem): string {
  const m = it.meta;
  if (it.row.category === "audio") return [fmtDuration(m?.durationMs), m?.artist].filter(Boolean).join(" · ");
  if (it.row.category === "video") return [fmtDuration(m?.durationMs), m?.height ? `${m.height}p` : ""].filter(Boolean).join(" · ");
  return m?.width ? `${m.width} × ${m.height}` : "";
}

type Res = "" | "hd" | "4k" | "12mp";
type Dur = "" | "short" | "mid" | "long";
const RES: Record<Exclude<Res, "">, number> = { hd: 1280 * 720, "4k": 3840 * 2160, "12mp": 12e6 };
const DUR: Record<Exclude<Dur, "">, [number | null, number | null]> = { short: [null, 60_000], mid: [60_000, 600_000], long: [600_000, null] };

interface Loc {
  id: number | null;
  label: string;
}

export function Media() {
  const version = useApp((s) => s.version);
  const selection = useApp((s) => s.selection);
  const toggleSelect = useApp((s) => s.toggleSelect);
  const inspect = useApp((s) => s.inspect);
  const inspector = useApp((s) => s.inspector);
  const set = useApp((s) => s.set);
  const mediaIndex = useApp((s) => s.mediaIndex);

  const [kind, setKind] = useState<MediaKind>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<MediaSort>("date");
  const [desc, setDesc] = useState(true);
  const [view, setView] = useState<"grid" | "list">("grid");
  const [tile, setTile] = useState(168);
  const [group, setGroup] = useState(true);
  const [orientation, setOrientation] = useState<MediaQuery["orientation"]>("");
  const [res, setRes] = useState<Res>("");
  const [dur, setDur] = useState<Dur>("");
  const [formats, setFormats] = useState<string[]>([]);
  const [loc, setLoc] = useState<number | null>(null);
  const [locs, setLocs] = useState<Loc[]>([{ id: null, label: "All scanned locations" }]);

  const [info, setInfo] = useState<MediaResult | null>(null);
  const [pages, setPages] = useState<Map<number, MediaItem[]>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const loading = useRef(new Set<number>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  // Metadata for sorting/filtering by resolution and duration.
  useEffect(() => {
    void api().mediaIndexStart();
  }, [version]);

  useEffect(() => {
    (async () => {
      const top = await api().listDir(null);
      const out: Loc[] = [{ id: null, label: "All scanned locations" }];
      for (const r of top.dirs) {
        out.push({ id: r.id, label: r.path });
        const inner = await api().listDir(r.id);
        for (const c of inner.dirs.slice(0, 12)) out.push({ id: c.id, label: `   ${c.name}` });
      }
      setLocs(out);
    })().catch(() => {});
  }, [version]);

  const showsVisual = kind !== "audio";
  const showsTime = kind !== "images";
  const query: MediaQuery = useMemo(
    () => ({
      kind,
      search,
      sort,
      desc,
      group,
      underDir: loc,
      orientation: showsVisual ? orientation : "",
      minPixels: showsVisual && res ? RES[res] : null,
      minDurationMs: showsTime && dur ? DUR[dur][0] : null,
      maxDurationMs: showsTime && dur ? DUR[dur][1] : null,
      formats,
    }),
    [kind, search, sort, desc, group, loc, orientation, res, dur, formats, showsVisual, showsTime],
  );
  const metaDone = !mediaIndex?.running;
  const key = JSON.stringify(query) + version + (metaDone ? "m" : "");
  const keyRef = useRef(key);

  const loadPage = useCallback(
    async (p: number) => {
      if (loading.current.has(p)) return;
      loading.current.add(p);
      const k = keyRef.current;
      try {
        const r = await api().mediaQuery({ ...query, offset: p * PAGE, limit: PAGE });
        if (keyRef.current !== k) return;
        setInfo(r);
        setPages((m) => new Map(m).set(p, r.items));
        setError(null);
      } catch (e) {
        if (keyRef.current === k) setError(errorText(e));
      } finally {
        loading.current.delete(p);
      }
    },
    [query],
  );

  useEffect(() => {
    keyRef.current = key;
    loading.current.clear();
    setPages(new Map());
    setActive(0);
    scrollRef.current?.scrollTo({ top: 0 });
    void loadPage(0);
  }, [key]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const total = info?.total ?? 0;
  const gap = 10;
  const cols = view === "grid" ? Math.max(1, Math.floor((width - 24 + gap) / (tile + gap))) : 1;
  const cell = view === "grid" ? (width - 24 - gap * (cols - 1)) / cols : 0;
  const rowH = view === "grid" ? Math.round(cell * 0.75) + 48 : 52;
  const rows = Math.ceil(total / cols);
  const v = useVirtualizer({ count: rows, getScrollElement: () => scrollRef.current, estimateSize: () => rowH, overscan: 4 });
  useEffect(() => v.measure(), [rowH, cols]);
  const vis = v.getVirtualItems();

  useEffect(() => {
    if (!vis.length) return;
    const first = Math.floor((vis[0].index * cols) / PAGE);
    const last = Math.floor(((vis[vis.length - 1].index + 1) * cols - 1) / PAGE);
    for (let p = first; p <= last; p++) if (!pages.has(p)) void loadPage(p);
  }, [vis.length ? vis[0].index : -1, vis.length ? vis[vis.length - 1].index : -1, cols, pages, loadPage]);

  const itemAt = (i: number) => pages.get(Math.floor(i / PAGE))?.[i % PAGE];
  const sel = (it: MediaItem) => ({ kind: "file" as const, id: it.row.id, name: it.row.name, path: `${it.row.dir}\\${it.row.name}`, size: it.row.size });

  const activate = (i: number) => {
    if (!total) return;
    const n = Math.max(0, Math.min(total - 1, i));
    setActive(n);
    v.scrollToIndex(Math.floor(n / cols), { align: "auto" });
    const it = itemAt(n);
    if (it) inspect({ kind: "file", id: it.row.id });
  };
  const onKey = (e: React.KeyboardEvent) => {
    const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols, PageDown: cols * 4, PageUp: -cols * 4 };
    if (e.key in step) {
      e.preventDefault();
      activate(active + step[e.key]);
    } else if (e.key === " ") {
      e.preventDefault();
      const it = itemAt(active);
      if (it) toggleSelect(sel(it));
    } else if (e.key === "Enter") {
      const it = itemAt(active);
      if (it) set({ quickLook: it.row.id });
    }
  };

  const counts = info?.counts ?? {};
  const allCount = (counts.images ?? 0) + (counts.video ?? 0) + (counts.audio ?? 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3 px-1">
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold tracking-tight">Media</h1>
          <p className="mt-0.5 text-sm text-fg-3">Every photo, video and audio file in the scanned locations{info ? ` · ${num(info.mediaTotal)} files` : ""}.</p>
        </div>
        <div className="flex items-center gap-2">
          <SearchBox value={search} onChange={setSearch} placeholder="Search media by name" />
          <Segmented
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: "grid", label: <LayoutGrid size={13} />, title: "Grid" },
              { value: "list", label: <List size={13} />, title: "List" },
            ]}
          />
        </div>
      </div>

      <div className="glass edge-light flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pt-3">
          <Segmented
            size="sm"
            value={kind}
            onChange={(k) => (setKind(k), setFormats([]))}
            options={[
              { value: "all", label: `All ${allCount ? num(allCount) : ""}` },
              { value: "images", label: <span className="flex items-center gap-1"><ImageIcon size={12} /> {num(counts.images ?? 0)}</span>, title: "Photos & images" },
              { value: "video", label: <span className="flex items-center gap-1"><Film size={12} /> {num(counts.video ?? 0)}</span>, title: "Videos" },
              { value: "audio", label: <span className="flex items-center gap-1"><Music size={12} /> {num(counts.audio ?? 0)}</span>, title: "Audio" },
            ]}
          />
          <select value={loc ?? ""} onChange={(e) => setLoc(e.target.value === "" ? null : Number(e.target.value))} className="h-7 max-w-[220px] rounded-[7px] bg-hover px-2 text-xs text-fg shadow-[0_0_0_1px_var(--line-2)] outline-none [&>option]:bg-[var(--glass-solid)]" aria-label="Location">
            {locs.map((l) => (
              <option key={String(l.id)} value={l.id ?? ""}>
                {l.label}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-1">
            <select value={sort} onChange={(e) => setSort(e.target.value as MediaSort)} className="h-7 rounded-[7px] bg-hover px-2 text-xs text-fg shadow-[0_0_0_1px_var(--line-2)] outline-none [&>option]:bg-[var(--glass-solid)]" aria-label="Sort by">
              <option value="date">Date modified</option>
              <option value="taken">Date taken</option>
              <option value="size">Size</option>
              <option value="name">Name</option>
              {kind !== "audio" && <option value="resolution">Resolution</option>}
              {kind !== "images" && <option value="duration">Duration</option>}
            </select>
            <button onClick={() => setDesc(!desc)} className="flex h-7 w-7 items-center justify-center rounded-[7px] text-fg-3 shadow-[0_0_0_1px_var(--line-2)] hover:text-fg" title={desc ? "Descending" : "Ascending"}>
              {desc ? <ArrowDown size={13} /> : <ArrowUp size={13} />}
            </button>
          </div>
          <Chip active={group} onClick={() => setGroup(!group)}>
            <Layers size={11} /> Group related
          </Chip>
          <div className="ml-auto flex items-baseline gap-2">
            <span className="tabular text-sm font-semibold">{bytes(info?.totalBytes ?? 0)}</span>
            <span className="tabular text-xs text-fg-3">in {num(total)}</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-4 pb-2 pt-2">
          {showsVisual && (
            <>
              <Chip active={orientation === "landscape"} onClick={() => setOrientation(orientation === "landscape" ? "" : "landscape")}>Landscape</Chip>
              <Chip active={orientation === "portrait"} onClick={() => setOrientation(orientation === "portrait" ? "" : "portrait")}>Portrait</Chip>
              <Chip active={orientation === "square"} onClick={() => setOrientation(orientation === "square" ? "" : "square")}>Square</Chip>
              <span className="mx-1 h-4 w-px bg-[var(--line-2)]" />
              {(["hd", "4k", "12mp"] as const).map((r) => (
                <Chip key={r} active={res === r} onClick={() => setRes(res === r ? "" : r)}>
                  {r === "hd" ? "≥ 720p" : r === "4k" ? "≥ 4K" : "≥ 12 MP"}
                </Chip>
              ))}
            </>
          )}
          {showsTime && (
            <>
              <span className="mx-1 h-4 w-px bg-[var(--line-2)]" />
              {(["short", "mid", "long"] as const).map((d) => (
                <Chip key={d} active={dur === d} onClick={() => setDur(dur === d ? "" : d)}>
                  {d === "short" ? "< 1 min" : d === "mid" ? "1–10 min" : "> 10 min"}
                </Chip>
              ))}
            </>
          )}
          {(info?.formats.length ?? 0) > 1 && <span className="mx-1 h-4 w-px bg-[var(--line-2)]" />}
          {(info?.formats ?? []).slice(0, 8).map(([f, n]) => (
            <Chip key={f} active={formats.includes(f)} onClick={() => setFormats(formats.includes(f) ? formats.filter((x) => x !== f) : [...formats, f])}>
              .{f} <span className="text-fg-4">{num(n)}</span>
            </Chip>
          ))}
          {view === "grid" && (
            <input type="range" min={120} max={280} step={8} value={tile} onChange={(e) => setTile(Number(e.target.value))} className="ml-auto h-1 w-24 accent-[var(--accent)]" aria-label="Thumbnail size" title="Thumbnail size" />
          )}
        </div>
        {mediaIndex?.running && mediaIndex.total > 0 && (
          <div className="mx-4 mb-2 flex items-center gap-3 text-2xs text-fg-3">
            <div className="h-[3px] w-40 overflow-hidden rounded-full bg-active">
              <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${(mediaIndex.done / mediaIndex.total) * 100}%` }} />
            </div>
            Reading resolution and duration from Windows · {num(mediaIndex.done)} / {num(mediaIndex.total)}. Sorting and filtering by them become complete when done.
          </div>
        )}

        <div ref={scrollRef} tabIndex={0} onKeyDown={onKey} className="scroll relative min-h-0 flex-1 px-3 pb-24 outline-none" role="listbox" aria-label="Media">
          {error && <Empty title="Could not load media">{error}</Empty>}
          {!error && !info && (
            <div className="flex h-40 items-center justify-center">
              <Spinner />
            </div>
          )}
          {info && total === 0 && (
            <Empty icon={<ImageIcon size={18} />} title={info.mediaTotal === 0 ? "No media in the scanned locations" : "Nothing matches these filters"}>
              {info.mediaTotal === 0 ? "Scan a drive or your user folder to see photos, videos and music here." : "Try removing a filter."}
            </Empty>
          )}
          {view === "list" && total > 0 && (
            <div className="sticky top-0 z-10 grid h-8 items-center gap-3 bg-[var(--glass-solid)] px-2 text-2xs font-medium uppercase tracking-[0.08em] text-fg-3" style={{ gridTemplateColumns: LIST_COLS }}>
              <span />
              <span />
              <span>Name</span>
              <span>Details</span>
              <span className="text-right">Modified</span>
              <span className="text-right">Size</span>
            </div>
          )}
          <div style={{ height: v.getTotalSize(), position: "relative" }}>
            {vis.map((vr) => (
              <div key={vr.key} className={clsx("absolute left-0 right-0", view === "grid" && "flex")} style={{ top: vr.start, height: rowH, gap }}>
                {Array.from({ length: cols }, (_, c) => {
                  const i = vr.index * cols + c;
                  if (i >= total) return null;
                  const it = itemAt(i);
                  const selected = !!it && selection.has(selKey("file", it.row.id));
                  const inspected = !!it && inspector?.kind === "file" && inspector.id === it.row.id;
                  const onClick = () => {
                    setActive(i);
                    if (it) inspect({ kind: "file", id: it.row.id });
                    scrollRef.current?.focus({ preventScroll: true });
                  };
                  if (!it) return <div key={c} className={view === "grid" ? "rounded-[10px] bg-hover" : "h-11 rounded bg-hover"} style={view === "grid" ? { width: cell, height: rowH - 8 } : undefined} />;
                  return view === "grid" ? (
                    <Tile key={it.row.id} it={it} width={cell} height={Math.round(cell * 0.75)} selected={selected} inspected={inspected} active={i === active} onClick={onClick} onOpen={() => set({ quickLook: it.row.id })} onSelect={() => toggleSelect(sel(it))} />
                  ) : (
                    <ListRow key={it.row.id} it={it} selected={selected} inspected={inspected} active={i === active} onClick={onClick} onOpen={() => set({ quickLook: it.row.id })} onSelect={() => toggleSelect(sel(it))} />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const LIST_COLS = "15px 44px minmax(0,1fr) 170px 96px 80px";

function GroupBadge({ it }: { it: MediaItem }) {
  if (!it.grouped.length) return null;
  const exts = [...new Set(it.grouped.map((g) => g.ext.toUpperCase()))].join(", ");
  return (
    <span title={`Grouped with: ${it.grouped.map((g) => g.name).join(", ")}`} className="flex items-center gap-1 rounded-[5px] bg-[rgba(10,12,16,0.72)] px-1.5 py-[1px] text-2xs font-medium text-white backdrop-blur">
      <Layers size={10} /> +{it.grouped.length} {exts.length < 14 ? exts : ""}
    </span>
  );
}

function Tile({ it, width, height, selected, inspected, active, onClick, onOpen, onSelect }: { it: MediaItem; width: number; height: number; selected: boolean; inspected: boolean; active: boolean; onClick: () => void; onOpen: () => void; onSelect: () => void }) {
  const r = it.row;
  return (
    <div style={{ width }} className="group relative cursor-default" onClick={onClick} onDoubleClick={onOpen} role="option" aria-selected={selected}>
      <div
        className={clsx(
          "relative overflow-hidden rounded-[10px] shadow-[0_0_0_1px_var(--line)] transition-shadow",
          inspected && "shadow-[0_0_0_2px_var(--accent)]",
          selected && !inspected && "shadow-[0_0_0_2px_var(--accent-line)]",
          active && !inspected && "shadow-[0_0_0_1.5px_var(--fg-3)]",
        )}
        style={{ height }}
      >
        <Thumb row={r} size={width > 200 ? 384 : 256} className="h-full w-full transition-transform duration-300 group-hover:scale-[1.03]" iconSize={26} />
        {r.category === "video" && (
          <span className="absolute bottom-1.5 right-1.5 flex items-center gap-1 rounded-[5px] bg-[rgba(10,12,16,0.72)] px-1.5 py-[1px] text-2xs font-medium text-white backdrop-blur">
            <Play size={9} fill="currentColor" /> {fmtDuration(it.meta?.durationMs) || "video"}
          </span>
        )}
        {r.category === "audio" && it.meta?.durationMs ? <span className="absolute bottom-1.5 right-1.5 rounded-[5px] bg-[rgba(10,12,16,0.72)] px-1.5 py-[1px] text-2xs text-white">{fmtDuration(it.meta.durationMs)}</span> : null}
        <span className="absolute right-1.5 top-1.5">
          <GroupBadge it={it} />
        </span>
        <span className={clsx("absolute left-1.5 top-1.5 rounded-[5px] bg-[rgba(10,12,16,0.55)] p-[3px] transition-opacity", selected ? "opacity-100" : "opacity-0 group-hover:opacity-100")}>
          <Checkbox checked={selected} onChange={onSelect} label={`Select ${r.name}`} />
        </span>
      </div>
      <div className="mt-1.5 px-0.5">
        <div className="truncate text-xs text-fg" title={r.name}>
          {r.name}
        </div>
        <div className="tabular truncate text-2xs text-fg-4">{[detailLine(it), bytes(r.size)].filter(Boolean).join(" · ")}</div>
      </div>
    </div>
  );
}

function ListRow({ it, selected, inspected, active, onClick, onOpen, onSelect }: { it: MediaItem; selected: boolean; inspected: boolean; active: boolean; onClick: () => void; onOpen: () => void; onSelect: () => void }) {
  const r = it.row;
  const m = it.meta;
  return (
    <div
      onClick={onClick}
      onDoubleClick={onOpen}
      className={clsx("grid h-[52px] items-center gap-3 rounded-[8px] px-2", inspected ? "bg-accent-soft" : selected ? "bg-hover" : "hover:bg-hover", active && "shadow-[inset_2px_0_0_var(--accent)]")}
      style={{ gridTemplateColumns: LIST_COLS }}
    >
      <Checkbox checked={selected} onChange={onSelect} label={`Select ${r.name}`} />
      <Thumb row={r} size={96} className="h-9 w-11 rounded-[6px]" iconSize={14} />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm">{r.name}</span>
          <GroupBadge it={it} />
        </div>
        <div className="truncate font-mono text-2xs text-fg-4">{r.dir}</div>
      </div>
      <div className="min-w-0 text-xs text-fg-2">
        <div className="tabular truncate">{r.category === "images" ? resolutionLabel(m) : [fmtDuration(m?.durationMs), m?.height ? `${m.width} × ${m.height}` : m?.artist].filter(Boolean).join(" · ")}</div>
        <div className="truncate text-2xs text-fg-4">
          <Badge>{r.ext.toUpperCase()}</Badge> {m?.camera ?? m?.album ?? ""}
        </div>
      </div>
      <div className="text-right text-xs text-fg-3" title={date(r.modified)}>
        {ago(r.modified)}
      </div>
      <div className="tabular text-right text-sm font-medium">{bytes(r.size)}</div>
    </div>
  );
}

