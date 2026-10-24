//! Commands for Media Explorer, file relationships, organizing, the
//! activity heatmap and the storage watchlist, plus the `thumb://` protocol.

use crate::activity::{self, Activity, ActivityQuery, Observed};
use crate::cleanup::{ItemKind, ItemOutcome, ItemRef};
use crate::commands::{AppState, Shared};
use crate::media::{self, MediaQuery, MediaResult};
use crate::model::flags;
use crate::organize::{self, MovePlan, MoveOutcome};
use crate::paths;
use crate::query::{self, FileRow};
use crate::relations::{self, Relation};
use crate::scan::now_unix;
use crate::shell::{self, MediaMeta};
use crate::watch::{self, Alert, WatchEntry, WatchRules};
use rusqlite::params;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter, Manager, State};

type CmdResult<T> = Result<T, String>;
const NO_SCAN: &str = "No scan loaded yet.";

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> CmdResult<T> + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Small pool for shell work (thumbnails, metadata): COM is initialised
/// once per thread, and the disk is not flooded with parallel reads.
fn shell_pool() -> &'static rayon::ThreadPool {
    static POOL: OnceLock<rayon::ThreadPool> = OnceLock::new();
    POOL.get_or_init(|| rayon::ThreadPoolBuilder::new().num_threads(4).thread_name(|i| format!("clarity-shell-{i}")).build().expect("shell pool"))
}

impl Shared {
    pub(crate) fn groups(&self) -> Option<Arc<media::Groups>> {
        let gen = self.generation.load(Ordering::SeqCst);
        if let Some((g, groups)) = &*self.media_groups.lock() {
            if *g == gen {
                return Some(groups.clone());
            }
        }
        let idx = self.index.read();
        let groups = Arc::new(media::build_groups(idx.as_ref()?));
        *self.media_groups.lock() = Some((gen, groups.clone()));
        Some(groups)
    }

    pub(crate) fn rel_index(&self) -> Option<Arc<relations::RelIndex>> {
        let gen = self.generation.load(Ordering::SeqCst);
        if let Some((g, r)) = &*self.rel_cache.lock() {
            if *g == gen {
                return Some(r.clone());
            }
        }
        let idx = self.index.read();
        let dups = self.dups.read();
        let r = Arc::new(relations::RelIndex::build(idx.as_ref()?, dups.as_ref()));
        *self.rel_cache.lock() = Some((gen, r.clone()));
        Some(r)
    }

    /// Record watched sizes after a scan and raise alerts (+ notifications).
    pub(crate) fn watch_after_scan(&self, app: &AppHandle, index: &crate::model::ScanIndex) {
        let at = if index.finished_at > 0 { index.finished_at } else { now_unix() };
        let alerts = match watch::evaluate(self.db.lock().conn(), index, at) {
            Ok(a) => a,
            Err(e) => {
                eprintln!("watchlist evaluation failed: {e}");
                return;
            }
        };
        if alerts.is_empty() {
            return;
        }
        let _ = app.emit("watch-alerts", alerts.len());
        use tauri_plugin_notification::NotificationExt;
        for a in alerts.iter().filter(|a| a.notify) {
            let _ = app.notification().builder().title(format!("CLARITY · {}", a.label)).body(&a.message).show();
        }
    }
}

// ------------------------------------------------------------ relations

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelatedFile {
    #[serde(flatten)]
    pub relation: Relation,
    pub row: FileRow,
    pub path: String,
}

