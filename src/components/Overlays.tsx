import clsx from "clsx";
import { AlertTriangle, ArrowRight, CheckCircle2, CircleSlash, Recycle, ShieldAlert, Trash2, X, XCircle } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { api, errorText, PERMANENT_CONFIRMATION } from "../lib/api";
import { bytes, num } from "../lib/format";
import type { CleanupMode, CleanupReview, CleanupSummary, FileDetail, ItemRef } from "../lib/types";
import { FilePreview } from "../previews/FilePreview";
import { useApp } from "../store/app";
import { FileIcon } from "./FileIcon";
import { Badge, Button, Checkbox, IconButton, Kbd, Segmented, Spinner } from "./ui";

export function Modal({ open, onClose, children, className, label }: { open: boolean; onClose: () => void; children: ReactNode; className?: string; label: string }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 flex items-center justify-center p-8" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
          <div className="absolute inset-0 bg-[rgba(5,7,10,0.45)] backdrop-blur-[3px]" onClick={onClose} />
          <motion.div
            role="dialog"
            aria-modal
            aria-label={label}
            className={clsx("glass-solid relative flex max-h-full flex-col overflow-hidden", className)}
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 4 }}
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function QuickLook() {
  const id = useApp((s) => s.quickLook);
  const set = useApp((s) => s.set);
  const [d, setD] = useState<FileDetail | null>(null);
  useEffect(() => {
    setD(null);
    if (id != null) api().fileDetail(id).then(setD, () => set({ quickLook: null }));
  }, [id]);
  return (
    <Modal open={id != null} onClose={() => set({ quickLook: null })} className="h-[86vh] w-[min(1100px,90vw)]" label="Quick look">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b hairline pl-4 pr-2">
        {d && <FileIcon category={d.row.category} size={15} />}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{d?.row.name}</span>
        {d && <span className="tabular text-xs text-fg-3">{bytes(d.row.size)}</span>}
        <IconButton label="Close (Esc)" onClick={() => set({ quickLook: null })}>
          <X size={15} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1">{d ? <FilePreview detail={d} large /> : <div className="flex h-full items-center justify-center"><Spinner /></div>}</div>
    </Modal>
  );
}

