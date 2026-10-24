import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import { ArrowDown, ArrowUp, Cloud } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, errorText } from "../lib/api";
import { ago, bytes, date, num, REC_LABEL, recKinds } from "../lib/format";
import type { DateField, FileQuery, FileRow, SortKey } from "../lib/types";
import { selKey, useApp } from "../store/app";
import { FileIcon } from "./FileIcon";
import { Badge, Checkbox, Empty, Spinner } from "./ui";

const PAGE = 200;
const ROW_H = 46;

export interface ListTotals {
  total: number;
  totalBytes: number;
}

interface Props {
  query: FileQuery;
  defaultSort?: SortKey;
  defaultDesc?: boolean;
  dateField?: DateField;
  showReasons?: boolean;
  onTotals?: (t: ListTotals) => void;
  empty?: ReactNode;
  autoFocus?: boolean;
}

const toSel = (r: FileRow) => ({ kind: "file" as const, id: r.id, name: r.name, path: `${r.dir}\\${r.name}`, size: r.size });

export function FileList({ query, defaultSort = "size", defaultDesc = true, dateField = "modified", showReasons = true, onTotals, empty, autoFocus }: Props) {
  const [sort, setSort] = useState<SortKey>(defaultSort);
  const [desc, setDesc] = useState(defaultDesc);
  const [total, setTotal] = useState<number | null>(null);
  const [pages, setPages] = useState<Map<number, FileRow[]>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const loading = useRef(new Set<number>());
  const parentRef = useRef<HTMLDivElement>(null);
  const version = useApp((s) => s.version);
  const selection = useApp((s) => s.selection);
  const toggleSelect = useApp((s) => s.toggleSelect);
  const select = useApp((s) => s.select);
  const inspect = useApp((s) => s.inspect);
  const inspector = useApp((s) => s.inspector);
  const set = useApp((s) => s.set);
  const toast = useApp((s) => s.toast);

  const fullQuery = useMemo(() => ({ ...query, sort, desc, dateField: query.dateField ?? dateField }), [JSON.stringify(query), sort, desc, dateField]);
  const key = JSON.stringify(fullQuery) + version;
  const keyRef = useRef(key);

  const loadPage = useCallback(
    async (page: number) => {
      if (loading.current.has(page)) return;
      loading.current.add(page);
      const k = keyRef.current;
      try {
        const r = await api().queryFiles({ ...fullQuery, offset: page * PAGE, limit: PAGE });
        if (keyRef.current !== k) return;
        setTotal(r.total);
        onTotals?.({ total: r.total, totalBytes: r.totalBytes });
        setPages((p) => new Map(p).set(page, r.items));
        setError(null);
      } catch (e) {
        if (keyRef.current === k) setError(errorText(e));
      } finally {
        loading.current.delete(page);
      }
    },
    [fullQuery],
  );

  useEffect(() => {
    keyRef.current = key;
    loading.current.clear();
    setPages(new Map());
    setTotal(null);
    setActive(0);
    parentRef.current?.scrollTo({ top: 0 });
    void loadPage(0);
  }, [key]);

  const v = useVirtualizer({ count: total ?? 0, getScrollElement: () => parentRef.current, estimateSize: () => ROW_H, overscan: 12 });
  const items = v.getVirtualItems();

  useEffect(() => {
    if (!items.length) return;
    const first = Math.floor(items[0].index / PAGE);
    const last = Math.floor(items[items.length - 1].index / PAGE);
    for (let p = first; p <= last; p++) if (!pages.has(p)) void loadPage(p);
  }, [items.length ? items[0].index : -1, items.length ? items[items.length - 1].index : -1, pages, loadPage]);

  const rowAt = (i: number) => pages.get(Math.floor(i / PAGE))?.[i % PAGE];

  const activate = (i: number) => {
    if (total == null || total === 0) return;
    const n = Math.max(0, Math.min(total - 1, i));
    setActive(n);
    v.scrollToIndex(n, { align: "auto" });
    const r = rowAt(n);
    if (r) inspect({ kind: "file", id: r.id });
  };

  useEffect(() => {
    if (autoFocus) parentRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const onKey = (e: React.KeyboardEvent) => {
    const r = rowAt(active);
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        activate(active + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        activate(active - 1);
        break;
      case "PageDown":
        e.preventDefault();
        activate(active + 12);
        break;
      case "PageUp":
        e.preventDefault();
        activate(active - 12);
        break;
      case "Home":
        e.preventDefault();
        activate(0);
        break;
      case "End":
        e.preventDefault();
        activate((total ?? 1) - 1);
        break;
      case " ":
        e.preventDefault();
        if (r) toggleSelect(toSel(r));
        break;
      case "Enter":
        e.preventDefault();
        if (r) set({ quickLook: r.id });
        break;
    }
  };

  const headerSort = (k: SortKey, natural: boolean) => {
    if (sort === k) setDesc(!desc);
    else {
      setSort(k);
      setDesc(natural);
    }
  };

  const loaded = [...pages.values()].flat();
  const loadedSelected = loaded.filter((r) => selection.has(selKey("file", r.id))).length;
  const allLoadedSelected = loaded.length > 0 && loadedSelected === loaded.length;

  const selectAll = async () => {
    if (allLoadedSelected) {
      select(loaded.map(toSel), false);
      return;
    }
    const r = await api().queryFiles({ ...fullQuery, offset: 0, limit: 2000 });
    select(r.items.map(toSel), true);
    if (r.total > 2000) toast(`Selected the first 2,000 of ${num(r.total)} files. Narrow the filter to select the rest.`);
  };

  const dateLabel = dateField === "accessed" ? "Last accessed" : dateField === "created" ? "Created" : "Modified";
  const dateOf = (r: FileRow) => (dateField === "accessed" ? r.accessed : dateField === "created" ? r.created : r.modified);

  if (error) return <Empty title="Could not load files">{error}</Empty>;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid h-8 shrink-0 items-center gap-3 border-b hairline px-4 text-2xs font-medium uppercase tracking-[0.08em] text-fg-3" style={{ gridTemplateColumns: COLS(showReasons) }}>
        <Checkbox checked={allLoadedSelected} indeterminate={loadedSelected > 0 && !allLoadedSelected} onChange={selectAll} label="Select all" />
        <SortHead label="Name" k="name" sort={sort} desc={desc} onClick={() => headerSort("name", false)} />
        {showReasons && <SortHead label="Why" k="reason" sort={sort} desc={desc} onClick={() => headerSort("reason", false)} />}
        <SortHead label={dateLabel} k={dateField} sort={sort} desc={desc} onClick={() => headerSort(dateField, false)} align="right" />
        <SortHead label="Size" k="size" sort={sort} desc={desc} onClick={() => headerSort("size", true)} align="right" />
      </div>
      <div ref={parentRef} tabIndex={0} onKeyDown={onKey} className="scroll relative min-h-0 flex-1 outline-none" aria-label="File list" role="listbox">
        {total === null && (
          <div className="flex h-40 items-center justify-center">
            <Spinner />
          </div>
        )}
        {total === 0 && (empty ?? <Empty title="Nothing matches">Try a broader filter.</Empty>)}
        <div style={{ height: v.getTotalSize(), position: "relative" }}>
          {items.map((vi) => {
            const r = rowAt(vi.index);
            const isActive = vi.index === active;
            const selected = r ? selection.has(selKey("file", r.id)) : false;
            const inspected = r && inspector?.kind === "file" && inspector.id === r.id;
            return (
              <div
                key={vi.key}
                role="option"
                aria-selected={selected}
                className={clsx(
                  "absolute left-0 right-0 grid items-center gap-3 px-4 transition-colors duration-75",
                  inspected ? "bg-accent-soft" : selected ? "bg-hover" : "hover:bg-hover",
                  isActive && "shadow-[inset_2px_0_0_var(--accent)]",
                )}
                style={{ top: vi.start, height: ROW_H, gridTemplateColumns: COLS(showReasons) }}
                onClick={() => {
                  setActive(vi.index);
                  if (r) inspect({ kind: "file", id: r.id });
                  parentRef.current?.focus({ preventScroll: true });
                }}
                onDoubleClick={() => r && set({ quickLook: r.id })}
              >
                {r ? (
                  <>
                    <Checkbox checked={selected} onChange={() => toggleSelect(toSel(r))} label={`Select ${r.name}`} />
                    <div className="flex min-w-0 items-center gap-2.5">
                      <FileIcon category={r.category} size={15} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm text-fg">{r.name}</span>
                          {r.cloud && <Cloud size={12} className="shrink-0 text-fg-3" aria-label="Cloud-only" />}
                        </div>
                        <div className="truncate font-mono text-2xs text-fg-4">{r.dir}</div>
                      </div>
                    </div>
                    {showReasons && (
                      <div className="flex min-w-0 gap-1 overflow-hidden">
                        {recKinds(r.recs)
                          .slice(0, 1)
                          .map((k) => (
                            <Badge key={k} tone={k === "duplicate" ? "accent" : "neutral"}>
                              {REC_LABEL[k]}
                            </Badge>
                          ))}
                        {recKinds(r.recs).length > 1 && <Badge title={recKinds(r.recs).slice(1).map((k) => REC_LABEL[k]).join(", ")}>+{recKinds(r.recs).length - 1}</Badge>}
                      </div>
                    )}
                    <div className="text-right text-xs text-fg-2" title={date(dateOf(r))}>
                      {ago(dateOf(r))}
                    </div>
                    <div className="tabular text-right text-sm font-medium text-fg">{bytes(r.size)}</div>
                  </>
                ) : (
                  <div className="col-span-full h-3 w-1/3 rounded bg-hover" />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const COLS = (reasons: boolean) => (reasons ? "15px minmax(0,1fr) 150px 96px 84px" : "15px minmax(0,1fr) 110px 84px");

function SortHead({ label, k, sort, desc, onClick, align }: { label: string; k: SortKey; sort: SortKey; desc: boolean; onClick: () => void; align?: "right" }) {
  const on = sort === k;
  return (
    <button onClick={onClick} className={clsx("flex items-center gap-1 uppercase tracking-[0.08em] hover:text-fg", on && "text-fg-2", align === "right" && "justify-end")}>
      {label}
      {on && (desc ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
    </button>
  );
}