#[tauri::command]
pub async fn file_relations(state: State<'_, AppState>, id: u32) -> CmdResult<Vec<RelatedFile>> {
    let s = state.inner().clone();
    blocking(move || {
        let rel = s.rel_index().ok_or(NO_SCAN)?;
        let idx = s.index.read();
        let index = idx.as_ref().ok_or(NO_SCAN)?;
        if id as usize >= index.files.len() {
            return Err("Unknown file".into());
        }
        let masks = &s.recs.read().1;
        Ok(relations::related(index, &rel, id)
            .into_iter()
            .map(|r| RelatedFile { row: query::row(index, r.id, masks), path: index.file_path(r.id).display().to_string(), relation: r })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn plan_move(state: State<'_, AppState>, ids: Vec<u32>, destination: String) -> CmdResult<MovePlan> {
    let s = state.inner().clone();
    blocking(move || {
        let idx = s.index.read();
        let index = idx.as_ref().ok_or(NO_SCAN)?;
        if ids.iter().any(|&i| i as usize >= index.files.len()) {
            return Err("Unknown file".into());
        }
        Ok(organize::plan(index, &ids, Path::new(&destination), &s.protector))
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveSummary {
    outcomes: Vec<MoveOutcome>,
    moved: usize,
    bytes: u64,
}

#[tauri::command]
pub async fn execute_move(state: State<'_, AppState>, ids: Vec<u32>, destination: String, confirmed: bool) -> CmdResult<MoveSummary> {
    if !confirmed {
        return Err("Moving files needs your confirmation.".into());
    }
    let s = state.inner().clone();
    if s.scanning.load(Ordering::SeqCst) || s.cleaning.swap(true, Ordering::SeqCst) {
        return Err("Wait for the running scan or cleanup to finish.".into());
    }
    let res = blocking({
        let s = s.clone();
        move || {
            let outcomes = {
                let mut idx = s.index.write();
                let index = idx.as_mut().ok_or(NO_SCAN)?;
                if ids.iter().any(|&i| i as usize >= index.files.len()) {
                    return Err("Unknown file".to_string());
                }
                organize::execute(index, &ids, Path::new(&destination), &s.protector)?
            };
            // Recorded in the cleanup history as a "move" run.
            let hist: Vec<ItemOutcome> = outcomes
                .iter()
                .map(|o| ItemOutcome { item: ItemRef { kind: ItemKind::File, id: o.id }, path: format!("{} → {}", o.from, o.to), size: o.size, freed: 0, status: o.status, error: o.error.clone() })
                .collect();
            let _ = s.db.lock().add_cleanup(now_unix(), "move", &hist);
            s.refresh_pub();
            let moved: Vec<&MoveOutcome> = outcomes.iter().filter(|o| o.status == "moved").collect();
            Ok(MoveSummary { moved: moved.len(), bytes: moved.iter().map(|o| o.size).sum(), outcomes })
        }
    })
    .await;
    s.cleaning.store(false, Ordering::SeqCst);
    res
}

// ----------------------------------------------------------------- media

#[tauri::command]
pub async fn media_query(state: State<'_, AppState>, query: MediaQuery) -> CmdResult<MediaResult> {
    let s = state.inner().clone();
    blocking(move || {
        let groups = s.groups().ok_or(NO_SCAN)?;
        let idx = s.index.read();
        let index = idx.as_ref().ok_or(NO_SCAN)?;
        let meta = s.media_meta.read();
        Ok(media::run(index, &query, &meta, &groups, &s.recs.read().1))
    })
    .await
}

/// Metadata for one file (inspector), from cache or the shell.
#[tauri::command]
pub async fn media_meta(state: State<'_, AppState>, id: u32) -> CmdResult<Option<MediaMeta>> {
    let s = state.inner().clone();
    if let Some(m) = s.media_meta.read().get(&id) {
        return Ok(Some(m.clone()));
    }
    let path = {
        let idx = s.index.read();
        let index = idx.as_ref().ok_or(NO_SCAN)?;
        let f = index.files.get(id as usize).ok_or("Unknown file")?;
        if !media::is_media(f.cat) || f.flags & (flags::CLOUD | flags::REMOVED) != 0 {
            return Ok(None);
        }
        index.file_path(id)
    };
    let (tx, rx) = tokio_oneshot();
    shell_pool().spawn(move || {
        let _ = tx.send(shell::metadata(&path).ok());
    });
    let meta = rx.await.map_err(|e| e.to_string())?;
    if let Some(m) = &meta {
        s.media_meta.write().insert(id, m.clone());
        let idx = s.index.read();
        if let Some(index) = idx.as_ref() {
            let _ = media::store(s.db.lock().conn_mut(), index, &[(id, m.clone())]);
        }
    }
    Ok(meta)
}

fn tokio_oneshot<T: Send + 'static>() -> (std::sync::mpsc::SyncSender<T>, impl std::future::Future<Output = Result<T, String>>) {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let fut = async move { tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|e| e.to_string())).await.map_err(|e| e.to_string())? };
    (tx, fut)
}

/// Fill the metadata cache for every media file (enables sorting and
/// filtering by resolution/duration). Runs in the background.
#[tauri::command]
pub async fn media_index_start(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    let s = state.inner().clone();
    if s.media_running.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    std::thread::spawn(move || {
        let (todo, scan_id): (Vec<(u32, PathBuf)>, String) = {
            let idx = s.index.read();
            let Some(index) = idx.as_ref() else {
                s.media_running.store(false, Ordering::SeqCst);
                return;
            };
            let have = s.media_meta.read();
            let ids: Vec<u32> = index
                .files
                .iter()
                .enumerate()
                .filter(|(i, f)| media::is_media(f.cat) && f.flags & (flags::CLOUD | flags::REMOVED) == 0 && !have.contains_key(&(*i as u32)))
                .map(|(i, _)| i as u32)
                .collect();
            drop(have);
            // Cached rows first: no shell work needed for unchanged files.
            let cached = media::load_cached(s.db.lock().conn(), index, &ids);
            let todo = ids.iter().filter(|i| !cached.contains_key(i)).map(|&i| (i, index.file_path(i))).collect();
            s.media_meta.write().extend(cached);
            (todo, index.id.clone())
        };
        let total = todo.len();
        let done = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let _ = app.emit("media-progress", serde_json::json!({ "done": 0, "total": total }));
        for chunk in todo.chunks(64) {
            if s.index.read().as_ref().map(|i| i.id != scan_id).unwrap_or(true) {
                break; // a new scan replaced the index
            }
            let results: Vec<(u32, MediaMeta)> = shell_pool().install(|| {
                use rayon::prelude::*;
                chunk.par_iter().map(|(id, p)| (*id, shell::metadata(p).unwrap_or_default())).collect()
            });
            {
                let idx = s.index.read();
                if let Some(index) = idx.as_ref().filter(|i| i.id == scan_id) {
                    let _ = media::store(s.db.lock().conn_mut(), index, &results);
                }
            }
            s.media_meta.write().extend(results);
            let d = done.fetch_add(chunk.len(), Ordering::SeqCst) + chunk.len();
            let _ = app.emit("media-progress", serde_json::json!({ "done": d, "total": total }));
        }
        s.media_running.store(false, Ordering::SeqCst);
        let _ = app.emit("media-finished", total);
    });
    Ok(())
}

/// Serves `thumb://localhost/<file id>?s=<px>` from the disk cache or the shell.
pub fn thumb_protocol(ctx: tauri::UriSchemeContext<'_, tauri::Wry>, request: tauri::http::Request<Vec<u8>>, responder: tauri::UriSchemeResponder) {
    let app = ctx.app_handle().clone();
    let uri = request.uri().clone();
    shell_pool().spawn(move || {
        let not_found = |msg: &str| tauri::http::Response::builder().status(404).header("Content-Type", "text/plain").body(msg.as_bytes().to_vec()).unwrap();
        let id: Option<u32> = uri.path().trim_start_matches('/').split('/').next().and_then(|s| s.parse().ok());
        let size: u32 = uri.query().and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("s="))).and_then(|v| v.parse().ok()).unwrap_or(256).clamp(48, 1024);
        let Some(id) = id else { return responder.respond(not_found("bad id")) };
        let state = app.state::<AppState>();
        let target = {
            let idx = state.index.read();
            idx.as_ref().and_then(|index| {
                let f = index.files.get(id as usize)?;
                (f.flags & flags::REMOVED == 0).then(|| (index.file_path(id), f.size, f.modified, f.flags & flags::CLOUD != 0))
            })
        };
        let Some((path, fsize, mtime, cloud)) = target else { return responder.respond(not_found("unknown file")) };
        let key = blake3::hash(format!("{}|{fsize}|{mtime}|{size}", paths::normalize(&path)).as_bytes()).to_hex();
        let dir = state.data_dir.join("thumbs");
        let file = dir.join(format!("{}.jpg", &key[..32]));
        let bytes = match std::fs::read(&file) {
            Ok(b) => Some(b),
            Err(_) => match shell::thumbnail(&path, size, cloud) {
                Ok(b) => {
                    let _ = std::fs::create_dir_all(&dir);
                    let _ = std::fs::write(&file, &b);
                    Some(b)
                }
                Err(_) => None,
            },
        };
        match bytes {
            Some(b) => responder.respond(tauri::http::Response::builder().header("Content-Type", "image/jpeg").header("Cache-Control", "max-age=31536000, immutable").body(b).unwrap()),
            None => responder.respond(not_found("no thumbnail")),
        }
    });
}

/// Keep the thumbnail cache below ~400 MB (oldest first).
pub fn prune_thumbs(data_dir: &Path) {
    let Ok(rd) = std::fs::read_dir(data_dir.join("thumbs")) else { return };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = rd.flatten().filter_map(|e| {
        let m = e.metadata().ok()?;
        Some((m.modified().ok()?, m.len(), e.path()))
    }).collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    if total <= 400 * 1024 * 1024 {
        return;
    }
    files.sort();
    for (_, len, p) in files {
        if total <= 300 * 1024 * 1024 {
            break;
        }
        if std::fs::remove_file(&p).is_ok() {
            total -= len;
        }
    }
}

// -------------------------------------------------------------- activity

#[tauri::command]
pub async fn file_activity(state: State<'_, AppState>, query: ActivityQuery) -> CmdResult<Activity> {
    let s = state.inner().clone();
    blocking(move || {
        let idx = s.index.read();
        let index = idx.as_ref().ok_or(NO_SCAN)?;
        let mut a = activity::compute(index, &query, now_unix());
        // What CLARITY itself observed: its scans and cleanups.
        let db = s.db.lock();
        let conn = db.conn();
        let mut obs = Vec::new();
        if let Ok(mut st) = conn.prepare("SELECT taken_at, complete FROM snapshots ORDER BY taken_at") {
            if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, bool>(1)?))) {
                for (at, complete) in rows.flatten() {
                    obs.push(Observed { day: activity::local_day(at, query.tz_offset_min), at, kind: "scan".into(), label: if complete { "CLARITY scanned".into() } else { "Scan cancelled".into() } });
                }
            }
        }
        if let Ok(mut st) = conn.prepare("SELECT at, mode, succeeded, bytes_removed FROM cleanup_runs WHERE succeeded > 0 ORDER BY at") {
            if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?))) {
                for (at, mode, n, bytes) in rows.flatten() {
                    let what = match mode.as_str() {
                        "move" => "moved",
                        "permanent" => "deleted",
                        _ => "moved to the Recycle Bin",
                    };
                    obs.push(Observed { day: activity::local_day(at, query.tz_offset_min), at, kind: "cleanup".into(), label: format!("{n} items {what} ({})", crate::recommend::human_size(bytes as u64)) });
                }
            }
        }
        a.observed = obs.into_iter().filter(|o| o.day >= query.from_day && o.day <= query.to_day).collect();
        Ok(a)
    })
    .await
}

