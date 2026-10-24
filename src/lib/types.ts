// Mirrors the serde types in src-tauri/src. Keep in sync.

export type Category =
  | "documents"
  | "images"
  | "video"
  | "audio"
  | "archives"
  | "installers"
  | "code"
  | "apps"
  | "system"
  | "other";

export type DriveKind = "fixed" | "removable" | "network" | "optical" | "ram" | "unknown";

export interface DriveInfo {
  mount: string;
  label: string;
  fileSystem: string;
  kind: DriveKind;
  total: number;
  free: number;
}

export interface LastAccessInfo {
  enabled: boolean | null;
  systemManaged: boolean;
  explanation: string;
}

export interface AppInfo {
  version: string;
  lastAccess: LastAccessInfo;
  downloadsPath: string | null;
  homePath: string | null;
  desktopPath?: string | null;
  documentsPath?: string | null;
  onedrivePaths: string[];
  hasIndex: boolean;
  cacheSavedAt: number | null;
  scanning: boolean;
}

export interface Settings {
  theme: "system" | "dark" | "light";
  motion: "system" | "reduced" | "full";
  oldDays: number;
  largeMb: number;
  dupMinKb: number;
  skipSystem: boolean;
  exclusions: string[];
  onboarded: boolean;
  lastRoots: string[];
  showHidden: boolean;
  rev?: number;
}

export interface ScanProgress {
  files: number;
  dirs: number;
  bytes: number;
  errors: number;
  current: string;
  elapsedMs: number;
}

export interface RootInfo {
  id: number;
  path: string;
  size: number;
  files: number;
  volumeTotal: number | null;
  volumeFree: number | null;
}

export interface ScanInfo {
  id: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  roots: RootInfo[];
  files: number;
  dirs: number;
  bytes: number;
  errors: number;
  linksSkipped: number;
  excluded: number;
  cancelled: boolean;
  cached: boolean;
}

export interface FileRow {
  id: number;
  name: string;
  dir: string;
  dirId: number;
  ext: string;
  size: number;
  created: number;
  modified: number;
  accessed: number;
  category: Category;
  cloud: boolean;
  hidden: boolean;
  readonly: boolean;
  system: boolean;
  recs: number;
}

export interface DirRow {
  id: number;
  name: string;
  path: string;
  size: number;
  ownSize: number;
  files: number;
  subdirs: number;
  latestModified: number;
  unreadable: boolean;
}

export interface CategoryStat {
  category: Category;
  bytes: number;
  count: number;
}

export interface Insight {
  text: string;
  detail: string;
  target: string;
}

export interface DownloadsInfo {
  dirId: number;
  path: string;
  bytes: number;
  files: number;
  oldBytes: number;
}

export interface Overview {
  scan: ScanInfo;
  categories: CategoryStat[];
  largestFiles: FileRow[];
  topFolders: DirRow[];
  hotspots: DirRow[];
  cloudBytes: number;
  oldBytes1y: number;
  oldBytes2y: number;
  oldCount1y: number;
  recCount: number;
  recBytes: number;
  downloads: DownloadsInfo | null;
  duplicates: [number, number] | null;
  insights: Insight[];
}

export type SortKey = "size" | "name" | "modified" | "created" | "accessed" | "type" | "path" | "reason";
export type DateField = "modified" | "created" | "accessed";

export interface FileQuery {
  search?: string;
  categories?: Category[];
  minSize?: number | null;
  dateField?: DateField;
  olderThanDays?: number | null;
  from?: number | null;
  to?: number | null;
  underDir?: number | null;
  recMask?: number;
  includeHidden?: boolean;
  includeCloud?: boolean;
  sort?: SortKey;
  desc?: boolean;
  offset?: number;
  limit?: number;
}

export interface QueryResult {
  total: number;
  totalBytes: number;
  offset: number;
  items: FileRow[];
}

export interface Crumb {
  id: number;
  name: string;
}

