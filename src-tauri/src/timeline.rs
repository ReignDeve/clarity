//! Storage Timeline: compact snapshots of each scan and comparisons
//! between them.
//!
//! A snapshot never stores every file. Per scanned root it keeps:
//! - totals (bytes, files) and the volume's used/total space at scan time
//! - bytes per file category
//! - "significant" folders (above a size floor, limited depth, capped count)
//! - a manifest of large files only (above a size floor, capped count)
//!
//! Paths are interned once in `paths` and referenced by id, so a folder or
//! file that appears in fifty snapshots is stored as text once. Folder and
//! file detail is pruned for old snapshots; totals and categories are kept
//! forever, so the long-range chart never loses points.

use crate::model::{flags, Category, ScanIndex, NONE};
use crate::paths::normalize;
use crate::recommend::human_size;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;

#[derive(Debug, Clone)]
pub struct Policy {
    /// Files at least this large are listed individually.
    pub file_min: u64,
    pub max_files_per_root: usize,
    /// Folders at least this large (and not deeper than `dir_max_depth`
    /// below the root) are tracked individually.
    pub dir_min: u64,
    pub dir_max_depth: u32,
    pub max_dirs_per_root: usize,
    /// Snapshots (newest first) that keep their file manifest / folder list.
    pub keep_files: usize,
    pub keep_dirs: usize,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            file_min: 10 * 1024 * 1024,
            max_files_per_root: 50_000,
            dir_min: 16 * 1024 * 1024,
            dir_max_depth: 5,
            max_dirs_per_root: 4_000,
            keep_files: 24,
            keep_dirs: 120,
        }
    }
}

pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS paths (
            id INTEGER PRIMARY KEY,
            norm TEXT NOT NULL UNIQUE,
            display TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scan_id TEXT UNIQUE,
            taken_at INTEGER NOT NULL,
            complete INTEGER NOT NULL,
            has_dirs INTEGER NOT NULL,
            has_files INTEGER NOT NULL,
            legacy INTEGER NOT NULL DEFAULT 0,
            errors INTEGER NOT NULL DEFAULT 0,
            config TEXT NOT NULL DEFAULT '',
            file_min INTEGER NOT NULL DEFAULT 0,
            dir_min INTEGER NOT NULL DEFAULT 0);
         CREATE INDEX IF NOT EXISTS snapshots_time ON snapshots(taken_at);
         CREATE TABLE IF NOT EXISTS snapshot_roots (
            snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
            root_id INTEGER NOT NULL REFERENCES paths(id),
            bytes INTEGER NOT NULL, files INTEGER NOT NULL,
            volume_total INTEGER, volume_used INTEGER,
            PRIMARY KEY (snapshot_id, root_id)) WITHOUT ROWID;
         CREATE INDEX IF NOT EXISTS snapshot_roots_root ON snapshot_roots(root_id);
         CREATE TABLE IF NOT EXISTS snapshot_categories (
            snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
            root_id INTEGER NOT NULL,
            category TEXT NOT NULL, bytes INTEGER NOT NULL, files INTEGER NOT NULL,
            PRIMARY KEY (snapshot_id, root_id, category)) WITHOUT ROWID;
         CREATE TABLE IF NOT EXISTS snapshot_dirs (
            snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
            path_id INTEGER NOT NULL,
            root_id INTEGER NOT NULL,
            bytes INTEGER NOT NULL, files INTEGER NOT NULL,
            PRIMARY KEY (snapshot_id, path_id)) WITHOUT ROWID;
         CREATE TABLE IF NOT EXISTS snapshot_files (
            snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
            path_id INTEGER NOT NULL,
            root_id INTEGER NOT NULL,
            size INTEGER NOT NULL, mtime INTEGER NOT NULL,
            category TEXT NOT NULL,
            PRIMARY KEY (snapshot_id, path_id)) WITHOUT ROWID;",
    )
}

fn intern(conn: &Connection, path: &Path) -> rusqlite::Result<i64> {
    let norm = normalize(path);
    conn.execute("INSERT OR IGNORE INTO paths (norm, display) VALUES (?1, ?2)", params![norm, path.display().to_string()])?;
    conn.query_row("SELECT id FROM paths WHERE norm = ?1", params![norm], |r| r.get(0))
}

pub struct RecordCtx {
    /// Exclusions etc.; comparisons warn when this differs.
    pub config: String,
    /// (root path) -> (volume total, volume used) at scan time.
    pub volumes: HashMap<String, (u64, u64)>,
}

