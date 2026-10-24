//! Tauri command surface. The UI only ever refers to files by scan-index id;
//! paths are rebuilt and validated here before any filesystem access.

use crate::cleanup::{self, ItemCheck, ItemKind, ItemOutcome, ItemRef, Mode};
use crate::db::{CleanupRun, Db, ScanRecord, Settings};
use crate::duplicates::{self, Candidate, DupProgress, DupResult};
use crate::model::{ext_of, flags, Category, ScanIndex};
use crate::paths;
use crate::platform::{self, DriveInfo, LastAccessInfo};
use crate::preview::{self, ArchiveListing, TextPreview};
use crate::protect::Protector;
use crate::query::{self, DirListing, DirRow, FileQuery, FileRow, Overview, QueryResult, ScanInfo, TreeNode};
use crate::recommend::{self, RecParams, Recommendation};
use crate::scan::{self, now_unix, Progress, ScanOptions};
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

pub const PERMANENT_CONFIRMATION: &str = "delete-permanently";

pub struct Shared {
    pub index: RwLock<Option<ScanIndex>>,
    pub generation: AtomicU64,
    pub recs: RwLock<(Vec<Recommendation>, Vec<u16>)>,
    pub dups: RwLock<Option<DupResult>>,
    pub downloads: RwLock<Option<u32>>,
    pub query_cache: Mutex<Option<(u64, FileQuery, Vec<u32>)>>,
    pub scanning: AtomicBool,
    pub scan_cancel: Arc<AtomicBool>,
    pub dup_running: AtomicBool,
    pub dup_cancel: Arc<AtomicBool>,
    pub cleaning: AtomicBool,
    pub db: Mutex<Db>,
    pub settings: RwLock<Settings>,
    pub protector: Protector,
    pub data_dir: PathBuf,
    /// Media metadata for the current index (file id → meta).
    pub media_meta: RwLock<std::collections::HashMap<u32, crate::shell::MediaMeta>>,
    pub media_running: AtomicBool,
    pub media_groups: Mutex<Option<(u64, Arc<crate::media::Groups>)>>,
    pub rel_cache: Mutex<Option<(u64, Arc<crate::relations::RelIndex>)>>,
    pub organize_cancel: AtomicBool,
}

pub type AppState = Arc<Shared>;

impl Shared {
    pub fn new(data_dir: PathBuf) -> Self {
        let db = Db::open(&data_dir.join("clarity.db")).or_else(|_| Db::in_memory()).expect("sqlite");
        let settings = db.settings();
        Self {
            index: RwLock::new(None),
            generation: AtomicU64::new(0),
            recs: RwLock::new((vec![], vec![])),
            dups: RwLock::new(None),
            downloads: RwLock::new(None),
            query_cache: Mutex::new(None),
            scanning: AtomicBool::new(false),
            scan_cancel: Arc::new(AtomicBool::new(false)),
            dup_running: AtomicBool::new(false),
            dup_cancel: Arc::new(AtomicBool::new(false)),
            cleaning: AtomicBool::new(false),
            db: Mutex::new(db),
            settings: RwLock::new(settings),
            protector: Protector::from_system(),
            data_dir,
            media_meta: RwLock::new(Default::default()),
            media_running: AtomicBool::new(false),
            media_groups: Mutex::new(None),
            rel_cache: Mutex::new(None),
            organize_cancel: AtomicBool::new(false),
        }
    }

    fn cache_path(&self) -> PathBuf {
        self.data_dir.join("scan-cache.bin")
    }

    pub(crate) fn refresh_pub(&self) {
        self.refresh();
    }

    /// Recompute suggestions after anything they depend on changed.
    fn refresh(&self) {
        let idx = self.index.read();
        let Some(index) = idx.as_ref() else { return };
        let downloads = dirs::download_dir().and_then(|d| index.find_dir(&d));
        *self.downloads.write() = downloads;
        let s = self.settings.read().clone();
        let params = RecParams { now: now_unix(), old_days: s.old_days.max(1), large_bytes: s.large_mb.max(1) * 1_000_000, downloads_dir: downloads };
        let dups = self.dups.read();
        *self.recs.write() = recommend::compute(index, &params, dups.as_ref());
        self.generation.fetch_add(1, Ordering::SeqCst);
        *self.query_cache.lock() = None;
    }

