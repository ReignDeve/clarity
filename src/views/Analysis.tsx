import { hierarchy, treemap, treemapSquarify, type HierarchyRectangularNode } from "d3-hierarchy";
import { ChevronRight, CornerLeftUp } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FileIcon } from "../components/FileIcon";
import { Empty, IconButton, Panel, Segmented, Spinner } from "../components/ui";
import { api, errorText } from "../lib/api";
import { bytes, CATEGORY_LABEL, catColor } from "../lib/format";
import type { TreeNode, TreeView } from "../lib/types";
import { useApp, type AnalysisTab } from "../store/app";
import { ActivityView } from "./Activity";
import { Timeline } from "./Timeline";
import { Watchlist } from "./Watchlist";

const GROUP_HUES = ["var(--accent)", "var(--violet)", "var(--c-images)", "var(--c-documents)", "var(--c-audio)", "var(--c-archives)", "var(--c-code)", "var(--c-apps)"];

export function Analysis() {
  const tab = useApp((s) => s.analysisTab);
  const set = useApp((s) => s.set);
  const unseen = useApp((s) => s.navCounts?.analysis ?? 0);
  const blurb: Record<AnalysisTab, string> = {
    map: "Where your space is going right now.",
    timeline: "How your storage changed between scans, and what caused it.",
    activity: "When files were created or changed, according to their own timestamps.",
    watchlist: "Folders and drives you keep an eye on, with limits and growth alerts.",
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-3 flex items-end justify-between gap-4 px-1">
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold tracking-tight">Storage Analysis</h1>
          <p className="mt-0.5 truncate text-sm text-fg-3">{blurb[tab]}</p>
        </div>
        <Segmented
          value={tab}
          onChange={(analysisTab) => set({ analysisTab })}
          options={[
            { value: "map", label: "Map" },
            { value: "timeline", label: "Timeline" },
            { value: "activity", label: "Activity" },
            { value: "watchlist", label: unseen ? `Watchlist · ${unseen}` : "Watchlist" },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1">{tab === "map" ? <StorageMap /> : tab === "timeline" ? <Timeline /> : tab === "activity" ? <ActivityView /> : <Watchlist />}</div>
    </div>
  );
}

function StorageMap() {
  const version = useApp((s) => s.version);
  const intent = useApp((s) => s.intent);
  const inspect = useApp((s) => s.inspect);
  const go = useApp((s) => s.go);
  const [dir, setDir] = useState<number | null>(intent?.dir ?? null);
  const [data, setData] = useState<TreeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<TreeNode | null>(null);

  useEffect(() => {
    let cancelled = false;
    api()
      .tree(dir, 2)
      .then((d) => !cancelled && (setData(d), setError(null)), (e) => !cancelled && setError(errorText(e)));
    return () => {
      cancelled = true;
    };
  }, [dir, version]);

  if (error) return <Empty title="Could not load the storage map">{error}</Empty>;
  if (!data)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );

  const root = data.root;
  const parent = data.crumbs.length > 1 ? data.crumbs[data.crumbs.length - 2].id : null;
  const open = (n: TreeNode) => {
    if (n.kind === "dir" && n.id >= 0) {
      if (n.children.length > 0 || n.size > 0) setDir(n.id);
      inspect({ kind: "dir", id: n.id });
    } else if (n.kind === "file") inspect({ kind: "file", id: n.id });
  };

  return (
    <div className="flex h-full min-h-0 gap-3">
      <Panel
        className="min-w-0 flex-1"
        pad={false}
        title={
          <div className="flex items-center gap-1 normal-case tracking-normal">
            {data.crumbs.map((c, i) => (
              <span key={c.id} className="flex items-center gap-1">
                {i > 0 && <ChevronRight size={12} className="text-fg-4" />}
                <button onClick={() => setDir(c.id)} className={`rounded px-1 text-sm font-medium ${i === data.crumbs.length - 1 ? "text-fg" : "text-fg-3 hover:text-fg"}`}>
                  {c.name}
                </button>
              </span>
            ))}
          </div>
        }
        actions={
          <>
            <span className="tabular mr-2 text-xs text-fg-3">{bytes(root.size)}</span>
            <IconButton label="Up one level" disabled={parent == null} onClick={() => parent != null && setDir(parent)}>
              <CornerLeftUp size={14} />
            </IconButton>
          </>
        }
      >
        <div className="relative h-full p-3 pt-0">
          <Treemap root={root} onOpen={open} onHover={setHover} />
          {hover && (
            <div className="glass-float pointer-events-none absolute bottom-6 left-6 px-3 py-2 text-xs">
              <div className="font-medium text-fg">{hover.name}</div>
              <div className="tabular text-fg-3">
                {bytes(hover.size)} · {((hover.size / Math.max(1, root.size)) * 100).toFixed(1)}% of this folder
                {hover.category && ` · ${CATEGORY_LABEL[hover.category]}`}
              </div>
            </div>
          )}
        </div>
      </Panel>
      <Panel className="w-[300px] shrink-0" title="Inside this folder" pad={false}>
        <div className="scroll h-full px-2 pb-3">
          {root.children.map((c, i) => (
            <button
              key={`${c.kind}${c.id}${i}`}
              onClick={() => open(c)}
              onDoubleClick={() => c.kind === "dir" && go("explorer", { dir: c.id })}
              onMouseEnter={() => setHover(c)}
              onMouseLeave={() => setHover(null)}
              className="w-full rounded-[7px] px-2 py-1.5 text-left hover:bg-hover"
            >
              <div className="flex items-center gap-2 text-sm">
                <FileIcon category={c.kind === "dir" ? "folder" : c.category ?? "other"} size={13} />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                <span className="tabular text-xs text-fg-2">{bytes(c.size)}</span>
              </div>
              <div className="ml-5 mt-1 h-[3px] overflow-hidden rounded-full bg-active">
                <div className="h-full rounded-full" style={{ width: `${(c.size / Math.max(1, root.size)) * 100}%`, background: c.kind === "dir" ? GROUP_HUES[i % GROUP_HUES.length] : c.category ? catColor(c.category) : "var(--fg-4)" }} />
              </div>
            </button>
          ))}
        </div>
      </Panel>
    </div>
  );
}

type Rect = HierarchyRectangularNode<TreeNode>;

function Treemap({ root, onOpen, onHover }: { root: TreeNode; onOpen: (n: TreeNode) => void; onHover: (n: TreeNode | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const nodes = useMemo(() => {
    if (!size.w || !size.h) return [] as Rect[];
    const h = hierarchy<TreeNode>(root, (d) => (d.children.length ? d.children : undefined))
      .sum((d) => (d.children.length ? 0 : d.size))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    return treemap<TreeNode>().tile(treemapSquarify.ratio(1.3)).size([size.w, size.h]).paddingOuter(0).paddingInner(3).paddingTop((n) => (n.depth === 1 && n.x1 - n.x0 > 60 && n.y1 - n.y0 > 44 ? 22 : 0)).round(true)(h).descendants().slice(1) as Rect[];
  }, [root, size]);

  const groupIndex = new Map<TreeNode, number>();
  nodes.filter((n) => n.depth === 1).forEach((n, i) => groupIndex.set(n.data, i));
  const colorOf = (n: Rect) => {
    if (n.data.kind === "file" && n.data.category) return catColor(n.data.category);
    if (n.data.kind === "files" || n.data.kind === "rest") return "var(--fg-4)";
    const top = n.depth === 1 ? n : n.parent!;
    return GROUP_HUES[(groupIndex.get(top.data) ?? 0) % GROUP_HUES.length];
  };

  return (
    <div ref={ref} className="relative h-full w-full overflow-hidden rounded-[9px]">
      {nodes.map((n, i) => {
        const w = n.x1 - n.x0;
        const h = n.y1 - n.y0;
        if (w < 2 || h < 2) return null;
        const isGroup = n.depth === 1 && !!n.children;
        const color = colorOf(n);
        const label = w > 54 && h > 20;
        return (
          <div
            key={`${n.depth}-${n.data.kind}-${n.data.id}-${i}`}
            onClick={(e) => {
              e.stopPropagation();
              onOpen(n.data);
            }}
            onMouseEnter={(e) => {
              e.stopPropagation();
              onHover(n.data);
            }}
            onMouseLeave={() => onHover(null)}
            className="group absolute cursor-pointer overflow-hidden rounded-[6px] transition-[left,top,width,height,filter] duration-300 ease-out hover:brightness-125"
            style={{
              left: n.x0,
              top: n.y0,
              width: w,
              height: h,
              background: isGroup ? `color-mix(in oklab, ${color} 9%, transparent)` : `linear-gradient(160deg, color-mix(in oklab, ${color} ${n.depth === 1 ? 34 : 26}%, transparent), color-mix(in oklab, ${color} ${n.depth === 1 ? 20 : 14}%, transparent))`,
              boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} ${isGroup ? 22 : 30}%, transparent), inset 0 1px 0 rgba(255,255,255,0.06)`,
            }}
          >
            {label && (
              <div className="pointer-events-none flex items-baseline gap-1.5 px-2 pt-1 text-[11px] leading-[18px]">
                <span className={`truncate ${isGroup ? "font-semibold text-fg" : "text-fg-2"}`}>{n.data.name}</span>
                {w > 120 && <span className="tabular shrink-0 text-fg-3">{bytes(n.data.size)}</span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