// ------------------------------------------------------------- watchlist

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchView {
    entries: Vec<WatchEntry>,
    alerts: Vec<Alert>,
    /// Current size from the loaded scan, if it covers the location.
    current: HashMap<i64, u64>,
}

#[tauri::command]
pub async fn watch_list(state: State<'_, AppState>) -> CmdResult<WatchView> {
    let s = state.inner().clone();
    blocking(move || {
        let (entries, alerts) = {
            let db = s.db.lock();
            (watch::list(db.conn()).map_err(|e| e.to_string())?, watch::alerts(db.conn(), 100).map_err(|e| e.to_string())?)
        };
        let mut current = HashMap::new();
        if let Some(index) = s.index.read().as_ref() {
            for e in &entries {
                if let Some(d) = index.find_dir(Path::new(&e.path)) {
                    current.insert(e.id, index.dirs[d as usize].total_size);
                }
            }
        }
        Ok(WatchView { entries, alerts, current })
    })
    .await
}

#[tauri::command]
pub async fn watch_add(state: State<'_, AppState>, path: String, rules: WatchRules) -> CmdResult<i64> {
    let s = state.inner().clone();
    blocking(move || {
        let p = PathBuf::from(&path);
        if !paths::is_plain_absolute(&p) {
            return Err("Choose a folder or drive.".into());
        }
        if !p.is_dir() {
            return Err("This folder does not exist or is not reachable right now.".into());
        }
        let id = watch::add(s.db.lock().conn(), &p, &rules, now_unix()).map_err(|e| e.to_string())?;
        // Record the current size right away if the loaded scan covers it.
        if let Some(index) = s.index.read().as_ref() {
            if let Some(d) = index.find_dir(&p) {
                let at = if index.finished_at > 0 { index.finished_at } else { now_unix() };
                let dir = &index.dirs[d as usize];
                let _ = s.db.lock().conn().execute(
                    "INSERT OR IGNORE INTO watch_history (watch_id, at, bytes, files, source) VALUES (?1, ?2, ?3, ?4, 'scan')",
                    params![id, at, dir.total_size as i64, dir.total_files as i64],
                );
            }
        }
        Ok(id)
    })
    .await
}