export interface DirListing {
  dir: DirRow | null;
  crumbs: Crumb[];
  dirs: DirRow[];
  files: FileRow[];
  fileTotal: number;
}

export interface TreeNode {
  id: number;
  kind: "dir" | "file" | "files" | "rest";
  name: string;
  size: number;
  category: Category | null;
  children: TreeNode[];
}

export interface TreeView {
  root: TreeNode;
  crumbs: Crumb[];
  roots: DirRow[];
}

export type RecKind =
  | "largeOld"
  | "oldInstaller"
  | "oldDownload"
  | "archiveReview"
  | "largeVideo"
  | "duplicate"
  | "buildArtifacts"
  | "staleProject"
  | "tempFolder";

/** Bit order must match RecKind in recommend.rs. */
export const REC_BITS: RecKind[] = [
  "largeOld",
  "oldInstaller",
  "oldDownload",
  "archiveReview",
  "largeVideo",
  "duplicate",
  "buildArtifacts",
  "staleProject",
  "tempFolder",
];

export type Risk = "low" | "medium" | "high";

export interface Recommendation {
  kind: RecKind;
  target: { kind: "file" | "dir" | "dupGroup"; id: number };
  name: string;
  path: string;
  size: number;
  category: Category | "folder";
  title: string;
  reason: string;
  risk: Risk;
  riskNote: string;
  action: string;
  modified: number;
}

export type PreviewKind = "pdf" | "image" | "video" | "audio" | "archive" | "text" | "none";

export interface FileDetail {
  row: FileRow;
  path: string;
  preview: PreviewKind;
  canOpen: boolean;
  recommendations: Recommendation[];
  live: { exists: boolean; changed: boolean; hardLinks: number | null; onDisk: number | null };
  protected: string | null;
  duplicateGroup: number | null;
}

export interface DirDetail {
  row: DirRow;
  children: DirRow[];
  categoryBytes: CategoryStat[];
  recommendations: Recommendation[];
  protected: string | null;
  isRoot: boolean;
}

export interface DupProgress {
  stage: number;
  doneBytes: number;
  totalBytes: number;
  candidates: number;
}

export interface DupGroupView {
  id: number;
  size: number;
  hash: string;
  reclaimable: number;
  files: FileRow[];
  hardlinked: FileRow[];
}

export interface DupView {
  running: boolean;
  computed: boolean;
  finishedAt: number;
  minSize: number;
  filesConsidered: number;
  hashedBytes: number;
  unreadable: number;
  reclaimable: number;
  groups: DupGroupView[];
}

export interface TextPreview {
  text: string;
  truncated: boolean;
  binary: boolean;
  encoding: string;
  totalBytes: number;
}

export interface ArchiveEntry {
  name: string;
  isDir: boolean;
  size: number;
  compressed: number | null;
  encrypted: boolean;
}

export interface ArchiveListing {
  format: string;
  entries: ArchiveEntry[];
  totalEntries: number;
  truncated: boolean;
  uncompressedTotal: number;
  compressedTotal: number | null;
  supported: boolean;
  note: string | null;
}

export type ItemKind = "file" | "dir";
export interface ItemRef {
  kind: ItemKind;
  id: number;
}

export type CleanupMode = "recycle" | "permanent";

export interface ItemCheck {
  item: ItemRef;
  path: string;
  name: string;
  size: number;
  freeable: number;
  ok: boolean;
  blocked: string | null;
  warnings: string[];
}

export interface CleanupReview {
  checks: ItemCheck[];
  selectedBytes: number;
  removableBytes: number;
  freeableBytes: number;
  blocked: number;
  recycleAvailable: boolean;
}

export interface ItemOutcome {
  item: ItemRef;
  path: string;
  size: number;
  freed: number;
  status: "recycled" | "deleted" | "skipped" | "failed";
  error: string | null;
}

export interface CleanupSummary {
  runId: number;
  mode: CleanupMode;
  outcomes: ItemOutcome[];
  succeeded: number;
  failed: number;
  skipped: number;
  bytesRemoved: number;
  bytesFreed: number;
}