    /// Save a timeline snapshot of `index` (never fails the caller).
    fn snapshot(&self, index: &ScanIndex, with_volumes: bool) {
        let s = self.settings.read().clone();
        let mut excl: Vec<String> = s.exclusions.iter().map(|e| paths::normalize(Path::new(e))).collect();
        excl.sort();
        let config = format!("skip_system={};exclusions={}", s.skip_system, excl.join("|"));
        let mut volumes = std::collections::HashMap::new();
        if with_volumes {
            for &r in &index.roots {
                let name = index.dirs[r as usize].name.to_string();
                if let Some((total, free)) = platform::disk_space(Path::new(&name)) {
                    volumes.insert(name, (total, total.saturating_sub(free)));
                }
            }
        }
        let ctx = crate::timeline::RecordCtx { config, volumes };
        if let Err(e) = crate::timeline::record(self.db.lock().conn_mut(), index, &ctx, &crate::timeline::Policy::default()) {
            eprintln!("timeline snapshot failed: {e}");
        }
    }

    fn install_index(&self, index: ScanIndex) {
        *self.index.write() = Some(index);
        // File ids change with every index.
        self.media_meta.write().clear();
        *self.dups.write() = None;
        self.refresh();
    }
}

type CmdResult<T> = Result<T, String>;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> CmdResult<T> + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

const NO_SCAN: &str = "No scan loaded yet.";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    last_access: LastAccessInfo,
    downloads_path: Option<String>,
    home_path: Option<String>,
    desktop_path: Option<String>,
    documents_path: Option<String>,
    /// OneDrive sync roots (personal and business) that exist on this PC.
    onedrive_paths: Vec<String>,
    has_index: bool,
    cache_saved_at: Option<i64>,
    scanning: bool,
}

#[tauri::command]
pub async fn app_info(app: AppHandle, state: State<'_, AppState>) -> CmdResult<AppInfo> {
    let s = state.inner().clone();
    let cache_saved_at = std::fs::metadata(s.cache_path())
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64);
    let has_index = s.index.read().is_some();
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        last_access: platform::last_access_info(),
        downloads_path: dirs::download_dir().map(|p| p.display().to_string()),
        home_path: dirs::home_dir().map(|p| p.display().to_string()),
        desktop_path: dirs::desktop_dir().map(|p| p.display().to_string()),
        documents_path: dirs::document_dir().map(|p| p.display().to_string()),
        onedrive_paths: {
            let mut v: Vec<String> = ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]
                .iter()
                .filter_map(|k| std::env::var(k).ok())
                .filter(|p| Path::new(p).is_dir())
                .collect();
            v.sort_by_key(|p| p.to_lowercase());
            v.dedup_by_key(|p| p.to_lowercase());
            v
        },
        has_index,
        cache_saved_at,
        scanning: s.scanning.load(Ordering::SeqCst),
    })
}

#[tauri::command]
pub async fn get_drives() -> CmdResult<Vec<DriveInfo>> {
    blocking(|| Ok(platform::list_drives())).await
}

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> CmdResult<Settings> {
    Ok(state.settings.read().clone())
}

