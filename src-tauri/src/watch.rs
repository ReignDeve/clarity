//! Storage watchlist: user-chosen folders/drives with limits and growth
//! thresholds, evaluated after every scan.

use crate::model::ScanIndex;
use crate::paths::{is_same_or_under, normalize};
use crate::recommend::human_size;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Percentage growth is ignored below this, to avoid alerts for tiny folders.
const PCT_FLOOR: i64 = 50 * 1024 * 1024;

pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS watchlist (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL, norm TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
            limit_bytes INTEGER, growth_bytes INTEGER, growth_pct REAL,
            notify INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS watch_history (
            watch_id INTEGER NOT NULL REFERENCES watchlist(id) ON DELETE CASCADE,
            at INTEGER NOT NULL, bytes INTEGER NOT NULL, files INTEGER NOT NULL,
            source TEXT NOT NULL,
            PRIMARY KEY (watch_id, at)) WITHOUT ROWID;
         CREATE TABLE IF NOT EXISTS watch_alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            watch_id INTEGER NOT NULL REFERENCES watchlist(id) ON DELETE CASCADE,
            at INTEGER NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL,
            bytes INTEGER, prev_bytes INTEGER, seen INTEGER NOT NULL DEFAULT 0);",
    )
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct WatchRules {
    pub label: String,
    pub limit_bytes: Option<u64>,
    pub growth_bytes: Option<u64>,
    pub growth_pct: Option<f64>,
    pub notify: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPoint {
    pub at: i64,
    pub bytes: u64,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchEntry {
    pub id: i64,
    pub path: String,
    pub label: String,
    pub limit_bytes: Option<u64>,
    pub growth_bytes: Option<u64>,
    pub growth_pct: Option<f64>,
    pub notify: bool,
    pub paused: bool,
    pub created_at: i64,
    pub available: bool,
    pub history: Vec<HistoryPoint>,
    pub unseen_alerts: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    pub id: i64,
    pub watch_id: i64,
    pub label: String,
    pub path: String,
    pub at: i64,
    pub kind: String,
    pub message: String,
    pub bytes: Option<u64>,
    pub prev_bytes: Option<u64>,
    pub seen: bool,
    pub notify: bool,
}

fn default_label(path: &Path) -> String {
    let s = path.display().to_string();
    let t = s.trim_end_matches('\\');
    t.rsplit('\\').next().filter(|x| !x.is_empty() && !x.ends_with(':')).map(String::from).unwrap_or_else(|| format!("Drive {t}"))
}

pub fn add(conn: &Connection, path: &Path, rules: &WatchRules, now: i64) -> rusqlite::Result<i64> {
    let norm = normalize(path);
    let label = if rules.label.trim().is_empty() { default_label(path) } else { rules.label.trim().to_string() };
    conn.execute(
        "INSERT INTO watchlist (path, norm, label, limit_bytes, growth_bytes, growth_pct, notify, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(norm) DO UPDATE SET paused = 0",
        params![path.display().to_string(), norm, label, rules.limit_bytes.map(|v| v as i64), rules.growth_bytes.map(|v| v as i64), rules.growth_pct, rules.notify, now],
    )?;
    let id: i64 = conn.query_row("SELECT id FROM watchlist WHERE norm = ?1", params![norm], |r| r.get(0))?;
    // Backfill from the Storage Timeline (roots always, folders ≥ its floor).
    conn.execute(
        "INSERT OR IGNORE INTO watch_history (watch_id, at, bytes, files, source)
         SELECT ?1, s.taken_at, r.bytes, r.files, 'timeline' FROM snapshot_roots r
           JOIN snapshots s ON s.id = r.snapshot_id JOIN paths p ON p.id = r.root_id
          WHERE p.norm = ?2 AND s.complete = 1
         UNION ALL
         SELECT ?1, s.taken_at, d.bytes, d.files, 'timeline' FROM snapshot_dirs d
           JOIN snapshots s ON s.id = d.snapshot_id JOIN paths p ON p.id = d.path_id
          WHERE p.norm = ?2 AND s.complete = 1",
        params![id, norm],
    )?;
    Ok(id)
}

pub fn update(conn: &Connection, id: i64, rules: &WatchRules) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE watchlist SET label = COALESCE(NULLIF(TRIM(?2), ''), label), limit_bytes = ?3, growth_bytes = ?4, growth_pct = ?5, notify = ?6 WHERE id = ?1",
        params![id, rules.label, rules.limit_bytes.map(|v| v as i64), rules.growth_bytes.map(|v| v as i64), rules.growth_pct, rules.notify],
    )?;
    Ok(())
}

pub fn set_paused(conn: &Connection, id: i64, paused: bool) -> rusqlite::Result<()> {
    conn.execute("UPDATE watchlist SET paused = ?2 WHERE id = ?1", params![id, paused])?;
    Ok(())
}

