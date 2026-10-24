import { ArrowDownToLine, Info, Search, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { FileList, type ListTotals } from "../components/FileList";
import { startScan } from "../components/Scan";
import { Button, Chip, Empty, Figure, Segmented } from "../components/ui";
import { bytes, bytesParts, CATEGORY_LABEL, catColor, num } from "../lib/format";
import type { Category, DateField, FileQuery } from "../lib/types";
import { useApp } from "../store/app";
import { useOverview } from "./Overview";
import { openOrganizer } from "./Organizer";
import { Wand2 } from "lucide-react";

const CATS: Category[] = ["video", "images", "audio", "documents", "archives", "installers", "code", "apps", "system", "other"];

export function ViewHeader({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-6 px-1">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
        {children && <p className="mt-0.5 max-w-[720px] text-sm text-fg-3">{children}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder = "Search by name or path" }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [local, setLocal] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => local !== value && onChange(local), 220);
    return () => clearTimeout(t);
  }, [local]);
  useEffect(() => {
    const f = () => ref.current?.focus();
    window.addEventListener("clarity:focus-search", f);
    return () => window.removeEventListener("clarity:focus-search", f);
  }, []);
  return (
    <div className="flex h-8 w-[260px] items-center gap-2 rounded-[8px] bg-hover px-2.5 shadow-[0_0_0_1px_var(--line)] focus-within:shadow-[0_0_0_1.5px_var(--accent-line)]">
      <Search size={14} className="shrink-0 text-fg-3" />
      <input ref={ref} value={local} onChange={(e) => setLocal(e.target.value)} placeholder={placeholder} className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-4" onKeyDown={(e) => e.key === "Escape" && setLocal("")} />
      {local && (
        <button aria-label="Clear search" onClick={() => setLocal("")} className="text-fg-3 hover:text-fg">
          <X size={13} />
        </button>
      )}
    </div>
  );
}

function CategoryChips({ value, onChange }: { value: Category[]; onChange: (v: Category[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <Chip active={value.length === 0} onClick={() => onChange([])}>
        All types
      </Chip>
      {CATS.map((c) => (
        <Chip key={c} color={catColor(c)} active={value.includes(c)} onClick={() => onChange(value.includes(c) ? value.filter((x) => x !== c) : [...value, c])}>
          {CATEGORY_LABEL[c].split(" ")[0]}
        </Chip>
      ))}
    </div>
  );
}

function ListFrame({ toolbar, totals, children, note }: { toolbar: ReactNode; totals: ListTotals | null; children: ReactNode; note?: ReactNode }) {
  const [v, u] = bytesParts(totals?.totalBytes ?? 0);
  return (
    <div className="glass edge-light flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-3 px-4 py-3">
        {toolbar}
        <div className="ml-auto flex items-baseline gap-2">
          <Figure value={v} unit={u} className="text-lg" />
          <span className="tabular text-xs text-fg-3">in {num(totals?.total ?? 0)} files</span>
        </div>
      </div>
      {note}
      {children}
    </div>
  );
}

const AGE_OPTIONS = [
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: 182, label: "6 months" },
  { value: 365, label: "1 year" },
  { value: 730, label: "2 years" },
  { value: -1, label: "Custom" },
];

export function OldFiles() {
  const info = useApp((s) => s.info);
  const settings = useApp((s) => s.settings);
  const [days, setDays] = useState(settings?.oldDays && AGE_OPTIONS.some((o) => o.value === settings.oldDays) ? settings.oldDays : 365);
  const [field, setField] = useState<DateField>("modified");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [cats, setCats] = useState<Category[]>([]);
  const [search, setSearch] = useState("");
  const [totals, setTotals] = useState<ListTotals | null>(null);
  const accessUnreliable = info?.lastAccess.enabled !== true;

  const toUnix = (d: string, end = false) => (d ? Math.floor(new Date(d + (end ? "T23:59:59" : "T00:00:00")).getTime() / 1000) : null);
  const q: FileQuery = days === -1 ? { dateField: field, from: toUnix(from), to: toUnix(to, true), categories: cats, search } : { dateField: field, olderThanDays: days, categories: cats, search };
  const label = field === "modified" ? "not modified" : field === "created" ? "created more than" : "not accessed";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader title="Old & Unused Files" actions={<SearchBox value={search} onChange={setSearch} />}>
        Files whose content has not changed for a long time. An old date does not prove a file is unused, so treat this as a list to review.
      </ViewHeader>
      <ListFrame
        totals={totals}
        toolbar={
          <>
            <Segmented value={days} onChange={setDays} options={AGE_OPTIONS} size="sm" />
            {days === -1 && (
              <div className="flex items-center gap-1.5 text-xs text-fg-3">
                <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-7 rounded-[6px] bg-hover px-2 text-xs shadow-[0_0_0_1px_var(--line)] [color-scheme:inherit]" aria-label="From" />
                –
                <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-7 rounded-[6px] bg-hover px-2 text-xs shadow-[0_0_0_1px_var(--line)]" aria-label="To" />
              </div>
            )}
            <Segmented
              value={field}
              onChange={setField}
              size="sm"
              options={[
                { value: "modified", label: "Modified", title: "When the content last changed. Reliable." },
                { value: "created", label: "Created", title: "When the file appeared at this location (copying resets it)." },
                { value: "accessed", label: "Accessed", title: info?.lastAccess.explanation },
              ]}
            />
          </>
        }
        note={
          <>
            <div className="shrink-0 px-4 pb-2">
              <CategoryChips value={cats} onChange={setCats} />
            </div>
            {field === "accessed" && (
              <div className="mx-4 mb-2 flex gap-2 rounded-[8px] bg-[var(--warn-soft)] px-3 py-2 text-xs text-warn">
                <Info size={14} className="mt-[1px] shrink-0" />
                <span>{accessUnreliable ? "This PC does not reliably record when files are opened. Access dates here mostly reflect when files were created or copied, not when you last used them." : info?.lastAccess.explanation}</span>
              </div>
            )}
            <div className="shrink-0 px-4 pb-1 text-2xs text-fg-4">
              {days === -1 ? `Files with a ${field} date in the chosen range` : `Files ${label} ${field === "created" ? `${AGE_OPTIONS.find((o) => o.value === days)?.label} ago` : `for over ${AGE_OPTIONS.find((o) => o.value === days)?.label}`}`}, largest first.
            </div>
          </>
        }
      >
        <FileList query={q} dateField={field} onTotals={setTotals} autoFocus empty={<Empty title="No files match">Nothing in the scanned folders is that old. Try a shorter period.</Empty>} />
      </ListFrame>
    </div>
  );
}