export function SelectionTray() {
  const selection = useApp((s) => s.selection);
  const clear = useApp((s) => s.clearSelection);
  const set = useApp((s) => s.set);
  const items = [...selection.values()];
  const total = items.reduce((s, i) => s + i.size, 0);
  return (
    <AnimatePresence>
      {items.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 24, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 24, scale: 0.98 }}
          transition={{ type: "spring", stiffness: 420, damping: 34 }}
          className="glass-float pointer-events-auto absolute bottom-5 left-1/2 z-30 flex h-[52px] -translate-x-1/2 items-center gap-4 whitespace-nowrap pl-5 pr-2"
        >
          <div className="flex items-baseline gap-2">
            <span className="tabular text-base font-semibold">{bytes(total)}</span>
            <span className="text-xs text-fg-3">
              in {num(items.length)} selected item{items.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="h-6 w-px bg-[var(--line-2)]" />
          <Button tone="ghost" size="sm" onClick={clear}>
            Clear
          </Button>
          <Button tone="primary" icon={<ArrowRight size={14} />} onClick={() => set({ reviewOpen: true })}>
            Review cleanup
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

type Stage = "review" | "confirm-permanent" | "running" | "done";

export function CleanupDialog() {
  const open = useApp((s) => s.reviewOpen);
  const selection = useApp((s) => s.selection);
  const set = useApp((s) => s.set);
  const select = useApp((s) => s.select);
  const bump = useApp((s) => s.bump);
  const toast = useApp((s) => s.toast);
  const [mode, setMode] = useState<CleanupMode>("recycle");
  const [review, setReview] = useState<CleanupReview | null>(null);
  const [stage, setStage] = useState<Stage>("review");
  const [ack, setAck] = useState(false);
  const [summary, setSummary] = useState<CleanupSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const items: ItemRef[] = [...selection.values()].map((s) => ({ kind: s.kind, id: s.id }));

  useEffect(() => {
    if (!open) return;
    setStage("review");
    setSummary(null);
    setAck(false);
    setError(null);
    setReview(null);
    api().reviewCleanup(items, mode).then(setReview, (e) => setError(errorText(e)));
  }, [open, mode]);

  const close = () => set({ reviewOpen: false });

  const run = async () => {
    setStage("running");
    try {
      const ok = review!.checks.filter((c) => c.ok).map((c) => c.item);
      const s = await api().executeCleanup(ok, mode, mode === "permanent" ? PERMANENT_CONFIRMATION : undefined);
      setSummary(s);
      setStage("done");
      // Deselect what was actually removed; keep failures selected for retry.
      const removed = s.outcomes.filter((o) => o.status === "recycled" || o.status === "deleted");
      select(
        removed.map((o) => ({ kind: o.item.kind, id: o.item.id, name: "", path: o.path, size: o.size })),
        false,
      );
      const insp = useApp.getState().inspector;
      if (insp && removed.some((o) => o.item.kind === insp.kind && o.item.id === insp.id)) useApp.getState().inspect(null);
      bump();
    } catch (e) {
      setError(errorText(e));
      setStage("review");
      toast(errorText(e), "error");
    }
  };

  const okChecks = review?.checks.filter((c) => c.ok) ?? [];
  const blocked = review?.checks.filter((c) => !c.ok) ?? [];
  const warned = okChecks.filter((c) => c.warnings.length > 0);

  return (
    <Modal open={open} onClose={stage === "running" ? () => {} : close} className="w-[min(720px,92vw)]" label="Review cleanup">
      {stage === "done" && summary ? (
        <Result summary={summary} onClose={close} />
      ) : stage === "confirm-permanent" ? (
        <div className="p-6">
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[var(--danger-soft)] text-danger">
              <ShieldAlert size={20} />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Delete permanently?</h2>
              <p className="mt-1 text-sm text-fg-2">
                {num(okChecks.length)} item{okChecks.length === 1 ? "" : "s"} ({bytes(review?.removableBytes ?? 0)}) will be erased without going to the Recycle Bin. CLARITY cannot undo this, and neither can Windows.
              </p>
              <label className="mt-4 flex cursor-pointer items-center gap-2.5 text-sm">
                <Checkbox checked={ack} onChange={setAck} label="Acknowledge" />
                <span onClick={() => setAck(!ack)}>I understand these files cannot be recovered.</span>
              </label>
            </div>
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <Button tone="ghost" onClick={() => setStage("review")}>
              Back
            </Button>
            <Button tone="danger" disabled={!ack} icon={<Trash2 size={14} />} onClick={run}>
              Delete permanently
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-4 border-b hairline px-6 py-5">
            <div>
              <h2 className="text-lg font-semibold">Review cleanup</h2>
              <p className="mt-0.5 text-sm text-fg-3">Every item is checked again against the disk right now. Nothing has been removed yet.</p>
            </div>
            <Segmented
              value={mode}
              onChange={setMode}
              options={[
                { value: "recycle", label: "Recycle Bin" },
                { value: "permanent", label: "Permanently" },
              ]}
            />
          </div>
          {error && <div className="mx-6 mt-4 rounded-[8px] bg-[var(--danger-soft)] p-3 text-sm text-danger">{error}</div>}
          {!review ? (
            <div className="flex h-48 items-center justify-center gap-2 text-sm text-fg-3">
              <Spinner /> Checking {num(items.length)} items…
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-px border-b hairline bg-[var(--line)]">
                <Metric label="Selected" value={bytes(review.selectedBytes)} sub={`${num(review.checks.length)} items`} />
                <Metric label={mode === "recycle" ? "Moves to Recycle Bin" : "Will be deleted"} value={bytes(review.removableBytes)} sub={`${num(okChecks.length)} items`} />
                <Metric
                  label="Space actually freed"
                  value={bytes(review.freeableBytes)}
                  sub={mode === "recycle" ? "once you empty the Recycle Bin" : "immediately"}
                  accent
                />
              </div>
              <div className="scroll max-h-[38vh] px-3 py-2">
                {blocked.length > 0 && <GroupTitle tone="danger">Will be skipped ({blocked.length})</GroupTitle>}
                {blocked.map((c) => (
                  <CheckRow key={`${c.item.kind}${c.item.id}`} name={c.name || c.path} path={c.path} size={c.size} kind={c.item.kind} note={c.blocked!} tone="danger" />
                ))}
                {warned.length > 0 && <GroupTitle tone="warn">Read before continuing ({warned.length})</GroupTitle>}
                {warned.map((c) => (
                  <CheckRow key={`${c.item.kind}${c.item.id}`} name={c.name} path={c.path} size={c.size} kind={c.item.kind} note={c.warnings.join(" ")} tone="warn" />
                ))}
                {okChecks.length - warned.length > 0 && <GroupTitle>Ready ({okChecks.length - warned.length})</GroupTitle>}
                {okChecks
                  .filter((c) => c.warnings.length === 0)
                  .map((c) => (
                    <CheckRow key={`${c.item.kind}${c.item.id}`} name={c.name} path={c.path} size={c.size} kind={c.item.kind} />
                  ))}
              </div>
              <div className="flex items-center justify-between gap-4 border-t hairline px-6 py-4">
                <p className="max-w-[340px] text-xs text-fg-3">
                  {mode === "recycle" ? "You can restore items from the Windows Recycle Bin until it is emptied." : "Permanent deletion skips the Recycle Bin. You will be asked once more."}
                </p>
                <div className="flex gap-2">
                  <Button tone="ghost" onClick={close}>
                    Cancel
                  </Button>
                  {mode === "recycle" ? (
                    <Button tone="primary" disabled={okChecks.length === 0} icon={<Recycle size={14} />} onClick={run}>
                      Move {num(okChecks.length)} to Recycle Bin
                    </Button>
                  ) : (
                    <Button tone="danger" disabled={okChecks.length === 0} icon={<Trash2 size={14} />} onClick={() => setStage("confirm-permanent")}>
                      Continue…
                    </Button>
                  )}
                </div>
              </div>
            </>
          )}
          {stage === "running" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--glass-solid)]">
              <Spinner size={20} />
              <p className="text-sm text-fg-2">{mode === "recycle" ? "Moving to Recycle Bin…" : "Deleting…"}</p>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

function Result({ summary: s, onClose }: { summary: CleanupSummary; onClose: () => void }) {
  const problems = s.outcomes.filter((o) => o.status === "failed" || o.status === "skipped");
  return (
    <div className="p-6">
      <div className="flex items-center gap-3">
        {s.failed === 0 && s.skipped === 0 ? <CheckCircle2 size={22} className="text-ok" /> : <AlertTriangle size={22} className="text-warn" />}
        <h2 className="text-lg font-semibold">{s.succeeded > 0 ? (s.mode === "recycle" ? "Moved to Recycle Bin" : "Deleted") : "Nothing was removed"}</h2>
      </div>
      <div className="mt-5 grid grid-cols-3 gap-3">
        <Metric label={s.mode === "recycle" ? "In Recycle Bin" : "Removed"} value={bytes(s.bytesRemoved)} sub={`${num(s.succeeded)} items`} boxed />
        <Metric label="Space freed now" value={bytes(s.bytesFreed)} sub={s.mode === "recycle" ? "freed when the bin is emptied" : "confirmed"} boxed accent />
        <Metric label="Not removed" value={num(s.failed + s.skipped)} sub={s.failed + s.skipped ? "see below" : "none"} boxed />
      </div>
      {problems.length > 0 && (
        <div className="scroll mt-4 max-h-[30vh] rounded-[10px] shadow-[0_0_0_1px_var(--line)]">
          {problems.map((o, i) => (
            <div key={i} className="flex items-start gap-2 border-b hairline px-3 py-2 text-xs last:border-0">
              {o.status === "failed" ? <XCircle size={13} className="mt-0.5 shrink-0 text-danger" /> : <CircleSlash size={13} className="mt-0.5 shrink-0 text-fg-3" />}
              <div className="min-w-0">
                <div className="truncate font-mono text-[11px] text-fg-2">{o.path}</div>
                <div className="text-fg-3">{o.error}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="mt-6 flex justify-end">
        <Button tone="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}

function Metric({ label, value, sub, accent, boxed }: { label: string; value: string; sub: string; accent?: boolean; boxed?: boolean }) {
  return (
    <div className={clsx("bg-[var(--glass-solid)] px-5 py-4", boxed && "rounded-[10px] bg-[var(--glass-0)] shadow-[0_0_0_1px_var(--line)]")}>
      <div className="text-2xs font-medium uppercase tracking-[0.08em] text-fg-3">{label}</div>
      <div className={clsx("tabular mt-1 text-xl font-semibold tracking-tight", accent && "text-accent")}>{value}</div>
      <div className="text-2xs text-fg-4">{sub}</div>
    </div>
  );
}

function GroupTitle({ children, tone }: { children: ReactNode; tone?: "danger" | "warn" }) {
  return <div className={clsx("px-3 pb-1 pt-3 text-2xs font-semibold uppercase tracking-[0.1em]", tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : "text-fg-4")}>{children}</div>;
}

function CheckRow({ name, path, size, kind, note, tone }: { name: string; path: string; size: number; kind: string; note?: string; tone?: "danger" | "warn" }) {
  return (
    <div className="flex items-start gap-3 rounded-[8px] px-3 py-2 hover:bg-hover">
      <span className="mt-0.5">
        <FileIcon category={kind === "dir" ? "folder" : "other"} size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm">{name}</span>
          {kind === "dir" && <Badge>Folder</Badge>}
        </div>
        <div className="truncate font-mono text-2xs text-fg-4">{path}</div>
        {note && <div className={clsx("mt-0.5 text-xs", tone === "danger" ? "text-danger" : "text-warn")}>{note}</div>}
      </div>
      <span className="tabular shrink-0 text-xs text-fg-2">{bytes(size)}</span>
    </div>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex w-[340px] flex-col-reverse gap-2">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            className={clsx("glass-float pointer-events-auto flex items-start gap-2 px-3.5 py-2.5 text-sm", t.tone === "error" && "text-danger")}
          >
            {t.tone === "ok" ? <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-ok" /> : t.tone === "error" ? <XCircle size={15} className="mt-0.5 shrink-0" /> : null}
            <span className={t.tone === "error" ? "text-fg" : ""}>{t.text}</span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ["Ctrl 1 – 8", "Switch views"],
  ["↑ ↓  PgUp PgDn", "Move through a list"],
  ["Space", "Select / deselect for cleanup"],
  ["Enter", "Quick look"],
  ["I", "Show or hide the inspector"],
  ["Ctrl F", "Search in the current list"],
  ["Delete", "Review selected items"],
  ["Esc", "Close dialogs"],
  ["?", "This overview"],
];

export function ShortcutsOverlay() {
  const open = useApp((s) => s.shortcutsOpen);
  const set = useApp((s) => s.set);
  return (
    <Modal open={open} onClose={() => set({ shortcutsOpen: false })} className="w-[420px] p-5" label="Keyboard shortcuts">
      <h2 className="mb-3 text-base font-semibold">Keyboard shortcuts</h2>
      {SHORTCUTS.map(([k, d]) => (
        <div key={k} className="flex items-center justify-between border-b hairline py-2 text-sm last:border-0">
          <span className="text-fg-2">{d}</span>
          <span className="flex gap-1">
            {k.split("  ").map((p) => (
              <Kbd key={p}>{p}</Kbd>
            ))}
          </span>
        </div>
      ))}
    </Modal>
  );
}
