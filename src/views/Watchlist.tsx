import clsx from "clsx";
import { Bell, BellOff, Eye, FolderOpen, HardDrive, Pause, Pencil, Play, Plus, Trash2, Unplug } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { Badge, Button, Empty, IconButton, Panel, Spinner } from "../components/ui";
import { api, errorText } from "../lib/api";
import { ago, bytes, date, dateTime } from "../lib/format";
import type { WatchAlert, WatchEntry, WatchView } from "../lib/types";
import { useApp } from "../store/app";
import { signedBytes } from "./Timeline";

export function useWatch() {
  const version = useApp((s) => s.version);
  const [data, setData] = useState<WatchView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () => api().watchList().then(setData, (e) => setError(errorText(e)));
  useEffect(() => {
    void reload();
  }, [version]);
  return { data, error, reload };
}

export async function addWatch() {
  const p = await api().pickFolder();
  if (p) useApp.getState().set({ watchEdit: { path: p } });
}

function status(e: WatchEntry, current: number | undefined) {
  const last = e.history[e.history.length - 1];
  const size = current ?? last?.bytes;
  if (e.paused) return { label: "Paused", tone: "neutral" as const };
  if (!e.available) return { label: "Not connected", tone: "neutral" as const };
  if (size == null) return { label: "Waiting for a scan", tone: "neutral" as const };
  if (e.limitBytes && size > e.limitBytes) return { label: "Over limit", tone: "danger" as const };
  if (e.limitBytes && size > e.limitBytes * 0.9) return { label: "Near limit", tone: "warn" as const };
  return { label: "OK", tone: "ok" as const };
}

export function Watchlist() {
  const { data, error, reload } = useWatch();
  const drives = useApp((s) => s.drives);
  const info = useApp((s) => s.info);
  const bump = useApp((s) => s.bump);
  if (error) return <Empty title="Could not load the watchlist">{error}</Empty>;
  if (!data)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  const unseen = data.alerts.filter((a) => !a.seen);
  const quick = [info?.downloadsPath && { path: info.downloadsPath, label: "Downloads" }, ...drives.map((d) => ({ path: d.mount, label: `Drive ${d.mount.replace("\\", "")}` }))].filter((q): q is { path: string; label: string } => !!q && !data.entries.some((e) => e.path.toLowerCase() === q.path.toLowerCase()));

  return (
    <div className="scroll -mx-1 h-full px-1 pb-24">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button tone="primary" size="sm" icon={<Plus size={13} />} onClick={addWatch}>
          Watch a folder or drive
        </Button>
        {quick.slice(0, 4).map((q) => (
          <Button key={q.path} size="sm" tone="ghost" icon={<Eye size={12} />} onClick={() => useApp.getState().set({ watchEdit: { path: q.path } })}>
            {q.label}
          </Button>
        ))}
        <span className="ml-auto text-2xs text-fg-4">Checked after every complete scan that includes the location.</span>
      </div>

      {data.entries.length === 0 ? (
        <Empty icon={<Eye size={18} />} title="Nothing on your watchlist yet">
          Add folders that tend to grow, like Downloads, a video project or a game library, and set a size limit or a growth threshold. CLARITY tells you when one is crossed.
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-3 @container xl:grid-cols-2">
          {data.entries.map((e, i) => (
            <EntryCard key={e.id} e={e} i={i} current={data.current[e.id]} onChange={() => (reload(), bump())} />
          ))}
        </div>
      )}

      <Panel
        className="mt-3"
        title={`Alerts${unseen.length ? ` · ${unseen.length} new` : ""}`}
        actions={
          unseen.length > 0 && (
            <Button size="sm" tone="ghost" onClick={() => api().watchMarkSeen([]).then(() => (reload(), bump()))}>
              Mark all as read
            </Button>
          )
        }
      >
        {data.alerts.length === 0 ? <p className="py-2 text-sm text-fg-3">No alerts so far.</p> : data.alerts.slice(0, 30).map((a) => <AlertRow key={a.id} a={a} />)}
      </Panel>
    </div>
  );
}

export function AlertRow({ a, compact }: { a: WatchAlert; compact?: boolean }) {
  const go = useApp((s) => s.go);
  const inspect = useApp((s) => s.inspect);
  const toast = useApp((s) => s.toast);
  const open = async () => {
    const hit = await api().locatePath(a.path).catch(() => null);
    if (hit?.kind === "dir") {
      inspect(hit);
      go("explorer", { dir: hit.id });
    } else toast("This location is not part of the current scan.");
  };
  return (
    <button onClick={open} className="flex w-full items-start gap-3 rounded-[8px] px-2 py-2 text-left hover:bg-hover">
      <span className={clsx("mt-1.5 h-2 w-2 shrink-0 rounded-full", a.seen ? "bg-[var(--fg-4)]" : a.kind === "limit" ? "bg-danger" : a.kind === "missing" ? "bg-warn" : "bg-accent")} />
      <div className="min-w-0 flex-1">
        <div className={clsx("text-sm", a.seen ? "text-fg-2" : "font-medium text-fg")}>{a.message}</div>
        {!compact && (
          <div className="truncate text-2xs text-fg-4">
            {dateTime(a.at)} · {a.path}
            {a.notify ? " · notified" : ""}
          </div>
        )}
      </div>
    </button>
  );
}

