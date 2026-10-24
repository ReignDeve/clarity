import clsx from "clsx";
import { ChevronRight, CornerLeftUp, FolderOpen, HardDrive, Wand2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { FileIcon } from "../components/FileIcon";
import { FileList } from "../components/FileList";
import { Checkbox, Empty, IconButton, Spinner } from "../components/ui";
import { api, errorText } from "../lib/api";
import { ago, bytes, num } from "../lib/format";
import type { DirListing, DirRow, FileRow } from "../lib/types";
import { selKey, useApp } from "../store/app";
import { SearchBox } from "./Lists";
import { openOrganizer } from "./Organizer";

type Sort = "size" | "name" | "modified";

export function Explorer() {
  const intent = useApp((s) => s.intent);
  const version = useApp((s) => s.version);
  const inspect = useApp((s) => s.inspect);
  const inspector = useApp((s) => s.inspector);
  const selection = useApp((s) => s.selection);
  const toggleSelect = useApp((s) => s.toggleSelect);
  const set = useApp((s) => s.set);
  const toast = useApp((s) => s.toast);
  const [dir, setDir] = useState<number | null>(intent?.dir ?? null);
  const [data, setData] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>("size");

  useEffect(() => {
    if (intent?.dir != null) setDir(intent.dir);
  }, [intent]);

  useEffect(() => {
    let cancelled = false;
    api()
      .listDir(dir)
      .then((d) => {
        if (cancelled) return;
        // With a single root, start inside it.
        if (dir == null && d.dirs.length === 1) setDir(d.dirs[0].id);
        else setData(d);
        setError(null);
      }, (e) => !cancelled && setError(errorText(e)));
    return () => {
      cancelled = true;
    };
  }, [dir, version]);

  const rows = useMemo(() => {
    if (!data) return [];
    const items: ({ t: "d"; d: DirRow } | { t: "f"; f: FileRow })[] = [...data.dirs.map((d) => ({ t: "d" as const, d })), ...data.files.map((f) => ({ t: "f" as const, f }))];
    const name = (x: (typeof items)[number]) => (x.t === "d" ? x.d.name : x.f.name).toLowerCase();
    const size = (x: (typeof items)[number]) => (x.t === "d" ? x.d.size : x.f.size);
    const mod = (x: (typeof items)[number]) => (x.t === "d" ? x.d.latestModified : x.f.modified);
    return items.sort((a, b) => (sort === "name" ? (a.t !== b.t ? (a.t === "d" ? -1 : 1) : name(a).localeCompare(name(b))) : sort === "modified" ? mod(b) - mod(a) : size(b) - size(a)));
  }, [data, sort]);

  if (error) return <Empty title="Could not open this folder">{error}</Empty>;
  if (!data)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );

  const parent = data.crumbs.length > 1 ? data.crumbs[data.crumbs.length - 2].id : null;
  const total = data.dir?.size ?? data.dirs.reduce((s, d) => s + d.size, 0);

  return (
    <div className="glass edge-light flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b hairline px-3 py-2.5">
        <IconButton label="Up one level" disabled={parent == null && data.dir == null} onClick={() => setDir(parent)}>
          <CornerLeftUp size={14} />
        </IconButton>
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
          <button onClick={() => setDir(null)} className="rounded px-1 text-fg-3 hover:text-fg" aria-label="All scanned locations">
            <HardDrive size={14} />
          </button>
          {data.crumbs.map((c, i) => (
            <span key={c.id} className="flex min-w-0 items-center gap-0.5">
              <ChevronRight size={12} className="shrink-0 text-fg-4" />
              <button onClick={() => setDir(c.id)} className={clsx("truncate rounded px-1 text-sm", i === data.crumbs.length - 1 ? "font-medium text-fg" : "text-fg-3 hover:text-fg")}>
                {c.name}
              </button>
            </span>
          ))}
        </div>
        <SearchBox value={search} onChange={setSearch} placeholder="Search in this folder" />
        {data.dir && (
          <button onClick={() => openOrganizer(data.dir!.path)} className="flex h-7 items-center gap-1.5 rounded-[7px] px-2.5 text-xs font-medium text-fg-2 shadow-[0_0_0_1px_var(--line-2)] hover:bg-hover hover:text-fg" title="Propose a tidy structure for the loose files in this folder">
            <Wand2 size={13} className="text-accent" /> Organize
          </button>
        )}
        {data.dir && (
          <IconButton label="Open in Windows Explorer" onClick={() => api().reveal({ kind: "dir", id: data.dir!.id }).catch((e) => toast(errorText(e), "error"))}>
            <FolderOpen size={14} />
          </IconButton>
        )}
      </div>

      {search && data.dir ? (
        <FileList query={{ underDir: data.dir.id, search }} autoFocus />
      ) : (
        <>
          <div className="grid h-8 shrink-0 items-center gap-3 border-b hairline px-4 text-2xs font-medium uppercase tracking-[0.08em] text-fg-3" style={{ gridTemplateColumns: COLS }}>
            <span />
            <HeadBtn on={sort === "name"} onClick={() => setSort("name")}>
              Name
            </HeadBtn>
            <span>Share</span>
            <HeadBtn on={sort === "modified"} onClick={() => setSort("modified")} right>
              Changed
            </HeadBtn>
            <HeadBtn on={sort === "size"} onClick={() => setSort("size")} right>
              Size
            </HeadBtn>
          </div>
          <div className="scroll min-h-0 flex-1 pb-24">
            {rows.length === 0 && <Empty title="This folder is empty" />}
            {rows.map((r) => {
              const isDir = r.t === "d";
              const id = isDir ? r.d.id : r.f.id;
              const kind = isDir ? "dir" : "file";
              const sel = selection.has(selKey(kind, id));
              const size = isDir ? r.d.size : r.f.size;
              const name = isDir ? r.d.name : r.f.name;
              return (
                <div
                  key={`${kind}${id}`}
                  onClick={() => inspect({ kind, id })}
                  onDoubleClick={() => (isDir ? setDir(id) : set({ quickLook: id }))}
                  className={clsx("grid h-10 items-center gap-3 px-4", inspector?.kind === kind && inspector.id === id ? "bg-accent-soft" : sel ? "bg-hover" : "hover:bg-hover")}
                  style={{ gridTemplateColumns: COLS }}
                >
                  <Checkbox checked={sel} onChange={() => toggleSelect({ kind, id, name, path: isDir ? r.d.path : `${r.f.dir}\\${r.f.name}`, size })} label={`Select ${name}`} />
                  <div className="flex min-w-0 items-center gap-2.5">
                    <FileIcon category={isDir ? "folder" : r.f.category} size={15} />
                    <span className="truncate text-sm">{name}</span>
                    {isDir && <span className="tabular shrink-0 text-2xs text-fg-4">{num(r.d.files)} files</span>}
                    {isDir && r.d.unreadable && <span className="text-2xs text-warn">partly unreadable</span>}
                  </div>
                  <div className="h-[5px] overflow-hidden rounded-full bg-active">
                    <div className="h-full rounded-full" style={{ width: `${total ? (size / total) * 100 : 0}%`, background: isDir ? "var(--c-folder)" : `var(--c-${r.f.category})`, opacity: 0.75 }} />
                  </div>
                  <span className="text-right text-xs text-fg-3">{ago(isDir ? r.d.latestModified : r.f.modified)}</span>
                  <span className="tabular text-right text-sm font-medium">{bytes(size)}</span>
                </div>
              );
            })}
            {data.fileTotal > data.files.length && <div className="px-4 py-3 text-xs text-fg-3">Showing the largest {num(data.files.length)} of {num(data.fileTotal)} files. Use search to find others.</div>}
          </div>
        </>
      )}
    </div>
  );
}

const COLS = "15px minmax(0,1fr) 120px 90px 84px";

function HeadBtn({ on, onClick, right, children }: { on: boolean; onClick: () => void; right?: boolean; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={clsx("uppercase tracking-[0.08em] hover:text-fg", on && "text-fg-2", right && "text-right")}>
      {children}
    </button>
  );
}
