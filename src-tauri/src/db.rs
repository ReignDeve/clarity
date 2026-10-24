//! Local SQLite store: settings, scan history, cleanup history.

use crate::cleanup::ItemOutcome;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub theme: String, // "system" | "dark" | "light"
    pub motion: String, // "system" | "reduced" | "full"
    pub old_days: i64,
    pub large_mb: u64,
    pub dup_min_kb: u64,
    pub skip_system: bool,
    pub exclusions: Vec<String>,
    pub onboarded: bool,
    pub last_roots: Vec<String>,
    pub show_hidden: bool,
    /// Download updates in the background and offer "Restart to update".
    pub auto_update: bool,
    /// Anonymous, persistent id sent with update checks (staged rollouts).
    pub device_id: String,
    /// Settings schema revision, for one-off migrations of old defaults.
    #[serde(default)]
    pub rev: u32,
}

pub const SETTINGS_REV: u32 = 1;

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            motion: "system".into(),
            old_days: 365,
            large_mb: 500,
            dup_min_kb: 10 * 1024,
            skip_system: true,
            exclusions: vec![],
            onboarded: false,
            last_roots: vec![],
            show_hidden: true,
            auto_update: true,
            device_id: String::new(),
            rev: SETTINGS_REV,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRecord {
    pub id: i64,
    pub started_at: i64,
    pub duration_ms: i64,
    pub roots: Vec<String>,
    pub files: i64,
    pub bytes: i64,
    pub errors: i64,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupRun {
    pub id: i64,
    pub at: i64,
    pub mode: String,
    pub requested: i64,
    pub succeeded: i64,
    pub failed: i64,
    pub skipped: i64,
    pub bytes_removed: i64,
    pub bytes_freed: i64,
    pub items: Vec<CleanupItemRow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupItemRow {
    pub path: String,
    pub size: i64,
    pub status: String,
    pub error: Option<String>,
}

pub struct Db {
    conn: Connection,
}

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    pub fn in_memory() -> rusqlite::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> rusqlite::Result<Self> {
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS scans (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                started_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
                roots TEXT NOT NULL, files INTEGER NOT NULL, bytes INTEGER NOT NULL,
                errors INTEGER NOT NULL, cancelled INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS cleanup_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                at INTEGER NOT NULL, mode TEXT NOT NULL,
                requested INTEGER NOT NULL, succeeded INTEGER NOT NULL, failed INTEGER NOT NULL, skipped INTEGER NOT NULL,
                bytes_removed INTEGER NOT NULL, bytes_freed INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS cleanup_items (
                run_id INTEGER NOT NULL REFERENCES cleanup_runs(id) ON DELETE CASCADE,
                path TEXT NOT NULL, size INTEGER NOT NULL, status TEXT NOT NULL, error TEXT);
             CREATE INDEX IF NOT EXISTS cleanup_items_run ON cleanup_items(run_id);",
        )?;
        crate::timeline::init(&conn)?;
        crate::media::init(&conn)?;
        crate::watch::init(&conn)?;
        crate::organizer::init(&conn)?;
        crate::timeline::import_legacy(&conn)?;
        Ok(Self { conn })
    }

    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    pub fn conn_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }

    pub fn settings(&self) -> Settings {
        let mut s: Settings = self
            .conn
            .query_row("SELECT json FROM settings WHERE id = 1", [], |r| r.get::<_, String>(0))
            .ok()
            .and_then(|j| serde_json::from_str(&j).ok())
            .unwrap_or_default();
        if s.rev < 1 {
            // Rev 1: the duplicate threshold default went from 1 MB to 10 MB.
            if s.dup_min_kb == 1024 {
                s.dup_min_kb = 10 * 1024;
            }
            s.rev = SETTINGS_REV;
            let _ = self.save_settings(&s);
        }
        s
    }

    pub fn save_settings(&self, s: &Settings) -> rusqlite::Result<()> {
        let json = serde_json::to_string(s).expect("settings serialize");
        self.conn.execute("INSERT INTO settings (id, json) VALUES (1, ?1) ON CONFLICT(id) DO UPDATE SET json = excluded.json", params![json])?;
        Ok(())
    }

    pub fn add_scan(&self, r: &ScanRecord) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO scans (started_at, duration_ms, roots, files, bytes, errors, cancelled) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![r.started_at, r.duration_ms, serde_json::to_string(&r.roots).unwrap(), r.files, r.bytes, r.errors, r.cancelled],
        )?;
        Ok(())
    }

    pub fn scans(&self, limit: i64) -> rusqlite::Result<Vec<ScanRecord>> {
        let mut st = self.conn.prepare("SELECT id, started_at, duration_ms, roots, files, bytes, errors, cancelled FROM scans ORDER BY id DESC LIMIT ?1")?;
        let rows = st.query_map(params![limit], |r| {
            Ok(ScanRecord {
                id: r.get(0)?,
                started_at: r.get(1)?,
                duration_ms: r.get(2)?,
                roots: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or_default(),
                files: r.get(4)?,
                bytes: r.get(5)?,
                errors: r.get(6)?,
                cancelled: r.get(7)?,
            })
        })?;
        rows.collect()
    }

    pub fn add_cleanup(&mut self, at: i64, mode: &str, outcomes: &[ItemOutcome]) -> rusqlite::Result<i64> {
        let tx = self.conn.transaction()?;
        let count = |s: &str| outcomes.iter().filter(|o| o.status == s).count() as i64;
        let removed: u64 = outcomes.iter().filter(|o| matches!(o.status, "recycled" | "deleted" | "moved")).map(|o| o.size).sum();
        let freed: u64 = outcomes.iter().map(|o| o.freed).sum();
        tx.execute(
            "INSERT INTO cleanup_runs (at, mode, requested, succeeded, failed, skipped, bytes_removed, bytes_freed) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![at, mode, outcomes.len() as i64, count("recycled") + count("deleted") + count("moved"), count("failed"), count("skipped"), removed as i64, freed as i64],
        )?;
        let id = tx.last_insert_rowid();
        {
            let mut st = tx.prepare("INSERT INTO cleanup_items (run_id, path, size, status, error) VALUES (?1, ?2, ?3, ?4, ?5)")?;
            for o in outcomes {
                st.execute(params![id, o.path, o.size as i64, o.status, o.error])?;
            }
        }
        tx.commit()?;
        Ok(id)
    }

    pub fn cleanups(&self, limit: i64) -> rusqlite::Result<Vec<CleanupRun>> {
        let mut st = self.conn.prepare("SELECT id, at, mode, requested, succeeded, failed, skipped, bytes_removed, bytes_freed FROM cleanup_runs ORDER BY id DESC LIMIT ?1")?;
        let runs: Vec<CleanupRun> = st
            .query_map(params![limit], |r| {
                Ok(CleanupRun {
                    id: r.get(0)?,
                    at: r.get(1)?,
                    mode: r.get(2)?,
                    requested: r.get(3)?,
                    succeeded: r.get(4)?,
                    failed: r.get(5)?,
                    skipped: r.get(6)?,
                    bytes_removed: r.get(7)?,
                    bytes_freed: r.get(8)?,
                    items: vec![],
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        let mut items = self.conn.prepare("SELECT path, size, status, error FROM cleanup_items WHERE run_id = ?1 LIMIT 500")?;
        runs.into_iter()
            .map(|mut run| {
                run.items = items
                    .query_map(params![run.id], |r| Ok(CleanupItemRow { path: r.get(0)?, size: r.get(1)?, status: r.get(2)?, error: r.get(3)? }))?
                    .collect::<rusqlite::Result<_>>()?;
                Ok(run)
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cleanup::{ItemKind, ItemRef};

    #[test]
    fn settings_roundtrip_and_history() {
        let mut db = Db::in_memory().unwrap();
        assert_eq!(db.settings().old_days, 365);
        // A pre-rev save with the old 1 MB default is migrated to 10 MB.
        db.conn.execute("INSERT OR REPLACE INTO settings (id, json) VALUES (1, '{\"dupMinKb\":1024,\"oldDays\":200}')", []).unwrap();
        let migrated = db.settings();
        assert_eq!((migrated.dup_min_kb, migrated.old_days, migrated.rev), (10240, 200, SETTINGS_REV));
        let mut s = Settings::default();
        s.old_days = 90;
        s.exclusions = vec!["D:\\VMs".into()];
        db.save_settings(&s).unwrap();
        assert_eq!(db.settings().old_days, 90);

        let o = |status: &'static str, size, freed| ItemOutcome { item: ItemRef { kind: ItemKind::File, id: 0 }, path: "C:\\x".into(), size, freed, status, error: None };
        db.add_cleanup(1, "recycle", &[o("recycled", 100, 0), o("failed", 50, 0), o("skipped", 10, 0)]).unwrap();
        let runs = db.cleanups(10).unwrap();
        assert_eq!(runs[0].succeeded, 1);
        assert_eq!(runs[0].failed, 1);
        assert_eq!(runs[0].bytes_removed, 100);
        assert_eq!(runs[0].items.len(), 3);
    }
}
