import type {
  AppInfo,
  ArchiveListing,
  CleanupMode,
  CleanupReview,
  CleanupSummary,
  DirDetail,
  DirListing,
  DriveInfo,
  DupProgress,
  DupView,
  FileDetail,
  FileQuery,
  History,
  ItemRef,
  Overview,
  QueryResult,
  Recommendation,
  ScanInfo,
  ScanIssue,
  ScanProgress,
  Settings,
  TextPreview,
  TimelinePoint,
  TimelineRoot,
  Comparison,
  TreeView,
  Activity,
  ActivityQuery,
  MediaMeta,
  MediaQuery,
  MediaResult,
  MovePlan,
  MoveSummary,
  RelatedFile,
  WatchRules,
  WatchView,
  ApplyItem,
  ConflictInfo,
  OrganizeOptions,
  OrganizePlan,
  OrganizeRun,
} from "./types";

export const PERMANENT_CONFIRMATION = "delete-permanently";

export interface ScanFinished {
  cancelled: boolean;
  kept: boolean;
  info?: ScanInfo | null;
}

export interface Backend {
  readonly demo: boolean;
  appInfo(): Promise<AppInfo>;
  drives(): Promise<DriveInfo[]>;
  settings(): Promise<Settings>;
  saveSettings(s: Settings): Promise<Settings>;
  startScan(roots: string[]): Promise<void>;
  cancelScan(): Promise<void>;
  loadCachedScan(): Promise<ScanInfo | null>;
  overview(): Promise<Overview>;
  queryFiles(q: FileQuery): Promise<QueryResult>;
  listDir(dir: number | null): Promise<DirListing>;
  tree(dir: number | null, depth?: number): Promise<TreeView>;
  recommendations(): Promise<Recommendation[]>;
  fileDetail(id: number): Promise<FileDetail>;
  dirDetail(id: number): Promise<DirDetail>;
  startDuplicates(): Promise<void>;
  cancelDuplicates(): Promise<void>;
  duplicates(): Promise<DupView>;
  /** URL the webview can load for media previews. */
  previewUrl(id: number): Promise<string>;
  previewText(id: number): Promise<TextPreview>;
  previewArchive(id: number): Promise<ArchiveListing>;
  openFile(id: number): Promise<void>;
  reveal(item: ItemRef): Promise<void>;
  reviewCleanup(items: ItemRef[], mode: CleanupMode): Promise<CleanupReview>;
  executeCleanup(items: ItemRef[], mode: CleanupMode, confirmation?: string): Promise<CleanupSummary>;
  history(): Promise<History>;
  scanIssues(): Promise<ScanIssue[]>;
  pickFolder(): Promise<string | null>;
  timelineRoots(): Promise<TimelineRoot[]>;
  timelineSeries(root: number, since: number): Promise<TimelinePoint[]>;
  timelineCompare(root: number, from: number, to: number): Promise<Comparison>;
  /** Resolve a historical path against the current scan. */
  locatePath(path: string): Promise<ItemRef | null>;
  fileRelations(id: number): Promise<RelatedFile[]>;
  planMove(ids: number[], destination: string): Promise<MovePlan>;
  executeMove(ids: number[], destination: string): Promise<MoveSummary>;
  mediaQuery(q: MediaQuery): Promise<MediaResult>;
  mediaMeta(id: number): Promise<MediaMeta | null>;
  mediaIndexStart(): Promise<void>;
  /** Image URL of a thumbnail; `scanKey` busts the cache when ids change. */
  thumbUrl(id: number, size: number, scanKey: string): string;
  fileActivity(q: ActivityQuery): Promise<Activity>;
  watchList(): Promise<WatchView>;
  watchAdd(path: string, rules: WatchRules): Promise<number>;
  watchUpdate(id: number, rules: WatchRules): Promise<void>;
  watchPause(id: number, paused: boolean): Promise<void>;
  watchRemove(id: number): Promise<void>;
  watchMarkSeen(ids: number[]): Promise<void>;
  onMediaProgress(cb: (p: { done: number; total: number }) => void): Promise<() => void>;
  onMediaFinished(cb: () => void): Promise<() => void>;
  onWatchAlerts(cb: (n: number) => void): Promise<() => void>;
  organizeAnalyze(root: string, options: OrganizeOptions): Promise<OrganizePlan>;
  organizeConflicts(root: string, files: { id: number; name: string; dest: string }[]): Promise<ConflictInfo[]>;
  organizeApply(root: string, mode: string, items: ApplyItem[]): Promise<void>;
  organizeCancel(): Promise<void>;
  organizeRuns(): Promise<OrganizeRun[]>;
  organizeUndo(runId: number): Promise<OrganizeRun>;
  onOrganizeProgress(cb: (p: { done: number; total: number; current: string }) => void): Promise<() => void>;
  onOrganizeFinished(cb: (r: { ok?: OrganizeRun; error?: string }) => void): Promise<() => void>;
  onScanProgress(cb: (p: ScanProgress) => void): Promise<() => void>;
  onScanFinished(cb: (f: ScanFinished) => void): Promise<() => void>;
  onDupProgress(cb: (p: DupProgress) => void): Promise<() => void>;
  onDupFinished(cb: (f: { cancelled: boolean }) => void): Promise<() => void>;
  window: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    startDragging(): void;
  };
}