#[tauri::command]
pub async fn watch_update(state: State<'_, AppState>, id: i64, rules: WatchRules) -> CmdResult<()> {
    watch::update(state.db.lock().conn(), id, &rules).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn watch_pause(state: State<'_, AppState>, id: i64, paused: bool) -> CmdResult<()> {
    watch::set_paused(state.db.lock().conn(), id, paused).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn watch_remove(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    watch::remove(state.db.lock().conn(), id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn watch_mark_seen(state: State<'_, AppState>, ids: Vec<i64>) -> CmdResult<()> {
    watch::mark_seen(state.db.lock().conn(), &ids).map_err(|e| e.to_string())
}

// -------------------------------------------------------------- organizer

use crate::organizer::{self, ApplyItem, Plan, RunSummary};

#[tauri::command]
pub async fn organize_analyze(state: State<'_, AppState>, root: String, options: organizer::Options) -> CmdResult<Plan> {
    let s = state.inner().clone();
    blocking(move || {
        let p = PathBuf::from(&root);
        if let Some(why) = s.protector.check_destination(&p) {
            return Err(format!("This folder belongs to Windows or an application and cannot be organized. {why}"));
        }
        organizer::analyze(&p, &options, now_unix())
    })
    .await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictQuery {
    id: u32,
    name: String,
    dest: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictInfo {
    id: u32,
    conflict: Option<String>,
    /// A free alternative name for "keep both".
    suggestion: Option<String>,
}

/// Re-check conflicts after the user changed destinations.
#[tauri::command]
pub async fn organize_conflicts(root: String, files: Vec<ConflictQuery>) -> CmdResult<Vec<ConflictInfo>> {
    blocking(move || {
        let r = PathBuf::from(&root);
        let mut pf: Vec<organizer::PlanFile> = files
            .iter()
            .map(|f| organizer::PlanFile { id: f.id, name: f.name.clone(), size: 0, modified: 0, created: 0, category: "other", dest: f.dest.clone(), reason: String::new(), group: None, conflict: None })
            .collect();
        organizer::mark_conflicts(&r, &mut pf);
        let mut taken: HashMap<String, std::collections::HashSet<String>> = HashMap::new();
        for f in &pf {
            taken.entry(f.dest.to_lowercase()).or_default().insert(f.name.to_lowercase());
        }
        Ok(pf
            .into_iter()
            .map(|f| {
                let suggestion = f.conflict.as_ref().filter(|_| organizer::validate_dest(&f.dest).is_ok()).map(|_| {
                    let dir = r.join(f.dest.replace('/', "\\"));
                    let t = taken.entry(f.dest.to_lowercase()).or_default();
                    let n = organizer::free_name(&dir, &f.name, t);
                    t.insert(n.to_lowercase());
                    n
                });
                ConflictInfo { id: f.id, conflict: f.conflict, suggestion }
            })
            .collect())
    })
    .await
}

fn reflect_in_index(s: &Shared, root: &Path, moved: &[(String, bool)]) {
    // `moved`: (file name in root, true = moved away / false = moved back)
    let mut idx = s.index.write();
    let Some(index) = idx.as_mut() else { return };
    let Some(dir) = index.find_dir(root) else { return };
    let names: HashMap<String, bool> = moved.iter().map(|(n, away)| (n.to_lowercase(), *away)).collect();
    let ids: Vec<(usize, bool)> = index.files_of(dir).filter_map(|f| names.get(&index.files[f].name.to_lowercase()).map(|&a| (f, a))).collect();
    for (f, away) in ids {
        if away {
            index.files[f].flags |= flags::REMOVED;
        } else {
            index.files[f].flags &= !flags::REMOVED;
        }
    }
    crate::scan::aggregate(index);
    drop(idx);
    s.refresh_pub();
}

#[tauri::command]
pub async fn organize_apply(app: AppHandle, state: State<'_, AppState>, root: String, mode: String, items: Vec<ApplyItem>, confirmed: bool) -> CmdResult<()> {
    if !confirmed {
        return Err("Organizing needs your confirmation.".into());
    }
    let s = state.inner().clone();
    if s.protector.check_destination(Path::new(&root)).is_some() {
        return Err("This folder cannot be organized.".into());
    }
    if s.scanning.load(Ordering::SeqCst) || s.cleaning.swap(true, Ordering::SeqCst) {
        return Err("Wait for the running scan, cleanup or organization to finish.".into());
    }
    s.organize_cancel.store(false, Ordering::SeqCst);
    std::thread::spawn(move || {
        let r = PathBuf::from(&root);
        let mut last = std::time::Instant::now() - std::time::Duration::from_secs(1);
        let result = {
            let db = s.db.lock();
            organizer::apply(db.conn(), &r, &mode, &items, &s.organize_cancel, now_unix(), |done, total, name| {
                if last.elapsed().as_millis() > 80 || done == total {
                    last = std::time::Instant::now();
                    let _ = app.emit("organize-progress", serde_json::json!({ "done": done, "total": total, "current": name }));
                }
            })
        };
        if let Ok(sum) = &result {
            let moved: Vec<(String, bool)> = sum.items.iter().filter(|i| i.status == "moved").map(|i| (i.name.clone(), true)).collect();
            reflect_in_index(&s, &r, &moved);
        }
        s.cleaning.store(false, Ordering::SeqCst);
        let _ = app.emit("organize-finished", match result {
            Ok(sum) => serde_json::json!({ "ok": sum }),
            Err(e) => serde_json::json!({ "error": e }),
        });
    });
    Ok(())
}

#[tauri::command]
pub async fn organize_cancel(state: State<'_, AppState>) -> CmdResult<()> {
    state.organize_cancel.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn organize_runs(state: State<'_, AppState>) -> CmdResult<Vec<RunSummary>> {
    let s = state.inner().clone();
    blocking(move || organizer::runs(s.db.lock().conn(), 50).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn organize_undo(state: State<'_, AppState>, run_id: i64) -> CmdResult<RunSummary> {
    let s = state.inner().clone();
    if s.cleaning.swap(true, Ordering::SeqCst) {
        return Err("Wait for the running cleanup or organization to finish.".into());
    }
    let res = blocking({
        let s = s.clone();
        move || {
            let sum = organizer::undo(s.db.lock().conn(), run_id, now_unix())?;
            let back: Vec<(String, bool)> = sum.items.iter().filter(|i| i.status == "restored").map(|i| (i.name.clone(), false)).collect();
            reflect_in_index(&s, Path::new(&sum.root), &back);
            Ok(sum)
        }
    })
    .await;
    s.cleaning.store(false, Ordering::SeqCst);
    res
}
