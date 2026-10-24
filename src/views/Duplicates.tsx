import clsx from "clsx";
import { AlertTriangle, CopyCheck, Link2, ShieldCheck } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { FileIcon } from "../components/FileIcon";
import { Badge, Button, Checkbox, Empty, Figure, Segmented, Spinner } from "../components/ui";
import { api, errorText } from "../lib/api";
import { ago, bytes, bytesParts, dateTime, num } from "../lib/format";
import type { DupGroupView, DupView, FileRow } from "../lib/types";
import { selKey, useApp } from "../store/app";
import { ViewHeader } from "./Lists";

const STAGES = ["", "Grouping by size", "Recognising hard links", "Comparing file edges", "Hashing contents (BLAKE3)", "Verifying byte by byte"];

export function Duplicates() {
  const version = useApp((s) => s.version);
  const running = useApp((s) => s.dupRunning);
  const progress = useApp((s) => s.dupProgress);
  const settings = useApp((s) => s.settings);
  const set = useApp((s) => s.set);
  const toast = useApp((s) => s.toast);
  const [data, setData] = useState<DupView | null>(null);

  useEffect(() => {
    api().duplicates().then(setData, (e) => toast(errorText(e), "error"));
  }, [version, running]);

  const minKb = settings?.dupMinKb ?? 10240;
  const setMin = async (dupMinKb: number) => {
    if (!settings) return;
    const next = { ...settings, dupMinKb };
    set({ settings: next });
    try {
      set({ settings: await api().saveSettings(next) });
    } catch (e) {
      toast(errorText(e), "error");
    }
  };
  const minPicker = (
    <Segmented
      size="sm"
      value={minKb}
      onChange={setMin}
      options={[
        { value: 1024, label: "1 MB+" },
        { value: 10240, label: "10 MB+" },
        { value: 102400, label: "100 MB+" },
        { value: 1048576, label: "1 GB+" },
      ]}
    />
  );

  const start = async () => {
    try {
      set({ dupRunning: true, dupProgress: null });
      await api().startDuplicates();
    } catch (e) {
      set({ dupRunning: false });
      toast(errorText(e), "error");
    }
  };

  if (running) {
    const pct = progress && progress.stage === 4 && progress.totalBytes > 0 ? progress.doneBytes / progress.totalBytes : null;
    return (
      <div className="flex h-full items-center justify-center">
        <div className="glass-float edge-light w-[520px] p-7">
          <div className="flex items-center gap-3">
            <Spinner size={18} />
            <h2 className="text-lg font-semibold">Looking for identical files…</h2>
          </div>
          <p className="mt-2 text-sm text-fg-3">{progress ? `${STAGES[progress.stage] ?? "Preparing"} · ${num(progress.candidates)} files of ${bytes(minKb * 1024)} or more` : "Preparing…"}</p>
          <div className="mt-5 h-[5px] overflow-hidden rounded-full bg-active">
            {pct != null ? <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${pct * 100}%` }} /> : <div className="shimmer h-full w-full" />}
          </div>
          <div className="mt-2 flex justify-between text-2xs text-fg-4">
            <span>{pct != null ? `${bytes(progress!.doneBytes)} of ${bytes(progress!.totalBytes)} read` : "Only same-size files are read"}</span>
            {pct != null && <span className="tabular">{Math.round(pct * 100)}%</span>}
          </div>
          <div className="mt-6 flex justify-end">
            <Button tone="ghost" onClick={() => api().cancelDuplicates()}>
              Cancel
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!data)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );

  if (!data.computed)
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="glass-float edge-light w-full max-w-[560px] p-8">
          <CopyCheck size={22} className="text-accent" />
          <h2 className="mt-4 text-xl font-semibold tracking-tight">Find files that exist more than once</h2>
          <p className="mt-2 text-sm text-fg-2">CLARITY compares actual file contents, not names. Only files with exactly the same size are read, and every match is verified byte by byte before it is shown.</p>
          <ul className="mt-4 space-y-1.5 text-xs text-fg-3">
            <li>• Hard links are recognised. They share one copy of the data, so they are not counted as duplicates.</li>
            <li>• Cloud-only files are skipped so nothing gets downloaded.</li>
          </ul>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 whitespace-nowrap text-xs text-fg-3">
              Minimum size {minPicker}
            </div>
            <Button tone="primary" icon={<CopyCheck size={14} />} onClick={start}>
              Find duplicates
            </Button>
          </div>
        </div>
      </div>
    );

  const [v, u] = bytesParts(data.reclaimable);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader
        title="Duplicates"
        actions={
          <>
            {minPicker}
            <Button size="sm" onClick={start}>
              Search again
            </Button>
          </>
        }
      >
        Byte-for-byte identical files. Nothing is pre-selected. For each group, choose the copy you want to keep.
      </ViewHeader>
      <div className="mb-3 flex items-center gap-6 px-1">
        <div>
          <Figure value={v} unit={u} className="text-2xl" />
          <div className="text-xs text-fg-3">could be freed by keeping one copy of each</div>
        </div>
        <div className="text-xs text-fg-3">
          {num(data.groups.length)} groups · {num(data.filesConsidered)} files compared · {bytes(data.hashedBytes)} read
          {data.unreadable > 0 && ` · ${num(data.unreadable)} could not be read`}
          <div className="text-fg-4">Searched {dateTime(data.finishedAt)}</div>
        </div>
      </div>
      {data.groups.length === 0 ? (
        <Empty icon={<ShieldCheck size={18} />} title="No duplicates found">
          No two files of {bytes(data.minSize)} or more have identical content.
        </Empty>
      ) : (
        <div className="scroll -mx-1 min-h-0 flex-1 space-y-2.5 px-1 pb-24">
          {data.groups.map((g, i) => (
            <Group key={g.id} g={g} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}

function Group({ g, index }: { g: DupGroupView; index: number }) {
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const toggleSelect = useApp((s) => s.toggleSelect);
  const inspect = useApp((s) => s.inspect);
  const inspector = useApp((s) => s.inspector);
  const toSel = (f: FileRow) => ({ kind: "file" as const, id: f.id, name: f.name, path: `${f.dir}\\${f.name}`, size: f.size });
  const selectedCount = g.files.filter((f) => selection.has(selKey("file", f.id))).length;
  const allSelected = selectedCount === g.files.length;

  const keepOnly = (keep: FileRow) => {
    select(g.files.filter((f) => f.id !== keep.id).map(toSel), true);
    select([toSel(keep)], false);
  };

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(index, 10) * 0.025 }} className="glass edge-light overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-2.5">
        <FileIcon category={g.files[0].category} size={15} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{g.files[0].name}</span>
        <span className="tabular text-xs text-fg-3">
          {g.files.length} × {bytes(g.size)}
        </span>
        <Badge tone="accent">{bytes(g.reclaimable)} extra</Badge>
      </div>
      {allSelected && (
        <div className="mx-3 mb-2 flex items-center gap-2 rounded-[8px] bg-[var(--warn-soft)] px-3 py-1.5 text-xs text-warn">
          <AlertTriangle size={13} /> All copies are selected. Keep at least one unless you want this content gone entirely.
        </div>
      )}
      <div className="border-t hairline">
        {g.files.map((f) => {
          const sel = selection.has(selKey("file", f.id));
          return (
            <div key={f.id} onClick={() => inspect({ kind: "file", id: f.id })} className={clsx("group flex h-11 cursor-default items-center gap-3 px-4 transition-colors", inspector?.kind === "file" && inspector.id === f.id ? "bg-accent-soft" : "hover:bg-hover")}>
              <Checkbox checked={sel} onChange={() => toggleSelect(toSel(f))} label={`Select ${f.name}`} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[11.5px] text-fg-2">
                  {f.dir}\<span className="text-fg">{f.name}</span>
                </div>
                <div className="text-2xs text-fg-4">
                  modified {ago(f.modified)} · created {ago(f.created)}
                </div>
              </div>
              {!sel && selectedCount > 0 && <Badge tone="ok">Keeps</Badge>}
              <button onClick={(e) => (e.stopPropagation(), keepOnly(f))} className="rounded-[6px] px-2 py-1 text-xs font-medium text-fg-3 opacity-0 transition-opacity hover:bg-hover hover:text-fg group-hover:opacity-100">
                Keep only this one
              </button>
            </div>
          );
        })}
        {g.hardlinked.length > 0 && (
          <div className="flex items-center gap-2 border-t hairline px-4 py-2 text-2xs text-fg-4">
            <Link2 size={12} /> Also hard-linked as: {g.hardlinked.map((h) => h.name).join(", ")} (same data, not extra copies)
          </div>
        )}
      </div>
    </motion.div>
  );
}