export interface ScanRecord {
  id: number;
  startedAt: number;
  durationMs: number;
  roots: string[];
  files: number;
  bytes: number;
  errors: number;
  cancelled: boolean;
}

export interface CleanupRun {
  id: number;
  at: number;
  mode: string;
  requested: number;
  succeeded: number;
  failed: number;
  skipped: number;
  bytesRemoved: number;
  bytesFreed: number;
  items: { path: string; size: number; status: string; error: string | null }[];
}

export interface History {
  scans: ScanRecord[];
  cleanups: CleanupRun[];
}

export interface ScanIssue {
  path: string;
  message: string;
}

// ------------------------------------------------------------- timeline

export interface TimelineRoot {
  id: number;
  path: string;
  snapshots: number;
  firstAt: number;
  lastAt: number;
  available: boolean;
}

export interface TimelinePoint {
  snapshotId: number;
  takenAt: number;
  bytes: number;
  files: number;
  volumeTotal: number | null;
  volumeUsed: number | null;
  complete: boolean;
  legacy: boolean;
  hasDirs: boolean;
  hasFiles: boolean;
  errors: number;
  categories: Partial<Record<Category, number>>;
}

export interface Delta {
  path: string;
  name: string;
  before: number;
  after: number;
  delta: number;
  status: "added" | "removed" | "changed";
  category: Category | null;
}

export interface CatDelta {
  category: Category;
  before: number;
  after: number;
  delta: number;
}

export interface Highlight {
  text: string;
  detail: string;
  delta: number;
  path: string | null;
  kind: "dir" | "file" | "category" | "total";
  category: Category | null;
}

export interface FileChanges {
  items: Delta[];
  count: number;
  bytes: number;
}

export interface Comparison {
  root: string;
  from: TimelinePoint;
  to: TimelinePoint;
  delta: number;
  filesDelta: number;
  volumeUsedDelta: number | null;
  categories: CatDelta[];
  grew: Delta[];
  shrank: Delta[];
  added: FileChanges;
  deleted: FileChanges;
  modified: FileChanges;
  highlights: Highlight[];
  warnings: string[];
  hasFolderDetail: boolean;
  hasFileDetail: boolean;
  fileMin: number;
  dirMin: number;
}

// ---------------------------------------------------------------- media

export interface MediaMeta {
  width: number | null;
  height: number | null;
  durationMs: number | null;
  frameRate: number | null;
  bitrate: number | null;
  taken: number | null;
  camera: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
}

export type MediaKind = "all" | "images" | "video" | "audio";
export type MediaSort = "date" | "taken" | "size" | "name" | "resolution" | "duration";

export interface MediaQuery {
  kind?: MediaKind;
  search?: string;
  underDir?: number | null;
  sort?: MediaSort;
  desc?: boolean;
  orientation?: "" | "landscape" | "portrait" | "square";
  minPixels?: number | null;
  minDurationMs?: number | null;
  maxDurationMs?: number | null;
  formats?: string[];
  group?: boolean;
  offset?: number;
  limit?: number;
}

export interface GroupedFile {
  id: number;
  name: string;
  ext: string;
  size: number;
}

export interface MediaItem {
  row: FileRow;
  meta: MediaMeta | null;
  grouped: GroupedFile[];
}

export interface MediaResult {
  total: number;
  totalBytes: number;
  items: MediaItem[];
  formats: [string, number][];
  counts: Partial<Record<"images" | "video" | "audio", number>>;
  mediaTotal: number;
  metaKnown: number;
}

// --------------------------------------------------------- relationships

export type Confidence = "confident" | "likely" | "possible";

export interface RelatedFile {
  id: number;
  kind: string;
  label: string;
  confidence: Confidence;
  reason: string;
  row: FileRow;
  path: string;
}

export interface MoveStep {
  id: number;
  name: string;
  from: string;
  to: string;
  size: number;
  ok: boolean;
  blocked: string | null;
}