/// Store a snapshot of `index`. Replaces an existing snapshot of the same
/// scan (e.g. a legacy totals-only import of it).
pub fn record(conn: &mut Connection, index: &ScanIndex, ctx: &RecordCtx, policy: &Policy) -> rusqlite::Result<i64> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM snapshots WHERE scan_id = ?1", params![index.id])?;
    let complete = !index.cancelled;
    let taken_at = if index.finished_at > 0 { index.finished_at } else { index.started_at };
    tx.execute(
        "INSERT INTO snapshots (scan_id, taken_at, complete, has_dirs, has_files, errors, config, file_min, dir_min)
         VALUES (?1, ?2, ?3, ?3, ?3, ?4, ?5, ?6, ?7)",
        params![index.id, taken_at, complete, index.error_count as i64, ctx.config, policy.file_min as i64, policy.dir_min as i64],
    )?;
    let sid = tx.last_insert_rowid();

    // Which root each directory belongs to (BFS order: parents first).
    let mut root_of = vec![0u32; index.dirs.len()];
    for (i, d) in index.dirs.iter().enumerate() {
        root_of[i] = if d.parent == NONE { i as u32 } else { root_of[d.parent as usize] };
    }
    let mut root_pid: HashMap<u32, i64> = HashMap::new();
    for &r in &index.roots {
        let path = index.dir_path(r);
        let pid = intern(&tx, &path)?;
        root_pid.insert(r, pid);
        let d = &index.dirs[r as usize];
        let vol = ctx.volumes.get(&*d.name).copied();
        tx.execute(
            "INSERT INTO snapshot_roots (snapshot_id, root_id, bytes, files, volume_total, volume_used) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![sid, pid, d.total_size as i64, d.total_files as i64, vol.map(|v| v.0 as i64), vol.map(|v| v.1 as i64)],
        )?;
    }

    if complete {
        // Categories per root.
        let mut cats: HashMap<(u32, Category), (u64, u64)> = HashMap::new();
        for f in &index.files {
            if f.flags & flags::REMOVED != 0 {
                continue;
            }
            let e = cats.entry((root_of[f.dir as usize], f.cat)).or_default();
            e.0 += f.size;
            e.1 += 1;
        }
        {
            let mut st = tx.prepare("INSERT INTO snapshot_categories (snapshot_id, root_id, category, bytes, files) VALUES (?1, ?2, ?3, ?4, ?5)")?;
            for ((root, cat), (b, n)) in &cats {
                st.execute(params![sid, root_pid[root], cat.as_str(), *b as i64, *n as i64])?;
            }
        }

        // Significant folders.
        let mut per_root: HashMap<u32, Vec<u32>> = HashMap::new();
        let mut depth = vec![0u32; index.dirs.len()];
        for (i, d) in index.dirs.iter().enumerate() {
            if d.parent != NONE {
                depth[i] = depth[d.parent as usize] + 1;
                if depth[i] <= policy.dir_max_depth && d.total_size >= policy.dir_min && d.flags & flags::REMOVED == 0 {
                    per_root.entry(root_of[i]).or_default().push(i as u32);
                }
            }
        }
        {
            let mut st = tx.prepare("INSERT INTO snapshot_dirs (snapshot_id, path_id, root_id, bytes, files) VALUES (?1, ?2, ?3, ?4, ?5)")?;
            for (root, mut dirs) in per_root {
                dirs.sort_by_key(|&d| std::cmp::Reverse(index.dirs[d as usize].total_size));
                dirs.truncate(policy.max_dirs_per_root);
                for d in dirs {
                    let pid = intern(&tx, &index.dir_path(d))?;
                    let rec = &index.dirs[d as usize];
                    st.execute(params![sid, pid, root_pid[&root], rec.total_size as i64, rec.total_files as i64])?;
                }
            }
        }

        // Large-file manifest.
        let mut big: HashMap<u32, Vec<u32>> = HashMap::new();
        for (i, f) in index.files.iter().enumerate() {
            if f.size >= policy.file_min && f.flags & flags::REMOVED == 0 {
                big.entry(root_of[f.dir as usize]).or_default().push(i as u32);
            }
        }
        {
            let mut st = tx.prepare("INSERT INTO snapshot_files (snapshot_id, path_id, root_id, size, mtime, category) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")?;
            for (root, mut files) in big {
                files.sort_by_key(|&f| std::cmp::Reverse(index.files[f as usize].size));
                files.truncate(policy.max_files_per_root);
                for f in files {
                    let pid = intern(&tx, &index.file_path(f))?;
                    let rec = &index.files[f as usize];
                    st.execute(params![sid, pid, root_pid[&root], rec.size as i64, rec.modified, rec.cat.as_str()])?;
                }
            }
        }
    }
    tx.commit()?;
    prune(conn, policy)?;
    Ok(sid)
}