#[tauri::command]
pub async fn save_settings(state: State<'_, AppState>, settings: Settings) -> CmdResult<Settings> {
    let s = state.inner().clone();
    blocking(move || {
        let mut settings = settings;
        settings.old_days = settings.old_days.clamp(1, 36_500);
        settings.exclusions.retain(|e| !e.trim().is_empty());
        s.db.lock().save_settings(&settings).map_err(|e| e.to_string())?;
        *s.settings.write() = settings.clone();
        s.refresh();
        Ok(settings)
    })
    .await
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanProgressEvent {
    files: u64,
    dirs: u64,
    bytes: u64,
    errors: u64,
    current: String,
    elapsed_ms: u64,
}

#[tauri::command]
pub async fn start_scan(app: AppHandle, state: State<'_, AppState>, roots: Vec<String>) -> CmdResult<()> {
    let s = state.inner().clone();
    if roots.is_empty() {
        return Err("Choose at least one drive or folder.".into());
    }
    let roots: Vec<PathBuf> = roots.iter().map(PathBuf::from).collect();
    for r in &roots {
        if !paths::is_plain_absolute(r) || !r.is_dir() {
            return Err(format!("Not an accessible folder: {}", r.display()));
        }
    }
    if s.scanning.swap(true, Ordering::SeqCst) {
        return Err("A scan is already running.".into());
    }
    s.dup_cancel.store(true, Ordering::SeqCst);
    s.scan_cancel.store(false, Ordering::SeqCst);
    let settings = s.settings.read().clone();
    let opts = ScanOptions {
        exclusions: settings.exclusions.iter().map(|e| paths::normalize(Path::new(e))).collect(),
        skip_system: settings.skip_system,
        roots: roots.clone(),
    };
    {
        let mut st = s.settings.write();
        st.last_roots = roots.iter().map(|r| r.display().to_string()).collect();
        let _ = s.db.lock().save_settings(&st);
    }

    std::thread::spawn(move || {
        let progress = Arc::new(Progress::default());
        let done = Arc::new(AtomicBool::new(false));
        let started = Instant::now();
        {
            let (app, progress, done) = (app.clone(), progress.clone(), done.clone());
            std::thread::spawn(move || {
                while !done.load(Ordering::SeqCst) {
                    let ev = ScanProgressEvent {
                        files: progress.files.load(Ordering::Relaxed),
                        dirs: progress.dirs.load(Ordering::Relaxed),
                        bytes: progress.bytes.load(Ordering::Relaxed),
                        errors: progress.errors.load(Ordering::Relaxed),
                        current: progress.current.lock().clone(),
                        elapsed_ms: started.elapsed().as_millis() as u64,
                    };
                    let _ = app.emit("scan-progress", ev);
                    std::thread::sleep(Duration::from_millis(120));
                }
            });
        }
        let index = scan::scan(&opts, &s.scan_cancel, &progress);
        done.store(true, Ordering::SeqCst);

        let record = ScanRecord {
            id: 0,
            started_at: index.started_at,
            duration_ms: index.duration_ms as i64,
            roots: roots.iter().map(|r| r.display().to_string()).collect(),
            files: index.total_files() as i64,
            bytes: index.total_bytes() as i64,
            errors: index.error_count as i64,
            cancelled: index.cancelled,
        };
        let _ = s.db.lock().add_scan(&record);
        // Timeline: complete scans with full detail, cancelled ones as
        // totals-only points that are never used for comparisons.
        s.snapshot(&index, true);
        if !index.cancelled {
            // Watchlist: only complete scans give trustworthy sizes.
            s.watch_after_scan(&app, &index);
        }
        let cancelled = index.cancelled;
        if !cancelled {
            // Persist for the next launch; validated again before any cleanup.
            let tmp = s.cache_path().with_extension("tmp");
            if let Ok(f) = std::fs::File::create(&tmp) {
                if bincode::serialize_into(std::io::BufWriter::new(f), &index).is_ok() {
                    let _ = std::fs::rename(&tmp, s.cache_path());
                }
            }
        }
        if cancelled && s.index.read().is_some() {
            // Keep the previous complete scan rather than a partial one.
            let _ = app.emit("scan-finished", serde_json::json!({ "cancelled": true, "kept": true }));
        } else {
            s.install_index(index);
            let info = s.index.read().as_ref().map(query::scan_info);
            let _ = app.emit("scan-finished", serde_json::json!({ "cancelled": cancelled, "kept": false, "info": info }));
        }
        s.scanning.store(false, Ordering::SeqCst);
    });
    Ok(())
}

#[tauri::command]
pub async fn cancel_scan(state: State<'_, AppState>) -> CmdResult<()> {
    state.scan_cancel.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn load_cached_scan(state: State<'_, AppState>) -> CmdResult<Option<ScanInfo>> {
    let s = state.inner().clone();
    blocking(move || {
        let Ok(f) = std::fs::File::open(s.cache_path()) else { return Ok(None) };
        let mut index: ScanIndex = match bincode::deserialize_from(std::io::BufReader::new(f)) {
            Ok(i) => i,
            Err(_) => {
                let _ = std::fs::remove_file(s.cache_path());
                return Ok(None);
            }
        };
        index.cached = true;
        // Re-derive folder aggregates with the current rules (e.g. date plausibility).
        scan::aggregate(&mut index);
        // Scans made before the timeline existed get their snapshot now.
        let known = crate::timeline::has_snapshot(s.db.lock().conn(), &index.id).unwrap_or(true);
        if !known && !index.cancelled {
            s.snapshot(&index, false);
        }
        s.install_index(index);
        Ok(s.index.read().as_ref().map(query::scan_info))
    })
    .await
}

#[tauri::command]
pub async fn get_overview(state: State<'_, AppState>) -> CmdResult<Overview> {
    let s = state.inner().clone();
    blocking(move || {
        let idx = s.index.read();
        let index = idx.as_ref().ok_or(NO_SCAN)?;
        let recs = s.recs.read();
        let dups = s.dups.read();
        let old_days = s.settings.read().old_days;
        Ok(query::overview(index, &recs.0, &recs.1, dups.as_ref(), *s.downloads.read(), now_unix(), old_days))
    })
    .await
}

#[tauri::command]
pub async fn query_files(state: State<'_, AppState>, query: FileQuery) -> CmdResult<QueryResult> {
    let s = state.inner().clone();
    blocking(move || {
        let idx = s.index.read();
        let index = idx.as_ref().ok_or(NO_SCAN)?;
        let recs = s.recs.read();
        let gen = s.generation.load(Ordering::SeqCst);
        let mut cache = s.query_cache.lock();
        let key = FileQuery { offset: 0, limit: 0, ..query.clone() };
        let hit = matches!(&*cache, Some((g, q, _)) if *g == gen && *q == key);
        if !hit {
            let ids = query::run_query(index, &query, &recs.1, now_unix());
            *cache = Some((gen, key, ids));
        }
        let ids = &cache.as_ref().unwrap().2;
        let total_bytes = ids.iter().map(|&i| index.files[i as usize].size).sum();
        let limit = if query.limit == 0 { 200 } else { query.limit.min(2_000) };
        let items = ids.iter().skip(query.offset).take(limit).map(|&i| query::row(index, i, &recs.1)).collect();
        Ok(QueryResult { total: ids.len(), total_bytes, offset: query.offset, items })
    })
    .await
}

#[tauri::command]
pub async fn list_dir(state: State<'_, AppState>, dir: Option<u32>) -> CmdResult<DirListing> {
    let s = state.inner().clone();
    blocking(move || {
        let idx = s.index.read();
        let index = idx.as_ref().ok_or(NO_SCAN)?;
        if dir.is_some_and(|d| d as usize >= index.dirs.len()) {
            return Err("Unknown folder".into());
        }
        let hidden = s.settings.read().show_hidden;
        Ok(query::list_dir(index, dir, &s.recs.read().1, hidden))
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeView {
    root: TreeNode,
    crumbs: Vec<query::Crumb>,
    roots: Vec<DirRow>,
}

#[tauri::command]
pub async fn get_tree(state: State<'_, AppState>, dir: Option<u32>, depth: Option<u8>) -> CmdResult<TreeView> {
    let s = state.inner().clone();
    blocking(move || {
        let idx = s.index.read();
        let index = idx.as_ref().ok_or(NO_SCAN)?;
        let dir = dir.filter(|&d| (d as usize) < index.dirs.len()).or_else(|| index.roots.first().copied()).ok_or(NO_SCAN)?;
        Ok(TreeView {
            root: query::tree(index, dir, depth.unwrap_or(2).clamp(1, 3), 40),
            crumbs: query::crumbs(index, dir),
            roots: index.roots.iter().map(|&r| query::dir_row(index, r)).collect(),
        })
    })
    .await
}

#[tauri::command]
pub async fn get_recommendations(state: State<'_, AppState>) -> CmdResult<Vec<Recommendation>> {
    Ok(state.recs.read().0.clone())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveState {
    exists: bool,
    changed: bool,
    hard_links: Option<u32>,
    on_disk: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDetail {
    row: FileRow,
    path: String,
    preview: &'static str,
    can_open: bool,
    recommendations: Vec<Recommendation>,
    live: LiveState,
    protected: Option<String>,
    duplicate_group: Option<u32>,
}

/// Preview strategy by extension.
pub fn preview_kind(name: &str) -> &'static str {
    let ext = ext_of(name);
    match ext.as_str() {
        "pdf" => "pdf",
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "svg" | "ico" | "avif" => "image",
        "mp4" | "webm" | "mov" | "m4v" | "mkv" | "ogv" => "video",
        "mp3" | "wav" | "ogg" | "oga" | "flac" | "m4a" | "aac" | "opus" | "weba" => "audio",
        "zip" | "jar" | "tar" | "tgz" | "epub" => "archive",
        "gz" if name.to_lowercase().ends_with(".tar.gz") => "archive",
        "txt" | "md" | "markdown" | "csv" | "tsv" | "log" | "ini" | "cfg" | "conf" | "env" | "gitignore" | "bat" | "cmd" | "reg" | "srt" | "vtt" | "nfo" | "properties" | "gradle" | "dockerfile" | "makefile" => "text",
        _ if Category::from_name(name) == Category::Code => "text",
        "" => "text",
        _ => "none",
    }
}

const EXECUTABLE_EXTS: &[&str] = &[
    "exe", "com", "bat", "cmd", "msi", "msix", "msixbundle", "appx", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "scr", "pif", "lnk", "url", "hta", "cpl", "jar", "reg", "inf", "application", "appref-ms", "dll", "sys", "iso", "img", "vhd", "vhdx", "library-ms", "search-ms", "settingcontent-ms", "chm",
];

#[tauri::command]
pub async fn file_detail(state: State<'_, AppState>, id: u32) -> CmdResult<FileDetail> {
    let s = state.inner().clone();
    blocking(move || {
        let idx = s.index.read();
        let index = idx.as_ref().ok_or(NO_SCAN)?;
        let f = index.files.get(id as usize).ok_or("Unknown file")?;
        let path = index.file_path(id);
        let recs = s.recs.read();
        let md = std::fs::symlink_metadata(&path).ok();
        let changed = md.as_ref().is_some_and(|m| m.len() != f.size || platform::times_of(m).1 != f.modified);
        let cloud = f.flags & flags::CLOUD != 0;
        let live = LiveState {
            exists: md.is_some() && f.flags & flags::REMOVED == 0,
            changed,
            hard_links: if cloud || md.is_none() { None } else { platform::file_identity(&path).ok().map(|x| x.2) },
            on_disk: if md.is_some() { platform::on_disk_size(&path) } else { None },
        };
        let dups = s.dups.read();
        let duplicate_group = dups.as_ref().and_then(|d| d.groups.iter().find(|g| g.files.contains(&id)).map(|g| g.id));
        let ext = ext_of(&f.name);
        Ok(FileDetail {
            row: query::row(index, id, &recs.1),
            path: path.display().to_string(),
            preview: if cloud { "none" } else { preview_kind(&f.name) },
            can_open: !EXECUTABLE_EXTS.contains(&ext.as_str()),
            recommendations: recs
                .0
                .iter()
                .filter(|r| (r.target.kind == "file" && r.target.id == id) || (r.target.kind == "dupGroup" && Some(r.target.id) == duplicate_group))
                .cloned()
                .collect(),
            live,
            protected: s.protector.check(&path, false),
            duplicate_group,
        })
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirDetail {
    row: DirRow,
    children: Vec<DirRow>,
    category_bytes: Vec<query::CategoryStat>,
    recommendations: Vec<Recommendation>,
    protected: Option<String>,
    is_root: bool,
}

#[tauri::command]
pub async fn dir_detail(state: State<'_, AppState>, id: u32) -> CmdResult<DirDetail> {
    let s = state.inner().clone();
    blocking(move || {
        let idx = s.index.read();
        let index = idx.as_ref().ok_or(NO_SCAN)?;
        if id as usize >= index.dirs.len() {
            return Err("Unknown folder".into());
        }
        let mask = index.subtree_mask(id);
        let mut cats: Vec<query::CategoryStat> = Category::ALL.iter().map(|c| query::CategoryStat { category: c.as_str(), bytes: 0, count: 0 }).collect();
        for f in &index.files {
            if mask[f.dir as usize] && f.flags & flags::REMOVED == 0 {
                cats[f.cat as usize].bytes += f.size;
                cats[f.cat as usize].count += 1;
            }
        }
        cats.retain(|c| c.count > 0);
        cats.sort_by(|a, b| b.bytes.cmp(&a.bytes));
        let mut children: Vec<u32> = index.children(id).map(|c| c as u32).filter(|&c| index.dirs[c as usize].flags & flags::REMOVED == 0).collect();
        children.sort_by_key(|&c| std::cmp::Reverse(index.dirs[c as usize].total_size));
        children.truncate(6);
        let path = index.dir_path(id);
        Ok(DirDetail {
            row: query::dir_row(index, id),
            children: children.iter().map(|&c| query::dir_row(index, c)).collect(),
            category_bytes: cats,
            recommendations: s.recs.read().0.iter().filter(|r| r.target.kind == "dir" && r.target.id == id).cloned().collect(),
            protected: if index.is_root(id) { Some("Scanned root folder.".into()) } else { s.protector.check(&path, true) },
            is_root: index.is_root(id),
        })
    })
    .await
}

// ---------------------------------------------------------------- duplicates

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DupProgressEvent {
    stage: u8,
    done_bytes: u64,
    total_bytes: u64,
    candidates: u64,
}

#[tauri::command]
pub async fn start_duplicates(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    let s = state.inner().clone();
    if s.scanning.load(Ordering::SeqCst) {
        return Err("Wait for the scan to finish.".into());
    }
    if s.dup_running.swap(true, Ordering::SeqCst) {
        return Err("Duplicate search is already running.".into());
    }
    s.dup_cancel.store(false, Ordering::SeqCst);
    let min = s.settings.read().dup_min_kb.max(1) * 1024;
    let (cands, gen) = {
        let idx = s.index.read();
        let Some(index) = idx.as_ref() else {
            s.dup_running.store(false, Ordering::SeqCst);
            return Err(NO_SCAN.into());
        };
        let c: Vec<Candidate> = index
            .files
            .iter()
            .enumerate()
            .filter(|(_, f)| f.size >= min && f.flags & (flags::CLOUD | flags::REMOVED | flags::SYSTEM) == 0)
            .map(|(i, f)| Candidate { id: i as u32, path: index.file_path(i as u32), size: f.size })
            .collect();
        (c, index.id.clone())
    };
    std::thread::spawn(move || {
        let progress = Arc::new(DupProgress::default());
        let done = Arc::new(AtomicBool::new(false));
        {
            let (app, progress, done) = (app.clone(), progress.clone(), done.clone());
            std::thread::spawn(move || {
                while !done.load(Ordering::SeqCst) {
                    let _ = app.emit(
                        "dup-progress",
                        DupProgressEvent {
                            stage: progress.stage.load(Ordering::Relaxed),
                            done_bytes: progress.done_bytes.load(Ordering::Relaxed),
                            total_bytes: progress.total_bytes.load(Ordering::Relaxed),
                            candidates: progress.candidates.load(Ordering::Relaxed),
                        },
                    );
                    std::thread::sleep(Duration::from_millis(150));
                }
            });
        }
        let mut result = duplicates::find_duplicates(cands, &s.dup_cancel, &progress);
        done.store(true, Ordering::SeqCst);
        result.min_size = min;
        result.finished_at = now_unix();
        let same_scan = s.index.read().as_ref().is_some_and(|i| i.id == gen);
        if !result.cancelled && same_scan {
            *s.dups.write() = Some(result);
            s.refresh();
        }
        s.dup_running.store(false, Ordering::SeqCst);
        let _ = app.emit("dup-finished", serde_json::json!({ "cancelled": !same_scan || s.dup_cancel.load(Ordering::SeqCst) }));
    });
    Ok(())
}

#[tauri::command]
pub async fn cancel_duplicates(state: State<'_, AppState>) -> CmdResult<()> {
    state.dup_cancel.store(true, Ordering::SeqCst);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DupGroupView {
    id: u32,
    size: u64,
    hash: String,
    reclaimable: u64,
    files: Vec<FileRow>,
    hardlinked: Vec<FileRow>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DupView {
    running: bool,
    computed: bool,
    finished_at: i64,
    min_size: u64,
    files_considered: u64,
    hashed_bytes: u64,
    unreadable: u64,
    reclaimable: u64,
    groups: Vec<DupGroupView>,
}

#[tauri::command]
pub async fn get_duplicates(state: State<'_, AppState>) -> CmdResult<DupView> {
    let s = state.inner().clone();
    blocking(move || {
        let idx = s.index.read();
        let running = s.dup_running.load(Ordering::SeqCst);
        let dups = s.dups.read();
        let (Some(index), Some(d)) = (idx.as_ref(), dups.as_ref()) else {
            return Ok(DupView { running, computed: false, finished_at: 0, min_size: 0, files_considered: 0, hashed_bytes: 0, unreadable: 0, reclaimable: 0, groups: vec![] });
        };
        let masks = &s.recs.read().1;
        let live = |ids: &[u32]| -> Vec<FileRow> { ids.iter().filter(|&&i| index.files[i as usize].flags & flags::REMOVED == 0).map(|&i| query::row(index, i, masks)).collect() };
        let groups: Vec<DupGroupView> = d
            .groups
            .iter()
            .map(|g| {
                let files = live(&g.files);
                DupGroupView { id: g.id, size: g.size, hash: g.hash.clone(), reclaimable: g.size * (files.len().max(1) as u64 - 1), files, hardlinked: live(&g.hardlinked) }
            })
            .filter(|g| g.files.len() > 1)
            .collect();
        Ok(DupView {
            running,
            computed: true,
            finished_at: d.finished_at,
            min_size: d.min_size,
            files_considered: d.files_considered,
            hashed_bytes: d.hashed_bytes,
            unreadable: d.unreadable,
            reclaimable: groups.iter().map(|g| g.reclaimable).sum(),
            groups,
        })
    })
    .await
}

// ------------------------------------------------------------------- preview

fn live_file_path(s: &Shared, id: u32) -> CmdResult<PathBuf> {
    let idx = s.index.read();
    let index = idx.as_ref().ok_or(NO_SCAN)?;
    let f = index.files.get(id as usize).ok_or("Unknown file")?;
    if f.flags & flags::REMOVED != 0 {
        return Err("This file was removed.".into());
    }
    if f.flags & flags::CLOUD != 0 {
        return Err("Cloud-only file: previewing it would download it.".into());
    }
    let path = index.file_path(id);
    let md = std::fs::symlink_metadata(&path).map_err(|e| format!("File not accessible: {e}"))?;
    if !md.is_file() {
        return Err("Not a regular file anymore.".into());
    }
    Ok(path)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSource {
    path: String,
    kind: &'static str,
}

/// Grants the webview read access to exactly this file via the asset protocol.
#[tauri::command]
pub async fn preview_source(app: AppHandle, state: State<'_, AppState>, id: u32) -> CmdResult<PreviewSource> {
    let path = live_file_path(&state, id)?;
    let kind = preview_kind(&path.file_name().unwrap_or_default().to_string_lossy());
    if !matches!(kind, "pdf" | "image" | "video" | "audio") {
        return Err("No media preview for this type.".into());
    }
    app.asset_protocol_scope().allow_file(&path).map_err(|e| e.to_string())?;
    Ok(PreviewSource { path: path.display().to_string(), kind })
}

#[tauri::command]
pub async fn preview_text(state: State<'_, AppState>, id: u32) -> CmdResult<TextPreview> {
    let path = live_file_path(&state, id)?;
    blocking(move || preview::read_text(&path).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn preview_archive(state: State<'_, AppState>, id: u32) -> CmdResult<ArchiveListing> {
    let path = live_file_path(&state, id)?;
    blocking(move || preview::list_archive(&path)).await
}

#[tauri::command]
pub async fn open_file(app: AppHandle, state: State<'_, AppState>, id: u32) -> CmdResult<()> {
    let path = live_file_path(&state, id)?;
    let ext = ext_of(&path.file_name().unwrap_or_default().to_string_lossy());
    if EXECUTABLE_EXTS.contains(&ext.as_str()) {
        return Err("CLARITY does not run programs or scripts. Use \u{201c}Show in Explorer\u{201d} instead.".into());
    }
    app.opener().open_path(path.display().to_string(), None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn reveal(app: AppHandle, state: State<'_, AppState>, item: ItemRef) -> CmdResult<()> {
    let path = {
        let idx = state.index.read();
        let index = idx.as_ref().ok_or(NO_SCAN)?;
        match item.kind {
            ItemKind::File if (item.id as usize) < index.files.len() => index.file_path(item.id),
            ItemKind::Dir if (item.id as usize) < index.dirs.len() => index.dir_path(item.id),
            _ => return Err("Unknown item".into()),
        }
    };
    if !path.exists() {
        return Err("This item no longer exists.".into());
    }
    app.opener().reveal_item_in_dir(&path).map_err(|e| e.to_string())
}

// ------------------------------------------------------------------- cleanup

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupReview {
    checks: Vec<ItemCheck>,
    selected_bytes: u64,
    removable_bytes: u64,
    freeable_bytes: u64,
    blocked: usize,
    recycle_available: bool,
}

fn dedupe_items(index: &ScanIndex, items: Vec<ItemRef>) -> Vec<ItemRef> {
    // Drop items already covered by a selected parent folder.
    let dirs: Vec<u32> = items.iter().filter(|i| i.kind == ItemKind::Dir).map(|i| i.id).collect();
    let mut seen = std::collections::HashSet::new();
    items
        .into_iter()
        .filter(|i| seen.insert((i.kind == ItemKind::Dir, i.id)))
        .filter(|i| {
            let parent = match i.kind {
                ItemKind::File => index.files.get(i.id as usize).map(|f| f.dir),
                ItemKind::Dir => index.dirs.get(i.id as usize).map(|d| d.parent).filter(|&p| p != crate::model::NONE),
            };
            parent.is_none_or(|p| !dirs.iter().any(|&d| index.is_within(p, d)))
        })
        .collect()
}

#[tauri::command]
pub async fn review_cleanup(state: State<'_, AppState>, items: Vec<ItemRef>, mode: Mode) -> CmdResult<CleanupReview> {
    let s = state.inner().clone();
    blocking(move || {
        let idx = s.index.read();
        let index = idx.as_ref().ok_or(NO_SCAN)?;
        let items = dedupe_items(index, items);
        let checks: Vec<ItemCheck> = items.iter().map(|&i| cleanup::check_item(index, i, &s.protector, mode)).collect();
        let recycle_available = checks.iter().all(|c| c.ok || !c.blocked.as_deref().unwrap_or("").contains("Recycle Bin"));
        Ok(CleanupReview {
            selected_bytes: checks.iter().map(|c| c.size).sum(),
            removable_bytes: checks.iter().filter(|c| c.ok).map(|c| c.size).sum(),
            freeable_bytes: checks.iter().filter(|c| c.ok).map(|c| c.freeable).sum(),
            blocked: checks.iter().filter(|c| !c.ok).count(),
            recycle_available,
            checks,
        })
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupSummary {
    run_id: i64,
    mode: Mode,
    outcomes: Vec<ItemOutcome>,
    succeeded: usize,
    failed: usize,
    skipped: usize,
    bytes_removed: u64,
    bytes_freed: u64,
}

#[tauri::command]
pub async fn execute_cleanup(app: AppHandle, state: State<'_, AppState>, items: Vec<ItemRef>, mode: Mode, confirmation: Option<String>) -> CmdResult<CleanupSummary> {
    if mode == Mode::Permanent && confirmation.as_deref() != Some(PERMANENT_CONFIRMATION) {
        return Err("Permanent deletion requires an explicit second confirmation.".into());
    }
    let s = state.inner().clone();
    if s.scanning.load(Ordering::SeqCst) {
        return Err("Wait for the scan to finish.".into());
    }
    if s.cleaning.swap(true, Ordering::SeqCst) {
        return Err("A cleanup is already running.".into());
    }
    let res = blocking({
        let s = s.clone();
        move || {
            let outcomes = {
                let mut idx = s.index.write();
                let index = idx.as_mut().ok_or(NO_SCAN)?;
                let items = dedupe_items(index, items);
                let total = items.len();
                let mut outcomes = Vec::with_capacity(total);
                for (n, item) in items.into_iter().enumerate() {
                    outcomes.push(cleanup::execute_one(index, item, &s.protector, mode));
                    let _ = app.emit("cleanup-progress", serde_json::json!({ "done": n + 1, "total": total }));
                }
                outcomes
            };
            let run_id = s.db.lock().add_cleanup(now_unix(), if mode == Mode::Recycle { "recycle" } else { "permanent" }, &outcomes).unwrap_or(-1);
            s.refresh();
            let ok = |o: &&ItemOutcome| o.status == "recycled" || o.status == "deleted";
            Ok(CleanupSummary {
                run_id,
                mode,
                succeeded: outcomes.iter().filter(ok).count(),
                failed: outcomes.iter().filter(|o| o.status == "failed").count(),
                skipped: outcomes.iter().filter(|o| o.status == "skipped").count(),
                bytes_removed: outcomes.iter().filter(ok).map(|o| o.size).sum(),
                bytes_freed: outcomes.iter().map(|o| o.freed).sum(),
                outcomes,
            })
        }
    })
    .await;
    s.cleaning.store(false, Ordering::SeqCst);
    res
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    scans: Vec<ScanRecord>,
    cleanups: Vec<CleanupRun>,
}

#[tauri::command]
pub async fn get_history(state: State<'_, AppState>) -> CmdResult<History> {
    let s = state.inner().clone();
    blocking(move || {
        let db = s.db.lock();
        Ok(History { scans: db.scans(50).map_err(|e| e.to_string())?, cleanups: db.cleanups(50).map_err(|e| e.to_string())? })
    })
    .await
}

#[tauri::command]
pub async fn get_scan_issues(state: State<'_, AppState>) -> CmdResult<Vec<crate::model::ScanIssue>> {
    Ok(state.index.read().as_ref().map(|i| i.issues.clone()).unwrap_or_default())
}

// ------------------------------------------------------------------ timeline

#[tauri::command]
pub async fn timeline_roots(state: State<'_, AppState>) -> CmdResult<Vec<crate::timeline::TimelineRoot>> {
    let s = state.inner().clone();
    blocking(move || crate::timeline::roots(s.db.lock().conn()).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn timeline_series(state: State<'_, AppState>, root: i64, since: i64) -> CmdResult<Vec<crate::timeline::Point>> {
    let s = state.inner().clone();
    blocking(move || crate::timeline::series(s.db.lock().conn(), root, since).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn timeline_compare(state: State<'_, AppState>, root: i64, from: i64, to: i64) -> CmdResult<crate::timeline::Comparison> {
    let s = state.inner().clone();
    blocking(move || crate::timeline::compare(s.db.lock().conn(), root, from, to)).await
}

/// Map a path from the timeline back into the current scan, if it is there.
#[tauri::command]
pub async fn locate_path(state: State<'_, AppState>, path: String) -> CmdResult<Option<ItemRef>> {
    let s = state.inner().clone();
    blocking(move || {
        let idx = s.index.read();
        let Some(index) = idx.as_ref() else { return Ok(None) };
        let p = PathBuf::from(&path);
        if let Some(d) = index.find_dir(&p) {
            if index.dirs[d as usize].flags & flags::REMOVED == 0 {
                return Ok(Some(ItemRef { kind: ItemKind::Dir, id: d }));
            }
            return Ok(None);
        }
        let (Some(parent), Some(name)) = (p.parent(), p.file_name()) else { return Ok(None) };
        let Some(d) = index.find_dir(parent) else { return Ok(None) };
        let name = name.to_string_lossy().to_lowercase();
        Ok(index
            .files_of(d)
            .find(|&f| index.files[f].flags & flags::REMOVED == 0 && index.files[f].name.to_lowercase() == name)
            .map(|f| ItemRef { kind: ItemKind::File, id: f as u32 }))
    })
    .await
}