export const isNative = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function tauriBackend(): Promise<Backend> {
  const { invoke, convertFileSrc } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const { open } = await import("@tauri-apps/plugin-dialog");
  const win = getCurrentWindow();
  const on = <T,>(name: string, cb: (p: T) => void) => listen<T>(name, (e) => cb(e.payload));

  return {
    demo: false,
    appInfo: () => invoke("app_info"),
    drives: () => invoke("get_drives"),
    settings: () => invoke("get_settings"),
    saveSettings: (settings) => invoke("save_settings", { settings }),
    startScan: (roots) => invoke("start_scan", { roots }),
    cancelScan: () => invoke("cancel_scan"),
    loadCachedScan: () => invoke("load_cached_scan"),
    overview: () => invoke("get_overview"),
    queryFiles: (query) => invoke("query_files", { query }),
    listDir: (dir) => invoke("list_dir", { dir }),
    tree: (dir, depth) => invoke("get_tree", { dir, depth }),
    recommendations: () => invoke("get_recommendations"),
    fileDetail: (id) => invoke("file_detail", { id }),
    dirDetail: (id) => invoke("dir_detail", { id }),
    startDuplicates: () => invoke("start_duplicates"),
    cancelDuplicates: () => invoke("cancel_duplicates"),
    duplicates: () => invoke("get_duplicates"),
    previewUrl: async (id) => {
      const src = await invoke<{ path: string }>("preview_source", { id });
      return convertFileSrc(src.path);
    },
    previewText: (id) => invoke("preview_text", { id }),
    previewArchive: (id) => invoke("preview_archive", { id }),
    openFile: (id) => invoke("open_file", { id }),
    reveal: (item) => invoke("reveal", { item }),
    reviewCleanup: (items, mode) => invoke("review_cleanup", { items, mode }),
    executeCleanup: (items, mode, confirmation) => invoke("execute_cleanup", { items, mode, confirmation: confirmation ?? null }),
    history: () => invoke("get_history"),
    scanIssues: () => invoke("get_scan_issues"),
    pickFolder: async () => {
      const r = await open({ directory: true, multiple: false, title: "Choose a folder to analyse" });
      return typeof r === "string" ? r : null;
    },
    timelineRoots: () => invoke("timeline_roots"),
    timelineSeries: (root, since) => invoke("timeline_series", { root, since }),
    timelineCompare: (root, from, to) => invoke("timeline_compare", { root, from, to }),
    locatePath: (path) => invoke("locate_path", { path }),
    fileRelations: (id) => invoke("file_relations", { id }),
    planMove: (ids, destination) => invoke("plan_move", { ids, destination }),
    executeMove: (ids, destination) => invoke("execute_move", { ids, destination, confirmed: true }),
    mediaQuery: (query) => invoke("media_query", { query }),
    mediaMeta: (id) => invoke("media_meta", { id }),
    mediaIndexStart: () => invoke("media_index_start"),
    thumbUrl: (id, size, scanKey) => `http://thumb.localhost/${id}?s=${size}&v=${encodeURIComponent(scanKey)}`,
    fileActivity: (query) => invoke("file_activity", { query }),
    watchList: () => invoke("watch_list"),
    watchAdd: (path, rules) => invoke("watch_add", { path, rules }),
    watchUpdate: (id, rules) => invoke("watch_update", { id, rules }),
    watchPause: (id, paused) => invoke("watch_pause", { id, paused }),
    watchRemove: (id) => invoke("watch_remove", { id }),
    watchMarkSeen: (ids) => invoke("watch_mark_seen", { ids }),
    onMediaProgress: (cb) => on("media-progress", cb),
    onMediaFinished: (cb) => on("media-finished", () => cb()),
    onWatchAlerts: (cb) => on("watch-alerts", cb),
    organizeAnalyze: (root, options) => invoke("organize_analyze", { root, options }),
    organizeConflicts: (root, files) => invoke("organize_conflicts", { root, files }),
    organizeApply: (root, mode, items) => invoke("organize_apply", { root, mode, items, confirmed: true }),
    organizeCancel: () => invoke("organize_cancel"),
    organizeRuns: () => invoke("organize_runs"),
    organizeUndo: (runId) => invoke("organize_undo", { runId }),
    onOrganizeProgress: (cb) => on("organize-progress", cb),
    onOrganizeFinished: (cb) => on("organize-finished", cb),
    onScanProgress: (cb) => on("scan-progress", cb),
    onScanFinished: (cb) => on("scan-finished", cb),
    onDupProgress: (cb) => on("dup-progress", cb),
    onDupFinished: (cb) => on("dup-finished", cb),
    window: {
      minimize: () => void win.minimize(),
      toggleMaximize: () => void win.toggleMaximize(),
      close: () => void win.close(),
      startDragging: () => void win.startDragging(),
    },
  };
}

let backend: Backend;

export async function initBackend(): Promise<Backend> {
  if (backend) return backend;
  if (isNative) {
    backend = await tauriBackend();
    document.documentElement.classList.add("native");
  } else {
    const { createDemoBackend } = await import("./demo");
    backend = createDemoBackend();
  }
  return backend;
}

export function api(): Backend {
  return backend;
}

/** Tauri rejects with plain strings; normalise for display. */
export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