export interface MovePlan {
  destination: string;
  steps: MoveStep[];
  movable: number;
  bytes: number;
  crossDrive: boolean;
  error: string | null;
}

export interface MoveOutcome {
  id: number;
  from: string;
  to: string;
  size: number;
  status: "moved" | "skipped" | "failed";
  error: string | null;
}

export interface MoveSummary {
  outcomes: MoveOutcome[];
  moved: number;
  bytes: number;
}

// -------------------------------------------------------------- activity

export interface ActivityQuery {
  field: "created" | "modified";
  underDir?: number | null;
  categories?: Category[];
  fromDay: number;
  toDay: number;
  tzOffsetMin: number;
}

export interface ActivityDay {
  day: number;
  files: number;
  bytes: number;
}

export interface ObservedEvent {
  day: number;
  at: number;
  kind: "scan" | "cleanup";
  label: string;
}

export interface Activity {
  days: ActivityDay[];
  totalFiles: number;
  totalBytes: number;
  undated: number;
  firstDay: number | null;
  lastDay: number | null;
  observed: ObservedEvent[];
}

// ------------------------------------------------------------- watchlist

export interface WatchRules {
  label?: string;
  limitBytes?: number | null;
  growthBytes?: number | null;
  growthPct?: number | null;
  notify?: boolean;
}

export interface WatchHistoryPoint {
  at: number;
  bytes: number;
  source: "scan" | "timeline";
}

export interface WatchEntry {
  id: number;
  path: string;
  label: string;
  limitBytes: number | null;
  growthBytes: number | null;
  growthPct: number | null;
  notify: boolean;
  paused: boolean;
  createdAt: number;
  available: boolean;
  history: WatchHistoryPoint[];
  unseenAlerts: number;
}

export interface WatchAlert {
  id: number;
  watchId: number;
  label: string;
  path: string;
  at: number;
  kind: "limit" | "growth" | "missing";
  message: string;
  bytes: number | null;
  prevBytes: number | null;
  seen: boolean;
  notify: boolean;
}

export interface WatchView {
  entries: WatchEntry[];
  alerts: WatchAlert[];
  current: Record<number, number>;
}

// ------------------------------------------------------------- organizer

export type OrganizeMode = "smart" | "type" | "date" | "custom";

export interface OrganizeRule {
  field: "ext" | "name" | "category" | "olderThanDays" | "largerThanMb";
  value: string;
  dest: string;
}

export interface OrganizeOptions {
  mode: OrganizeMode;
  minGroup: number;
  keepRelated: boolean;
  rules: OrganizeRule[];
  fallback: "stay" | "smart";
}

export interface PlanFile {
  id: number;
  name: string;
  size: number;
  modified: number;
  created: number;
  category: Category;
  dest: string;
  reason: string;
  group: number | null;
  conflict: string | null;
}

export interface PlanFolder {
  path: string;
  files: number;
  bytes: number;
  exists: boolean;
}

export interface OrganizePlan {
  root: string;
  mode: OrganizeMode;
  files: PlanFile[];
  folders: PlanFolder[];
  skipped: { name: string; reason: string }[];
  existingSubfolders: string[];
  moving: number;
  staying: number;
  conflicts: number;
}

export interface ConflictInfo {
  id: number;
  conflict: string | null;
  suggestion: string | null;
}

export interface ApplyItem {
  name: string;
  dest: string;
  renameTo: string | null;
  size: number;
  modified: number;
}

export interface OrganizeItemResult {
  name: string;
  from: string;
  to: string;
  size: number;
  status: "moved" | "skipped" | "failed" | "restored" | "kept";
  error: string | null;
}

export interface OrganizeRun {
  runId: number;
  root: string;
  mode: string;
  at: number;
  moved: number;
  skipped: number;
  failed: number;
  bytes: number;
  cancelled: boolean;
  foldersCreated: number;
  items: OrganizeItemResult[];
  undoneAt: number | null;
  restored: number;
  kept: number;
  canUndo: boolean;
}
