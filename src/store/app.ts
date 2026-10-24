import { create } from "zustand";
import type { AppInfo, Category, DriveInfo, DupProgress, ItemKind, RelatedFile, ScanInfo, ScanProgress, Settings, WatchEntry } from "../lib/types";

export type View =
  | "overview"
  | "media"
  | "organize"
  | "suggestions"
  | "analysis"
  | "old"
  | "large"
  | "duplicates"
  | "downloads"
  | "explorer"
  | "history"
  | "settings";

export interface SelItem {
  kind: ItemKind;
  id: number;
  name: string;
  path: string;
  size: number;
}

export interface InspectTarget {
  kind: ItemKind;
  id: number;
}

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "ok" | "error";
}

/** Preset filters passed when navigating from a chart or insight. */
export interface NavIntent {
  categories?: Category[];
  dir?: number;
  tab?: AnalysisTab;
}

export type AnalysisTab = "map" | "timeline" | "activity" | "watchlist";

/** "Move together" request: a file plus its related files. */
export interface MoveRequest {
  primary: { id: number; name: string; path: string; size: number };
  related: RelatedFile[];
}

/** Watchlist editor: a path to add, or an existing entry to edit. */
export interface WatchEdit {
  path: string;
  entry?: WatchEntry;
}

interface AppState {
  ready: boolean;
  info: AppInfo | null;
  settings: Settings | null;
  drives: DriveInfo[];
  scan: ScanInfo | null;
  scanning: boolean;
  progress: ScanProgress | null;
  scanRoots: string[];
  dupRunning: boolean;
  dupProgress: DupProgress | null;
  /** Bumped whenever scan data changes; views refetch on change. */
  version: number;

  view: View;
  intent: NavIntent | null;
  inspector: InspectTarget | null;
  inspectorOpen: boolean;
  quickLook: number | null;
  selection: Map<string, SelItem>;
  reviewOpen: boolean;
  shortcutsOpen: boolean;
  showScanSetup: boolean;
  toasts: Toast[];
  navCounts: Partial<Record<View, number>> | null;
  analysisTab: AnalysisTab;
  /** Day range (local day numbers) the activity heatmap should focus on. */
  activityFocus: { fromDay: number; toDay: number } | null;
  moveRequest: MoveRequest | null;
  watchEdit: WatchEdit | null;
  mediaIndex: { done: number; total: number; running: boolean } | null;
  /** Folder open in the organizer, and the view to return to. */
  organize: { root: string | null; back: View } | null;

  set: (p: Partial<AppState>) => void;
  go: (view: View, intent?: NavIntent) => void;
  inspect: (t: InspectTarget | null) => void;
  toggleSelect: (item: SelItem) => void;
  select: (items: SelItem[], on: boolean) => void;
  clearSelection: () => void;
  bump: () => void;
  toast: (text: string, tone?: Toast["tone"]) => void;
}

export const selKey = (kind: ItemKind, id: number) => `${kind}:${id}`;

let toastId = 0;

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  info: null,
  settings: null,
  drives: [],
  scan: null,
  scanning: false,
  progress: null,
  scanRoots: [],
  dupRunning: false,
  dupProgress: null,
  version: 0,

  view: "overview",
  intent: null,
  inspector: null,
  inspectorOpen: true,
  quickLook: null,
  selection: new Map(),
  reviewOpen: false,
  shortcutsOpen: false,
  showScanSetup: false,
  toasts: [],
  navCounts: null,
  analysisTab: "map",
  activityFocus: null,
  moveRequest: null,
  watchEdit: null,
  mediaIndex: null,
  organize: null,

  set: (p) => set(p),
  go: (view, intent) => {
    // Guard against unknown targets (e.g. from backend insights): never blank the UI.
    const known: View[] = ["overview", "media", "organize", "suggestions", "analysis", "old", "large", "duplicates", "downloads", "explorer", "history", "settings"];
    set({ view: known.includes(view) ? view : "suggestions", intent: intent ?? null, showScanSetup: false, ...(intent?.tab ? { analysisTab: intent.tab } : {}) });
  },
  inspect: (t) => set({ inspector: t, inspectorOpen: t ? true : get().inspectorOpen }),
  toggleSelect: (item) => {
    const m = new Map(get().selection);
    const k = selKey(item.kind, item.id);
    if (m.has(k)) m.delete(k);
    else m.set(k, item);
    set({ selection: m });
  },
  select: (items, on) => {
    const m = new Map(get().selection);
    for (const it of items) {
      const k = selKey(it.kind, it.id);
      if (on) m.set(k, it);
      else m.delete(k);
    }
    set({ selection: m });
  },
  clearSelection: () => set({ selection: new Map() }),
  bump: () => set({ version: get().version + 1 }),
  toast: (text, tone = "info") => {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, text, tone }] });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), tone === "error" ? 6000 : 3800);
  },
}));
