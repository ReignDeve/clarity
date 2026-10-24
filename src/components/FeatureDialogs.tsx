import clsx from "clsx";
import { ArrowRight, CheckCircle2, FolderInput, FolderOpen, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api, errorText } from "../lib/api";
import { bytes, num } from "../lib/format";
import type { MovePlan, MoveSummary, RelatedFile } from "../lib/types";
import { useApp } from "../store/app";
import { FileIcon } from "./FileIcon";
import { Modal } from "./Overlays";
import { Badge, Button, Checkbox, IconButton, Spinner, Toggle } from "./ui";

const GB = 1024 ** 3;

function NumField({ label, value, onChange, suffix, hint }: { label: string; value: string; onChange: (v: string) => void; suffix: string; hint?: string }) {
  return (
    <label className="block">
      <div className="mb-1 text-xs text-fg-2">{label}</div>
      <div className="flex h-8 items-center rounded-[8px] bg-hover px-2.5 shadow-[0_0_0_1px_var(--line-2)] focus-within:shadow-[0_0_0_1.5px_var(--accent-line)]">
        <input type="number" min={0} step="any" value={value} onChange={(e) => onChange(e.target.value)} placeholder="off" className="tabular min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-4" />
        <span className="text-xs text-fg-3">{suffix}</span>
      </div>
      {hint && <div className="mt-1 text-2xs text-fg-4">{hint}</div>}
    </label>
  );
}