/// Drop folder/file detail of old snapshots and unreferenced paths.
pub fn prune(conn: &Connection, policy: &Policy) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE snapshots SET has_files = 0 WHERE has_files = 1 AND id NOT IN
           (SELECT id FROM snapshots WHERE has_files = 1 ORDER BY taken_at DESC LIMIT ?1)",
        params![policy.keep_files as i64],
    )?;
    conn.execute("DELETE FROM snapshot_files WHERE snapshot_id IN (SELECT id FROM snapshots WHERE has_files = 0)", [])?;
    conn.execute(
        "UPDATE snapshots SET has_dirs = 0 WHERE has_dirs = 1 AND id NOT IN
           (SELECT id FROM snapshots WHERE has_dirs = 1 ORDER BY taken_at DESC LIMIT ?1)",
        params![policy.keep_dirs as i64],
    )?;
    conn.execute("DELETE FROM snapshot_dirs WHERE snapshot_id IN (SELECT id FROM snapshots WHERE has_dirs = 0)", [])?;
    conn.execute(
        "DELETE FROM paths WHERE id NOT IN (SELECT root_id FROM snapshot_roots)
           AND id NOT IN (SELECT path_id FROM snapshot_dirs)
           AND id NOT IN (SELECT path_id FROM snapshot_files)",
        [],
    )?;
    Ok(())
}

/// Turn pre-timeline scan history (totals only) into legacy snapshots, once.
pub fn import_legacy(conn: &Connection) -> rusqlite::Result<usize> {
    let mut st = conn.prepare(
        "SELECT started_at, duration_ms, roots, files, bytes, errors, cancelled FROM scans
         WHERE ('scan-' || started_at) NOT IN (SELECT scan_id FROM snapshots WHERE scan_id IS NOT NULL)",
    )?;
    let rows: Vec<(i64, i64, String, i64, i64, i64, bool)> = st
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut n = 0;
    for (started, dur, roots, files, bytes, errors, cancelled) in rows {
        let roots: Vec<String> = serde_json::from_str(&roots).unwrap_or_default();
        // Combined totals cannot be split between several roots.
        if roots.len() != 1 {
            continue;
        }
        conn.execute(
            "INSERT INTO snapshots (scan_id, taken_at, complete, has_dirs, has_files, legacy, errors) VALUES (?1, ?2, ?3, 0, 0, 1, ?4)",
            params![format!("scan-{started}"), started + dur / 1000, !cancelled, errors],
        )?;
        let sid = conn.last_insert_rowid();
        let pid = intern(conn, Path::new(&roots[0]))?;
        conn.execute("INSERT INTO snapshot_roots (snapshot_id, root_id, bytes, files) VALUES (?1, ?2, ?3, ?4)", params![sid, pid, bytes, files])?;
        n += 1;
    }
    Ok(n)
}

pub fn has_snapshot(conn: &Connection, scan_id: &str) -> rusqlite::Result<bool> {
    conn.query_row("SELECT COUNT(*) FROM snapshots WHERE scan_id = ?1 AND legacy = 0", params![scan_id], |r| r.get::<_, i64>(0)).map(|n| n > 0)
}

// ------------------------------------------------------------------ queries

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineRoot {
    pub id: i64,
    pub path: String,
    pub snapshots: i64,
    pub first_at: i64,
    pub last_at: i64,
    /// The folder or drive currently exists (drive connected).
    pub available: bool,
}

pub fn roots(conn: &Connection) -> rusqlite::Result<Vec<TimelineRoot>> {
    let mut st = conn.prepare(
        "SELECT p.id, p.display, COUNT(*), MIN(s.taken_at), MAX(s.taken_at)
         FROM snapshot_roots r JOIN snapshots s ON s.id = r.snapshot_id JOIN paths p ON p.id = r.root_id
         GROUP BY p.id ORDER BY MAX(s.taken_at) DESC",
    )?;
    let rows = st.query_map([], |r| {
        let path: String = r.get(1)?;
        Ok(TimelineRoot { id: r.get(0)?, available: Path::new(&path).is_dir(), path, snapshots: r.get(2)?, first_at: r.get(3)?, last_at: r.get(4)? })
    })?;
    rows.collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub snapshot_id: i64,
    pub taken_at: i64,
    pub bytes: u64,
    pub files: u64,
    pub volume_total: Option<u64>,
    pub volume_used: Option<u64>,
    pub complete: bool,
    pub legacy: bool,
    pub has_dirs: bool,
    pub has_files: bool,
    pub errors: u64,
    /// Category -> bytes; empty for legacy or incomplete snapshots.
    pub categories: HashMap<String, u64>,
}