const SIZE_OPTIONS = [
  { value: 0, label: "Any size" },
  { value: 100, label: "100 MB+" },
  { value: 500, label: "500 MB+" },
  { value: 1024, label: "1 GB+" },
  { value: 5120, label: "5 GB+" },
];

export function LargeFiles() {
  const intent = useApp((s) => s.intent);
  const settings = useApp((s) => s.settings);
  const [min, setMin] = useState(intent?.categories ? 0 : settings?.largeMb && SIZE_OPTIONS.some((o) => o.value === settings.largeMb) ? settings.largeMb : 100);
  const [cats, setCats] = useState<Category[]>(intent?.categories ?? []);
  const [search, setSearch] = useState("");
  const [totals, setTotals] = useState<ListTotals | null>(null);
  useEffect(() => {
    if (intent?.categories) {
      setCats(intent.categories);
      setMin(0);
    }
  }, [intent]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader title={cats.length === 1 && min === 0 ? CATEGORY_LABEL[cats[0]] : "Large Files"} actions={<SearchBox value={search} onChange={setSearch} />}>
        The biggest single files in the scanned locations. A few large files often account for most of the used space.
      </ViewHeader>
      <ListFrame totals={totals} toolbar={<Segmented value={min} onChange={setMin} options={SIZE_OPTIONS} size="sm" />} note={<div className="shrink-0 px-4 pb-2"><CategoryChips value={cats} onChange={setCats} /></div>}>
        <FileList query={{ minSize: min ? min * 1024 * 1024 : null, categories: cats, search }} onTotals={setTotals} autoFocus empty={<Empty title="No files this large">Lower the size threshold to see more.</Empty>} />
      </ListFrame>
    </div>
  );
}

export function Downloads() {
  const { data } = useOverview();
  const info = useApp((s) => s.info);
  const [filter, setFilter] = useState<"all" | "old" | "installers" | "archives">("all");
  const [search, setSearch] = useState("");
  const [totals, setTotals] = useState<ListTotals | null>(null);
  if (data && !data.downloads)
    return (
      <Empty icon={<ArrowDownToLine size={18} />} title="Your Downloads folder was not part of this scan" action={info?.downloadsPath && <Button tone="primary" onClick={() => startScan([info.downloadsPath!])}>Scan Downloads</Button>}>
        {info?.downloadsPath ? `Scan ${info.downloadsPath} to see what has piled up there.` : "CLARITY could not find a Downloads folder for this user."}
      </Empty>
    );
  if (!data?.downloads) return null;
  const dl = data.downloads;
  const q: FileQuery = { underDir: dl.dirId, search, ...(filter === "old" ? { olderThanDays: 182 } : filter === "installers" ? { categories: ["installers", "apps"] } : filter === "archives" ? { categories: ["archives"] } : {}) };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader title="Downloads" actions={<><Button size="sm" icon={<Wand2 size={13} />} onClick={() => openOrganizer(dl.path)}>Organize</Button><SearchBox value={search} onChange={setSearch} /></>}>
        <span className="font-mono text-xs">{dl.path}</span> · {bytes(dl.bytes)} in {num(dl.files)} files, {bytes(dl.oldBytes)} of it unchanged for over 6 months.
      </ViewHeader>
      <ListFrame
        totals={totals}
        toolbar={
          <Segmented
            value={filter}
            onChange={setFilter}
            size="sm"
            options={[
              { value: "all", label: "Everything" },
              { value: "old", label: "Older than 6 months" },
              { value: "installers", label: "Installers" },
              { value: "archives", label: "Archives" },
            ]}
          />
        }
      >
        <FileList query={q} onTotals={setTotals} autoFocus />
      </ListFrame>
    </div>
  );
}