pub fn remove(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM watchlist WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<WatchEntry>> {
    let mut st = conn.prepare(
        "SELECT w.id, w.path, w.label, w.limit_bytes, w.growth_bytes, w.growth_pct, w.notify, w.paused, w.created_at,
                (SELECT COUNT(*) FROM watch_alerts a WHERE a.watch_id = w.id AND a.seen = 0)
         FROM watchlist w ORDER BY w.created_at",
    )?;
    let mut entries: Vec<WatchEntry> = st
        .query_map([], |r| {
            let path: String = r.get(1)?;
            Ok(WatchEntry {
                id: r.get(0)?,
                available: Path::new(&path).exists(),
                path,
                label: r.get(2)?,
                limit_bytes: r.get::<_, Option<i64>>(3)?.map(|v| v as u64),
                growth_bytes: r.get::<_, Option<i64>>(4)?.map(|v| v as u64),
                growth_pct: r.get(5)?,
                notify: r.get(6)?,
                paused: r.get(7)?,
                created_at: r.get(8)?,
                history: vec![],
                unseen_alerts: r.get(9)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut hs = conn.prepare("SELECT at, bytes, source FROM watch_history WHERE watch_id = ?1 ORDER BY at")?;
    for e in entries.iter_mut() {
        e.history = hs.query_map(params![e.id], |r| Ok(HistoryPoint { at: r.get(0)?, bytes: r.get::<_, i64>(1)? as u64, source: r.get(2)? }))?.collect::<rusqlite::Result<_>>()?;
    }
    Ok(entries)
}

pub fn alerts(conn: &Connection, limit: i64) -> rusqlite::Result<Vec<Alert>> {
    let mut st = conn.prepare(
        "SELECT a.id, a.watch_id, w.label, w.path, a.at, a.kind, a.message, a.bytes, a.prev_bytes, a.seen, w.notify
         FROM watch_alerts a JOIN watchlist w ON w.id = a.watch_id ORDER BY a.at DESC, a.id DESC LIMIT ?1",
    )?;
    let rows = st.query_map(params![limit], |r| {
        Ok(Alert {
            id: r.get(0)?,
            watch_id: r.get(1)?,
            label: r.get(2)?,
            path: r.get(3)?,
            at: r.get(4)?,
            kind: r.get(5)?,
            message: r.get(6)?,
            bytes: r.get::<_, Option<i64>>(7)?.map(|v| v as u64),
            prev_bytes: r.get::<_, Option<i64>>(8)?.map(|v| v as u64),
            seen: r.get(9)?,
            notify: r.get(10)?,
        })
    })?;
    rows.collect()
}

pub fn mark_seen(conn: &Connection, ids: &[i64]) -> rusqlite::Result<()> {
    if ids.is_empty() {
        conn.execute("UPDATE watch_alerts SET seen = 1", [])?;
    } else {
        let mut st = conn.prepare("UPDATE watch_alerts SET seen = 1 WHERE id = ?1")?;
        for id in ids {
            st.execute(params![id])?;
        }
    }
    Ok(())
}

/// Record sizes for all watched locations covered by `index` and raise
/// alerts. Returns the new alerts.
pub fn evaluate(conn: &Connection, index: &ScanIndex, at: i64) -> rusqlite::Result<Vec<Alert>> {
    let roots: Vec<String> = index.roots.iter().map(|&r| normalize(&index.dir_path(r))).collect();
    let entries = list(conn)?;
    let mut new_ids = Vec::new();
    for e in entries.iter().filter(|e| !e.paused) {
        let norm = normalize(Path::new(&e.path));
        // Locations outside this scan (other drive, not selected, disconnected)
        // are left alone: no data is not the same as "empty".
        if !roots.iter().any(|r| is_same_or_under(&norm, r)) {
            continue;
        }
        let prev = e.history.iter().filter(|h| h.at < at).last().map(|h| h.bytes);
        let mut raise = |kind: &str, message: String, bytes: Option<u64>| -> rusqlite::Result<()> {
            conn.execute(
                "INSERT INTO watch_alerts (watch_id, at, kind, message, bytes, prev_bytes) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![e.id, at, kind, message, bytes.map(|v| v as i64), prev.map(|v| v as i64)],
            )?;
            new_ids.push(conn.last_insert_rowid());
            Ok(())
        };
        let Some(dir) = index.find_dir(Path::new(&e.path)) else {
            let last_kind: Option<String> = conn.query_row("SELECT kind FROM watch_alerts WHERE watch_id = ?1 ORDER BY id DESC LIMIT 1", params![e.id], |r| r.get(0)).optional()?;
            if last_kind.as_deref() != Some("missing") {
                raise("missing", format!("{} was not found in the latest scan. It may have been moved, deleted or become unreadable.", e.label), None)?;
            }
            continue;
        };
        let d = &index.dirs[dir as usize];
        let bytes = d.total_size;
        conn.execute(
            "INSERT OR REPLACE INTO watch_history (watch_id, at, bytes, files, source) VALUES (?1, ?2, ?3, ?4, 'scan')",
            params![e.id, at, bytes as i64, d.total_files as i64],
        )?;
        if let Some(limit) = e.limit_bytes {
            // One alert per "episode" over the limit: also when the location
            // was already over it when it was added, never repeated until it
            // has been back under the limit.
            let last_under: i64 = conn
                .query_row("SELECT COALESCE(MAX(at), 0) FROM watch_history WHERE watch_id = ?1 AND bytes <= ?2 AND at < ?3", params![e.id, limit as i64, at], |r| r.get(0))?;
            let alerted: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM watch_alerts WHERE watch_id = ?1 AND kind = 'limit' AND at >= ?2)", params![e.id, last_under], |r| r.get(0))?;
            if bytes > limit && !alerted {
                raise("limit", format!("{} is over its {} limit ({}).", e.label, human_size(limit), human_size(bytes)), Some(bytes))?;
            }
        }
        if let Some(p) = prev {
            let delta = bytes as i64 - p as i64;
            let by_bytes = e.growth_bytes.is_some_and(|g| delta >= g as i64);
            let by_pct = e.growth_pct.is_some_and(|pct| p > 0 && delta >= PCT_FLOOR && delta as f64 >= p as f64 * pct / 100.0);
            if delta > 0 && (by_bytes || by_pct) {
                raise("growth", format!("{} grew by {} since the previous scan ({} → {}).", e.label, human_size(delta as u64), human_size(p), human_size(bytes)), Some(bytes))?;
            }
        }
    }
    Ok(alerts(conn, 500)?.into_iter().filter(|a| new_ids.contains(&a.id)).collect())
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
        crate::timeline::init(&c).unwrap();
        init(&c).unwrap();
        c
    }

    fn idx(root: &Path) -> ScanIndex {
        scan(&ScanOptions { roots: vec![root.into()], exclusions: vec![], skip_system: false }, &AtomicBool::new(false), &Progress::default())
    }

    #[test]
    fn limits_growth_and_missing() {
        let t = tempfile::tempdir().unwrap();
        let dl = t.path().join("Downloads");
        fs::create_dir_all(&dl).unwrap();
        fs::write(dl.join("a.bin"), vec![0u8; 1000]).unwrap();
        let c = db();
        let rules = WatchRules { limit_bytes: Some(3000), growth_bytes: Some(1500), notify: true, ..Default::default() };
        let id = add(&c, &dl, &rules, 1).unwrap();
        // A location on another drive is not part of this scan: ignored.
        add(&c, Path::new(r"Z:\Elsewhere"), &WatchRules::default(), 1).unwrap();

        assert!(evaluate(&c, &idx(t.path()), 100).unwrap().is_empty()); // first point, no baseline
        fs::write(dl.join("b.bin"), vec![0u8; 2500]).unwrap();
        let a = evaluate(&c, &idx(t.path()), 200).unwrap();
        let kinds: Vec<&str> = a.iter().map(|a| a.kind.as_str()).collect();
        assert_eq!(kinds.len(), 2, "{kinds:?}");
        assert!(kinds.contains(&"limit") && kinds.contains(&"growth"));
        // Still over the limit, no new growth: no repeated alert.
        assert!(evaluate(&c, &idx(t.path()), 300).unwrap().is_empty());

        fs::remove_dir_all(&dl).unwrap();
        let m = evaluate(&c, &idx(t.path()), 400).unwrap();
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].kind, "missing");
        assert!(evaluate(&c, &idx(t.path()), 500).unwrap().is_empty()); // reported once

        // Added while already over its limit: alerted once on the next scan.
        let over = t.path().join("Over");
        fs::create_dir_all(&over).unwrap();
        fs::write(over.join("x.bin"), vec![0u8; 5000]).unwrap();
        let oid = add(&c, &over, &WatchRules { limit_bytes: Some(1000), ..Default::default() }, 1).unwrap();
        let first = evaluate(&c, &idx(t.path()), 600).unwrap();
        assert_eq!(first.iter().filter(|a| a.watch_id == oid && a.kind == "limit").count(), 1);
        assert!(evaluate(&c, &idx(t.path()), 700).unwrap().iter().all(|a| a.watch_id != oid));
        remove(&c, oid).unwrap();

        set_paused(&c, id, true).unwrap();
        let e = list(&c).unwrap();
        assert!(e[0].paused);
        assert_eq!(e[0].history.len(), 3);
        assert_eq!(e.iter().find(|x| x.path.starts_with("Z:")).unwrap().history.len(), 0);
        mark_seen(&c, &[]).unwrap();
        assert_eq!(list(&c).unwrap()[0].unseen_alerts, 0);
        remove(&c, id).unwrap();
        assert_eq!(alerts(&c, 10).unwrap().len(), 0);
    }
}