pub fn series(conn: &Connection, root_id: i64, since: i64) -> rusqlite::Result<Vec<Point>> {
    let mut st = conn.prepare(
        "SELECT s.id, s.taken_at, r.bytes, r.files, r.volume_total, r.volume_used, s.complete, s.legacy, s.has_dirs, s.has_files, s.errors
         FROM snapshot_roots r JOIN snapshots s ON s.id = r.snapshot_id
         WHERE r.root_id = ?1 AND s.taken_at >= ?2 ORDER BY s.taken_at",
    )?;
    let mut points: Vec<Point> = st
        .query_map(params![root_id, since], |r| {
            Ok(Point {
                snapshot_id: r.get(0)?,
                taken_at: r.get(1)?,
                bytes: r.get::<_, i64>(2)? as u64,
                files: r.get::<_, i64>(3)? as u64,
                volume_total: r.get::<_, Option<i64>>(4)?.map(|v| v as u64),
                volume_used: r.get::<_, Option<i64>>(5)?.map(|v| v as u64),
                complete: r.get(6)?,
                legacy: r.get(7)?,
                has_dirs: r.get(8)?,
                has_files: r.get(9)?,
                errors: r.get::<_, i64>(10)? as u64,
                categories: HashMap::new(),
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut cs = conn.prepare("SELECT category, bytes FROM snapshot_categories WHERE snapshot_id = ?1 AND root_id = ?2")?;
    for p in points.iter_mut() {
        p.categories = cs.query_map(params![p.snapshot_id, root_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u64)))?.collect::<rusqlite::Result<_>>()?;
    }
    Ok(points)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Delta {
    pub path: String,
    pub name: String,
    pub before: u64,
    pub after: u64,
    pub delta: i64,
    /// "added" | "removed" | "changed" (folders below the tracking floor in
    /// one snapshot count as added/removed)
    pub status: &'static str,
    pub category: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatDelta {
    pub category: String,
    pub before: u64,
    pub after: u64,
    pub delta: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Highlight {
    pub text: String,
    pub detail: String,
    pub delta: i64,
    /// Path to investigate, if any.
    pub path: Option<String>,
    pub kind: &'static str, // "dir" | "file" | "category" | "total"
    pub category: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileChanges {
    pub items: Vec<Delta>,
    pub count: usize,
    pub bytes: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub root: String,
    pub from: Point,
    pub to: Point,
    pub delta: i64,
    pub files_delta: i64,
    pub volume_used_delta: Option<i64>,
    pub categories: Vec<CatDelta>,
    pub grew: Vec<Delta>,
    pub shrank: Vec<Delta>,
    pub added: FileChanges,
    pub deleted: FileChanges,
    pub modified: FileChanges,
    pub highlights: Vec<Highlight>,
    pub warnings: Vec<String>,
    pub has_folder_detail: bool,
    pub has_file_detail: bool,
    pub file_min: u64,
    pub dir_min: u64,
}

fn name_of(path: &str) -> String {
    path.trim_end_matches('\\').rsplit('\\').next().unwrap_or(path).to_string()
}

fn signed(after: u64, before: u64) -> i64 {
    after as i64 - before as i64
}

fn point(conn: &Connection, sid: i64, root_id: i64) -> rusqlite::Result<Option<Point>> {
    let since = 0;
    Ok(series(conn, root_id, since)?.into_iter().find(|p| p.snapshot_id == sid))
}

fn snapshot_meta(conn: &Connection, sid: i64) -> rusqlite::Result<(String, i64, i64)> {
    conn.query_row("SELECT config, file_min, dir_min FROM snapshots WHERE id = ?1", params![sid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
}

/// Folders whose change is mostly explained by a single tracked subfolder
/// are left out, so the list points at where things actually happened.
fn most_specific(deltas: &mut Vec<Delta>) {
    let mut child_max: HashMap<String, i64> = HashMap::new();
    for d in deltas.iter() {
        let norm = d.path.to_lowercase();
        if let Some((parent, _)) = norm.rsplit_once('\\') {
            let e = child_max.entry(parent.to_string()).or_insert(0);
            if d.delta.abs() > e.abs() {
                *e = d.delta;
            }
        }
    }
    deltas.retain(|d| match child_max.get(&d.path.to_lowercase()) {
        Some(&c) => !(c.signum() == d.delta.signum() && c.abs() * 4 >= d.delta.abs() * 3),
        None => true,
    });
}

pub fn compare(conn: &Connection, root_id: i64, from: i64, to: i64) -> Result<Comparison, String> {
    let e = |x: rusqlite::Error| x.to_string();
    let root: String = conn.query_row("SELECT display FROM paths WHERE id = ?1", params![root_id], |r| r.get(0)).map_err(e)?;
    let a = point(conn, from, root_id).map_err(e)?.ok_or("The earlier snapshot does not include this location.")?;
    let b = point(conn, to, root_id).map_err(e)?.ok_or("The later snapshot does not include this location.")?;
    let (a, b) = if a.taken_at <= b.taken_at { (a, b) } else { (b, a) };
    let (cfg_a, fmin_a, dmin_a) = snapshot_meta(conn, a.snapshot_id).map_err(e)?;
    let (cfg_b, fmin_b, dmin_b) = snapshot_meta(conn, b.snapshot_id).map_err(e)?;

    let mut warnings = Vec::new();
    for (p, label) in [(&a, "earlier"), (&b, "later")] {
        if !p.complete {
            warnings.push(format!("The {label} scan was cancelled, so its totals are partial and folder or file changes cannot be compared."));
        } else if p.legacy {
            warnings.push(format!("The {label} scan was made before the timeline existed; only its total size is known."));
        }
    }
    if !cfg_a.is_empty() && !cfg_b.is_empty() && cfg_a != cfg_b {
        warnings.push("Scan settings (exclusions or system folders) differed between these scans, so part of the difference may come from what was scanned rather than from real changes.".into());
    }
    if b.errors > a.errors + 10 || a.errors > b.errors + 10 {
        warnings.push(format!("The number of unreadable items changed ({} → {}); access problems can make sizes look different.", a.errors, b.errors));
    }

    let cats: HashSet<&String> = a.categories.keys().chain(b.categories.keys()).collect();
    let mut categories: Vec<CatDelta> = if a.categories.is_empty() || b.categories.is_empty() {
        vec![]
    } else {
        cats.into_iter()
            .map(|c| {
                let (x, y) = (a.categories.get(c).copied().unwrap_or(0), b.categories.get(c).copied().unwrap_or(0));
                CatDelta { category: c.clone(), before: x, after: y, delta: signed(y, x) }
            })
            .filter(|c| c.delta != 0)
            .collect()
    };
    categories.sort_by_key(|c| std::cmp::Reverse(c.delta.abs()));

    let has_folder_detail = a.has_dirs && b.has_dirs;
    let dir_min = dmin_a.max(dmin_b) as u64;
    let (mut grew, mut shrank) = (vec![], vec![]);
    if has_folder_detail {
        let load = |sid: i64| -> rusqlite::Result<HashMap<i64, (String, u64)>> {
            let mut st = conn.prepare("SELECT d.path_id, p.display, d.bytes FROM snapshot_dirs d JOIN paths p ON p.id = d.path_id WHERE d.snapshot_id = ?1 AND d.root_id = ?2")?;
            let rows = st.query_map(params![sid, root_id], |r| Ok((r.get::<_, i64>(0)?, (r.get::<_, String>(1)?, r.get::<_, i64>(2)? as u64))))?;
            rows.collect()
        };
        let (da, db) = (load(a.snapshot_id).map_err(e)?, load(b.snapshot_id).map_err(e)?);
        let ids: HashSet<&i64> = da.keys().chain(db.keys()).collect();
        let mut all: Vec<Delta> = ids
            .into_iter()
            .map(|id| {
                let (pa, x) = da.get(id).map(|(p, v)| (Some(p), *v)).unwrap_or((None, 0));
                let (pb, y) = db.get(id).map(|(p, v)| (Some(p), *v)).unwrap_or((None, 0));
                let path = pb.or(pa).unwrap().clone();
                Delta {
                    name: name_of(&path),
                    path,
                    before: x,
                    after: y,
                    delta: signed(y, x),
                    status: if pa.is_none() { "added" } else if pb.is_none() { "removed" } else { "changed" },
                    category: None,
                }
            })
            // Changes smaller than the tracking floor are noise.
            .filter(|d| d.delta.unsigned_abs() >= dir_min / 4)
            .collect();
        most_specific(&mut all);
        all.sort_by_key(|d| std::cmp::Reverse(d.delta));
        grew = all.iter().filter(|d| d.delta > 0).take(15).cloned().collect();
        shrank = all.iter().rev().filter(|d| d.delta < 0).take(15).cloned().collect();
    }

    let has_file_detail = a.has_files && b.has_files;
    let file_min = fmin_a.max(fmin_b) as u64;
    let (mut added, mut deleted, mut modified) = (FileChanges::default(), FileChanges::default(), FileChanges::default());
    if has_file_detail {
        let load = |sid: i64| -> rusqlite::Result<HashMap<i64, (String, u64, i64, String)>> {
            let mut st = conn.prepare("SELECT f.path_id, p.display, f.size, f.mtime, f.category FROM snapshot_files f JOIN paths p ON p.id = f.path_id WHERE f.snapshot_id = ?1 AND f.root_id = ?2")?;
            let rows = st.query_map(params![sid, root_id], |r| Ok((r.get::<_, i64>(0)?, (r.get::<_, String>(1)?, r.get::<_, i64>(2)? as u64, r.get::<_, i64>(3)?, r.get::<_, String>(4)?))))?;
            rows.collect()
        };
        let (fa, fb) = (load(a.snapshot_id).map_err(e)?, load(b.snapshot_id).map_err(e)?);
        let mk = |path: &str, x: u64, y: u64, status: &'static str, cat: &str| Delta { name: name_of(path), path: path.to_string(), before: x, after: y, delta: signed(y, x), status, category: Some(cat.to_string()) };
        for (id, (p, size, mtime, cat)) in &fb {
            match fa.get(id) {
                None if *size >= file_min => added.items.push(mk(p, 0, *size, "added", cat)),
                Some((_, s0, m0, _)) if s0 != size || m0 != mtime => modified.items.push(mk(p, *s0, *size, "changed", cat)),
                _ => {}
            }
        }
        for (id, (p, size, _, cat)) in &fa {
            if !fb.contains_key(id) && *size >= file_min {
                deleted.items.push(mk(p, *size, 0, "removed", cat));
            }
        }
        for c in [&mut added, &mut deleted, &mut modified] {
            c.count = c.items.len();
            c.bytes = c.items.iter().map(|d| d.delta).sum();
            c.items.sort_by_key(|d| std::cmp::Reverse(d.delta.abs()));
            c.items.truncate(150);
        }
    }

    // Highlights, all derived from the numbers above.
    let delta = signed(b.bytes, a.bytes);
    let gap = (b.taken_at - a.taken_at).max(0);
    let since = if gap < 86_400 { "less than a day".to_string() } else { crate::recommend::age_phrase(gap) };
    let mut highlights = Vec::new();
    let verb = |d: i64| if d >= 0 { "grew by" } else { "shrank by" };
    let root_name = name_of(&root);
    let root_label = if root_name.ends_with(':') { root_name.clone() } else { format!("“{root_name}”") };
    highlights.push(Highlight {
        text: if delta == 0 { format!("{root_label} did not change in size") } else { format!("{root_label} {} {}", verb(delta), human_size(delta.unsigned_abs())) },
        detail: if gap < 86_400 { "Between these scans, taken less than a day apart.".to_string() } else { format!("Between these scans, {since} apart.") },
        delta,
        path: Some(root.clone()),
        kind: "total",
        category: None,
    });
    let known: Vec<(String, &str)> = [(dirs::download_dir(), "Downloads"), (dirs::desktop_dir(), "Desktop"), (dirs::document_dir(), "Documents"), (dirs::video_dir(), "Videos"), (dirs::picture_dir(), "Pictures")]
        .into_iter()
        .filter_map(|(p, n)| p.map(|p| (normalize(&p), n)))
        .collect();
    if has_folder_detail {
        let mut seen = HashSet::new();
        for d in grew.iter().chain(shrank.iter()) {
            if let Some((_, label)) = known.iter().find(|(k, _)| *k == normalize(Path::new(&d.path))) {
                seen.insert(d.path.clone());
                highlights.push(Highlight { text: format!("{label} {} {}", verb(d.delta), human_size(d.delta.unsigned_abs())), detail: format!("{} → {}", human_size(d.before), human_size(d.after)), delta: d.delta, path: Some(d.path.clone()), kind: "dir", category: None });
            }
        }
        for d in grew.iter().take(2).chain(shrank.iter().take(1)) {
            if seen.contains(&d.path) || d.delta.unsigned_abs() < 256 * 1024 * 1024 {
                continue;
            }
            let what = match d.status {
                "added" => format!("New folder “{}” takes {}", d.name, human_size(d.after)),
                "removed" => format!("“{}” is gone ({} freed)", d.name, human_size(d.before)),
                _ => format!("“{}” {} {}", d.name, verb(d.delta), human_size(d.delta.unsigned_abs())),
            };
            highlights.push(Highlight { text: what, detail: d.path.clone(), delta: d.delta, path: Some(d.path.clone()), kind: "dir", category: None });
        }
    }
    if let Some(c) = categories.first().filter(|c| c.delta.unsigned_abs() >= 256 * 1024 * 1024) {
        highlights.push(Highlight {
            text: format!("{} {} {}", capitalize(&c.category), if c.delta > 0 { "grew by" } else { "shrank by" }, human_size(c.delta.unsigned_abs())),
            detail: format!("{} → {}", human_size(c.before), human_size(c.after)),
            delta: c.delta,
            path: None,
            kind: "category",
            category: Some(c.category.clone()),
        });
    }
    if added.count > 0 {
        highlights.push(Highlight { text: format!("{} large file{} added ({})", added.count, if added.count == 1 { "" } else { "s" }, human_size(added.bytes.unsigned_abs())), detail: format!("Files of {} or more.", human_size(file_min)), delta: added.bytes, path: added.items.first().map(|d| d.path.clone()), kind: "file", category: None });
    }
    if deleted.count > 0 {
        highlights.push(Highlight { text: format!("{} large file{} removed ({})", deleted.count, if deleted.count == 1 { "" } else { "s" }, human_size(deleted.bytes.unsigned_abs())), detail: format!("Files of {} or more that are no longer there.", human_size(file_min)), delta: deleted.bytes, path: None, kind: "file", category: None });
    }

    Ok(Comparison {
        root,
        delta,
        files_delta: signed(b.files, a.files),
        volume_used_delta: match (a.volume_used, b.volume_used) {
            (Some(x), Some(y)) => Some(signed(y, x)),
            _ => None,
        },
        from: a,
        to: b,
        categories,
        grew,
        shrank,
        added,
        deleted,
        modified,
        highlights,
        warnings,
        has_folder_detail,
        has_file_detail,
        file_min,
        dir_min,
    })
}

fn capitalize(s: &str) -> String {
    let label = match s {
        "apps" => "Applications",
        "code" => "Code & data",
        "system" => "System & temporary",
        "installers" => "Installers",
        _ => s,
    };
    let mut c = label.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scan::{scan, Progress, ScanOptions};
    use std::fs;
    use std::sync::atomic::AtomicBool;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        init(&c).unwrap();
        c
    }

    fn policy() -> Policy {
        Policy { file_min: 1000, dir_min: 100, ..Default::default() }
    }

    fn snap(conn: &mut Connection, root: &Path, id: &str, at: i64, cancelled: bool) -> i64 {
        let mut idx = scan(&ScanOptions { roots: vec![root.into()], exclusions: vec![], skip_system: false }, &AtomicBool::new(false), &Progress::default());
        idx.id = id.into();
        idx.finished_at = at;
        idx.cancelled = cancelled;
        record(conn, &idx, &RecordCtx { config: "cfg".into(), volumes: HashMap::new() }, &policy()).unwrap()
    }

    #[test]
    fn snapshots_and_comparison() {
        let t = tempfile::tempdir().unwrap();
        let r = t.path();
        fs::create_dir_all(r.join("Videos")).unwrap();
        fs::create_dir_all(r.join("Old")).unwrap();
        fs::write(r.join("Videos/a.mp4"), vec![1u8; 5000]).unwrap();
        fs::write(r.join("Old/gone.zip"), vec![1u8; 3000]).unwrap();
        fs::write(r.join("keep.bin"), vec![1u8; 2000]).unwrap();
        fs::write(r.join("tiny.txt"), b"x").unwrap();
        let mut c = db();
        let s1 = snap(&mut c, r, "scan-1", 1000, false);

        fs::write(r.join("Videos/b.mp4"), vec![2u8; 8000]).unwrap();
        fs::remove_dir_all(r.join("Old")).unwrap();
        fs::write(r.join("keep.bin"), vec![1u8; 2500]).unwrap();
        let s2 = snap(&mut c, r, "scan-2", 2000, false);

        let roots = roots(&c).unwrap();
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].snapshots, 2);
        let pts = series(&c, roots[0].id, 0).unwrap();
        assert_eq!(pts.len(), 2);
        assert!(pts[0].categories.contains_key("video"));

        let cmp = compare(&c, roots[0].id, s1, s2).unwrap();
        assert_eq!(cmp.delta, 8000 - 3000 + 500);
        assert_eq!(cmp.added.count, 1);
        assert_eq!(cmp.added.items[0].name, "b.mp4");
        assert_eq!(cmp.deleted.count, 1);
        assert_eq!(cmp.deleted.items[0].name, "gone.zip");
        assert_eq!(cmp.modified.count, 1);
        assert_eq!(cmp.modified.items[0].delta, 500);
        assert!(cmp.grew.iter().any(|d| d.name == "Videos" && d.delta == 8000));
        assert!(cmp.shrank.iter().any(|d| d.name == "Old" && d.status == "removed"));
        let video = cmp.categories.iter().find(|c| c.category == "video").unwrap();
        assert_eq!(video.delta, 8000);
        assert!(cmp.warnings.is_empty());
        // Order of arguments does not matter.
        assert_eq!(compare(&c, roots[0].id, s2, s1).unwrap().delta, cmp.delta);
    }

    #[test]
    fn incomplete_and_legacy_snapshots_only_compare_totals() {
        let t = tempfile::tempdir().unwrap();
        fs::write(t.path().join("f.bin"), vec![0u8; 4000]).unwrap();
        let mut c = db();
        let s1 = snap(&mut c, t.path(), "scan-1", 1000, true);
        let s2 = snap(&mut c, t.path(), "scan-2", 2000, false);
        let root = roots(&c).unwrap()[0].id;
        let cmp = compare(&c, root, s1, s2).unwrap();
        assert!(!cmp.has_file_detail && !cmp.has_folder_detail);
        assert!(cmp.warnings.iter().any(|w| w.contains("cancelled")));
        assert!(cmp.categories.is_empty());
    }

    #[test]
    fn legacy_import_and_replacement() {
        let mut c = db();
        c.execute_batch("CREATE TABLE scans (id INTEGER PRIMARY KEY, started_at INTEGER, duration_ms INTEGER, roots TEXT, files INTEGER, bytes INTEGER, errors INTEGER, cancelled INTEGER);").unwrap();
        let t = tempfile::tempdir().unwrap();
        fs::write(t.path().join("f.bin"), vec![0u8; 4000]).unwrap();
        let root = serde_json::to_string(&vec![t.path().display().to_string()]).unwrap();
        c.execute("INSERT INTO scans (started_at, duration_ms, roots, files, bytes, errors, cancelled) VALUES (500, 2000, ?1, 1, 4000, 0, 0)", params![root]).unwrap();
        c.execute("INSERT INTO scans (started_at, duration_ms, roots, files, bytes, errors, cancelled) VALUES (900, 2000, '[\"C:\\\\\",\"D:\\\\\"]', 1, 1, 0, 0)", []).unwrap();
        assert_eq!(import_legacy(&c).unwrap(), 1); // the two-root scan cannot be split
        assert_eq!(import_legacy(&c).unwrap(), 0); // idempotent
        let r = roots(&c).unwrap();
        assert_eq!(series(&c, r[0].id, 0).unwrap()[0].legacy, true);
        // A detailed snapshot of the same scan replaces the legacy one.
        snap(&mut c, t.path(), "scan-500", 502, false);
        let pts = series(&c, r[0].id, 0).unwrap();
        assert_eq!(pts.len(), 1);
        assert!(!pts[0].legacy && pts[0].has_files);
    }

    #[test]
    fn pruning_keeps_totals_and_drops_old_detail() {
        let t = tempfile::tempdir().unwrap();
        fs::write(t.path().join("f.bin"), vec![0u8; 4000]).unwrap();
        let mut c = db();
        let p = Policy { file_min: 1000, dir_min: 1, keep_files: 2, keep_dirs: 3, ..Default::default() };
        for i in 0..5 {
            let mut idx = scan(&ScanOptions { roots: vec![t.path().into()], exclusions: vec![], skip_system: false }, &AtomicBool::new(false), &Progress::default());
            idx.id = format!("scan-{i}");
            idx.finished_at = 1000 + i;
            record(&mut c, &idx, &RecordCtx { config: String::new(), volumes: HashMap::new() }, &p).unwrap();
        }
        let root = roots(&c).unwrap()[0].id;
        let pts = series(&c, root, 0).unwrap();
        assert_eq!(pts.len(), 5);
        assert_eq!(pts.iter().filter(|p| p.has_files).count(), 2);
        assert_eq!(pts.iter().filter(|p| p.has_dirs).count(), 3);
        let files: i64 = c.query_row("SELECT COUNT(*) FROM snapshot_files", [], |r| r.get(0)).unwrap();
        assert_eq!(files, 2);
        // The file path is interned once despite five snapshots.
        let paths: i64 = c.query_row("SELECT COUNT(*) FROM paths WHERE norm LIKE '%f.bin'", [], |r| r.get(0)).unwrap();
        assert_eq!(paths, 1);
    }
}