export function WatchDialog() {
  const edit = useApp((s) => s.watchEdit);
  const set = useApp((s) => s.set);
  const bump = useApp((s) => s.bump);
  const toast = useApp((s) => s.toast);
  const [label, setLabel] = useState("");
  const [limit, setLimit] = useState("");
  const [growGb, setGrowGb] = useState("");
  const [growPct, setGrowPct] = useState("");
  const [notify, setNotify] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!edit) return;
    const e = edit.entry;
    setLabel(e?.label ?? "");
    setLimit(e?.limitBytes ? String(+(e.limitBytes / GB).toFixed(2)) : "");
    setGrowGb(e ? (e.growthBytes ? String(+(e.growthBytes / GB).toFixed(2)) : "") : "2");
    setGrowPct(e?.growthPct ? String(e.growthPct) : "");
    setNotify(e?.notify ?? false);
  }, [edit]);

  const close = () => set({ watchEdit: null });
  const toBytes = (v: string) => (v.trim() && Number(v) > 0 ? Math.round(Number(v) * GB) : null);
  const save = async () => {
    if (!edit) return;
    setBusy(true);
    const rules = { label, limitBytes: toBytes(limit), growthBytes: toBytes(growGb), growthPct: growPct.trim() && Number(growPct) > 0 ? Number(growPct) : null, notify };
    try {
      if (edit.entry) await api().watchUpdate(edit.entry.id, rules);
      else await api().watchAdd(edit.path, rules);
      toast(edit.entry ? "Watchlist entry updated." : `Watching ${edit.path}`, "ok");
      close();
      bump();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={!!edit} onClose={close} className="w-[460px]" label="Watchlist entry">
      <div className="p-6">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold">{edit?.entry ? "Edit watch" : "Watch this location"}</h2>
            <p className="mt-0.5 break-all font-mono text-2xs text-fg-3">{edit?.path}</p>
          </div>
          <IconButton label="Close" onClick={close}>
            <X size={15} />
          </IconButton>
        </div>
        <div className="mt-5 space-y-4">
          <label className="block">
            <div className="mb-1 text-xs text-fg-2">Name</div>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Folder name" className="h-8 w-full rounded-[8px] bg-hover px-2.5 text-sm shadow-[0_0_0_1px_var(--line-2)] outline-none focus:shadow-[0_0_0_1.5px_var(--accent-line)]" />
          </label>
          <NumField label="Size limit" value={limit} onChange={setLimit} suffix="GB" hint="Alert once when the location grows past this size." />
          <div className="grid grid-cols-2 gap-3">
            <NumField label="Alert when it grows by" value={growGb} onChange={setGrowGb} suffix="GB" />
            <NumField label="…or by" value={growPct} onChange={setGrowPct} suffix="%" />
          </div>
          <p className="-mt-2 text-2xs text-fg-4">Growth is measured between two complete scans that include this location. Percentages ignore changes under 50 MB.</p>
          <div className="flex items-center justify-between rounded-[9px] bg-[var(--glass-0)] px-3 py-2.5 shadow-[0_0_0_1px_var(--line)]">
            <div>
              <div className="text-sm">Windows notification</div>
              <div className="text-2xs text-fg-3">Alerts always appear inside CLARITY. This also shows a Windows notification.</div>
            </div>
            <Toggle checked={notify} onChange={setNotify} label="Windows notification" />
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button tone="ghost" onClick={close}>
            Cancel
          </Button>
          <Button tone="primary" disabled={busy} onClick={save}>
            {edit?.entry ? "Save" : "Add to watchlist"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const CONF_LABEL: Record<RelatedFile["confidence"], string> = { confident: "Confident", likely: "Likely", possible: "Possible match" };

export function ConfidenceBadge({ c }: { c: RelatedFile["confidence"] }) {
  return (
    <Badge tone={c === "confident" ? "ok" : c === "likely" ? "accent" : "neutral"} title={c === "possible" ? "Based on folder structure only: check before relying on it." : undefined}>
      {CONF_LABEL[c]}
    </Badge>
  );
}

export function MoveDialog() {
  const req = useApp((s) => s.moveRequest);
  const set = useApp((s) => s.set);
  const bump = useApp((s) => s.bump);
  const inspect = useApp((s) => s.inspect);
  const toast = useApp((s) => s.toast);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [dest, setDest] = useState<string | null>(null);
  const [plan, setPlan] = useState<MovePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<MoveSummary | null>(null);

  useEffect(() => {
    if (!req) return;
    setChosen(new Set([req.primary.id, ...req.related.filter((r) => r.confidence !== "possible").map((r) => r.id)]));
    setDest(null);
    setPlan(null);
    setDone(null);
  }, [req]);

  useEffect(() => {
    setPlan(null);
    if (!dest || !chosen.size) return;
    api().planMove([...chosen], dest).then(setPlan, (e) => toast(errorText(e), "error"));
  }, [dest, chosen]);

  const close = () => set({ moveRequest: null });
  const run = async () => {
    if (!dest || !plan) return;
    setBusy(true);
    try {
      const r = await api().executeMove(plan.steps.filter((s) => s.ok).map((s) => s.id), dest);
      setDone(r);
      if (req && r.outcomes.some((o) => o.id === req.primary.id && o.status === "moved")) inspect(null);
      bump();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: number) => {
    const n = new Set(chosen);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setChosen(n);
  };
  if (!req) return <Modal open={false} onClose={close} label="Move files">{null}</Modal>;

  return (
    <Modal open={!!req} onClose={busy ? () => {} : close} className="w-[min(720px,92vw)]" label="Move files">
      {done ? (
        <div className="p-6">
          <div className="flex items-center gap-3">
            <CheckCircle2 size={22} className={done.moved ? "text-ok" : "text-warn"} />
            <h2 className="text-lg font-semibold">{done.moved ? `Moved ${num(done.moved)} file${done.moved === 1 ? "" : "s"} (${bytes(done.bytes)})` : "Nothing was moved"}</h2>
          </div>
          <div className="scroll mt-4 max-h-[40vh] rounded-[10px] shadow-[0_0_0_1px_var(--line)]">
            {done.outcomes.map((o) => (
              <div key={o.id} className="flex items-center gap-2 border-b hairline px-3 py-2 text-xs last:border-0">
                <Badge tone={o.status === "moved" ? "ok" : o.status === "failed" ? "danger" : "warn"}>{o.status}</Badge>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-2" title={o.error ?? o.to}>
                  {o.error ? `${o.from}: ${o.error}` : o.to}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-2xs text-fg-4">Moved files leave this scan's results. Rescan to see them in their new location. The move is listed in Cleanup History.</p>
          <div className="mt-5 flex justify-end">
            <Button tone="primary" onClick={close}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="border-b hairline px-6 py-5">
            <h2 className="text-lg font-semibold">Move together</h2>
            <p className="mt-0.5 text-sm text-fg-3">Keep related files side by side. Pick what to move and where. Nothing happens until you confirm, and nothing is ever overwritten.</p>
          </div>
          <div className="scroll max-h-[34vh] px-3 py-2">
            <Row checked={chosen.has(req.primary.id)} onToggle={() => toggle(req.primary.id)} name={req.primary.name} path={req.primary.path} size={req.primary.size} tag={<Badge>This file</Badge>} />
            {req.related.map((r) => (
              <Row key={r.id} checked={chosen.has(r.id)} onToggle={() => toggle(r.id)} name={r.row.name} path={r.path} size={r.row.size} category={r.row.category} tag={<><span className="text-2xs text-fg-3">{r.label}</span> <ConfidenceBadge c={r.confidence} /></>} />
            ))}
          </div>
          <div className="flex items-center gap-3 border-t hairline px-6 py-3">
            <Button size="sm" icon={<FolderOpen size={13} />} onClick={async () => setDest((await api().pickFolder()) ?? dest)}>
              {dest ? "Change folder" : "Choose destination…"}
            </Button>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-2">{dest ?? "No destination chosen"}</span>
          </div>
          {dest && (
            <div className="border-t hairline px-6 py-3">
              {!plan ? (
                <div className="flex items-center gap-2 text-xs text-fg-3">
                  <Spinner /> Checking…
                </div>
              ) : plan.error ? (
                <div className="rounded-[8px] bg-[var(--danger-soft)] px-3 py-2 text-xs text-danger">{plan.error}</div>
              ) : (
                <>
                  <div className="text-2xs font-semibold uppercase tracking-[0.1em] text-fg-4">Preview</div>
                  <div className="scroll mt-1.5 max-h-[22vh] space-y-1">
                    {plan.steps.map((s) => (
                      <div key={s.id} className={clsx("flex items-center gap-2 text-xs", !s.ok && "opacity-80")}>
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-3" title={s.from}>
                          {s.from}
                        </span>
                        <ArrowRight size={11} className="shrink-0 text-fg-4" />
                        <span className={clsx("min-w-0 flex-1 truncate font-mono text-[11px]", s.ok ? "text-fg" : "text-danger")} title={s.blocked ?? s.to}>
                          {s.ok ? s.to : s.blocked}
                        </span>
                      </div>
                    ))}
                  </div>
                  {plan.crossDrive && <p className="mt-2 text-2xs text-fg-3">Another drive: files are copied, the copy is verified, and only then is the original removed.</p>}
                </>
              )}
            </div>
          )}
          <div className="flex items-center justify-between gap-4 border-t hairline px-6 py-4">
            <span className="text-xs text-fg-3">{plan && !plan.error ? `${num(plan.movable)} of ${num(plan.steps.length)} files can be moved · ${bytes(plan.bytes)}` : ""}</span>
            <div className="flex gap-2">
              <Button tone="ghost" onClick={close}>
                Cancel
              </Button>
              <Button tone="primary" icon={<FolderInput size={14} />} disabled={!plan || !!plan.error || plan.movable === 0 || busy} onClick={run}>
                {busy ? "Moving…" : `Move ${plan?.movable ?? ""} file${plan?.movable === 1 ? "" : "s"}`}
              </Button>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}

function Row({ checked, onToggle, name, path, size, tag, category }: { checked: boolean; onToggle: () => void; name: string; path: string; size: number; tag: ReactNode; category?: string }) {
  return (
    <div className="flex items-center gap-3 rounded-[8px] px-3 py-2 hover:bg-hover">
      <Checkbox checked={checked} onChange={onToggle} label={`Include ${name}`} />
      <FileIcon category={category ?? "other"} size={14} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm">{name}</span>
          {tag}
        </div>
        <div className="truncate font-mono text-2xs text-fg-4">{path}</div>
      </div>
      <span className="tabular shrink-0 text-xs text-fg-2">{bytes(size)}</span>
    </div>
  );
}