function Sparkline({ e, current }: { e: WatchEntry; current: number | undefined }) {
  const pts = e.history.map((h) => ({ at: h.at, v: h.bytes }));
  if (current != null && (!pts.length || pts[pts.length - 1].v !== current)) pts.push({ at: Math.floor(Date.now() / 1000), v: current });
  const W = 260;
  const H = 54;
  if (pts.length < 2) return <div className="flex h-[54px] items-center text-2xs text-fg-4">History appears after the next scan of this location.</div>;
  const t0 = pts[0].at;
  const t1 = pts[pts.length - 1].at || t0 + 1;
  const vals = pts.map((p) => p.v).concat(e.limitBytes ? [e.limitBytes] : []);
  const lo = Math.min(...vals) * 0.96;
  const hi = Math.max(...vals) * 1.03 || 1;
  const x = (t: number) => 4 + ((t - t0) / Math.max(1, t1 - t0)) * (W - 8);
  const y = (v: number) => 4 + (1 - (v - lo) / Math.max(1, hi - lo)) * (H - 8);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.at).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-[54px] w-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id={`wl-${e.id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0.25" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {e.limitBytes && <line x1={0} x2={W} y1={y(e.limitBytes)} y2={y(e.limitBytes)} stroke="var(--danger)" strokeDasharray="3 3" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
      <path d={`${d} L${x(t1)},${H} L${x(t0)},${H} Z`} fill={`url(#wl-${e.id})`} />
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
      {pts.map((p, i) => (
        <circle key={i} cx={x(p.at)} cy={y(p.v)} r={2} fill="var(--accent)">
          <title>{`${date(p.at)}: ${bytes(p.v)}`}</title>
        </circle>
      ))}
    </svg>
  );
}

function EntryCard({ e, i, current, onChange }: { e: WatchEntry; i: number; current: number | undefined; onChange: () => void }) {
  const toast = useApp((s) => s.toast);
  const set = useApp((s) => s.set);
  const go = useApp((s) => s.go);
  const inspect = useApp((s) => s.inspect);
  const [confirm, setConfirm] = useState(false);
  const st = status(e, current);
  const last = e.history[e.history.length - 1];
  const prev = e.history[e.history.length - 2];
  const size = current ?? last?.bytes;
  const change = last && prev ? last.bytes - prev.bytes : null;
  const act = (p: Promise<unknown>) => p.then(onChange, (err) => toast(errorText(err), "error"));
  const rules = [e.limitBytes && `limit ${bytes(e.limitBytes)}`, e.growthBytes && `alert at +${bytes(e.growthBytes)}`, e.growthPct && `alert at +${e.growthPct}%`].filter(Boolean).join(" · ") || "no thresholds";
  const isDrive = /^[a-z]:\\?$/i.test(e.path);

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }} className={clsx("glass edge-light p-4", e.paused && "opacity-70")}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-accent-soft text-accent">{!e.available ? <Unplug size={15} /> : isDrive ? <HardDrive size={15} /> : <Eye size={15} />}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{e.label}</span>
            <Badge tone={st.tone}>{st.label}</Badge>
            {e.unseenAlerts > 0 && <Badge tone="accent">{e.unseenAlerts} new</Badge>}
          </div>
          <div className="truncate font-mono text-2xs text-fg-4">{e.path}</div>
        </div>
        <div className="text-right">
          <div className="tabular text-lg font-semibold tracking-tight">{size != null ? bytes(size) : "–"}</div>
          {change != null && <div className={clsx("tabular text-2xs", change > 0 ? "text-warn" : "text-ok")}>{signedBytes(change)} since previous</div>}
        </div>
      </div>
      {e.limitBytes != null && size != null && (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-active">
          <div className={clsx("h-full rounded-full", size > e.limitBytes ? "bg-danger" : size > e.limitBytes * 0.9 ? "bg-warn" : "bg-accent")} style={{ width: `${Math.min(100, (size / e.limitBytes) * 100)}%` }} />
        </div>
      )}
      <div className="mt-3">
        <Sparkline e={e} current={current} />
      </div>
      <div className="mt-2 flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-2xs text-fg-3">
          {rules}
          {last ? ` · last measured ${ago(last.at)}` : ""}
        </span>
        <IconButton label={e.notify ? "Windows notifications on" : "Windows notifications off"} onClick={() => act(api().watchUpdate(e.id, { label: e.label, limitBytes: e.limitBytes, growthBytes: e.growthBytes, growthPct: e.growthPct, notify: !e.notify }))}>
          {e.notify ? <Bell size={13} className="text-accent" /> : <BellOff size={13} />}
        </IconButton>
        <IconButton
          label="Open in File Explorer"
          onClick={async () => {
            const hit = await api().locatePath(e.path).catch(() => null);
            if (hit?.kind === "dir") {
              inspect(hit);
              go("explorer", { dir: hit.id });
            } else toast("Not part of the current scan.");
          }}
        >
          <FolderOpen size={13} />
        </IconButton>
        <IconButton label="Edit thresholds" onClick={() => set({ watchEdit: { path: e.path, entry: e } })}>
          <Pencil size={13} />
        </IconButton>
        <IconButton label={e.paused ? "Resume" : "Pause"} onClick={() => act(api().watchPause(e.id, !e.paused))}>
          {e.paused ? <Play size={13} /> : <Pause size={13} />}
        </IconButton>
        {confirm ? (
          <Button size="sm" tone="danger" onClick={() => act(api().watchRemove(e.id))}>
            Remove
          </Button>
        ) : (
          <IconButton label="Remove from watchlist" onClick={() => setConfirm(true)}>
            <Trash2 size={13} />
          </IconButton>
        )}
      </div>
    </motion.div>
  );
}
