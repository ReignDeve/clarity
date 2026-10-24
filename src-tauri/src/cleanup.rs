//! Validation and execution of user-initiated removals.
//!
//! Nothing is removed unless *all* of the following hold at the moment of
//! removal:
//! - the item comes from the current scan index (ids, never raw paths from
//!   the UI), so it lies inside a folder the user chose to scan
//! - it is not in a protected location (see `protect`)
//! - it still exists, has the same type, and (for files) the same size and
//!   modification time as when it was scanned
//! - neither it nor any parent folder is a link that redirects elsewhere
//!   (the canonical path must equal the scanned path)
//! - for Recycle Bin mode, the drive actually has a Recycle Bin

use crate::model::{flags, ScanIndex};
use crate::paths::{is_plain_absolute, is_same_or_under, normalize};
use crate::platform::{self, DriveKind};
use crate::protect::Protector;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ItemKind {
    File,
    Dir,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub struct ItemRef {
    pub kind: ItemKind,
    pub id: u32,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Recycle,
    Permanent,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemCheck {
    pub item: ItemRef,
    pub path: String,
    pub name: String,
    pub size: u64,
    /// Bytes that would become free on the drive once the data is gone for
    /// good (after emptying the Recycle Bin in recycle mode).
    pub freeable: u64,
    pub ok: bool,
    pub blocked: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemOutcome {
    pub item: ItemRef,
    pub path: String,
    pub size: u64,
    pub freed: u64,
    pub status: &'static str, // "recycled" | "deleted" | "skipped" | "failed"
    pub error: Option<String>,
}

fn cloud_roots() -> Vec<String> {
    ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]
        .iter()
        .filter_map(|k| std::env::var_os(k))
        .map(|p| normalize(Path::new(&p)))
        .collect()
}

fn blocked(item: ItemRef, path: String, name: String, size: u64, why: impl Into<String>) -> ItemCheck {
    ItemCheck { item, path, name, size, freeable: 0, ok: false, blocked: Some(why.into()), warnings: vec![] }
}

pub fn check_item(index: &ScanIndex, item: ItemRef, protector: &Protector, mode: Mode) -> ItemCheck {
    let (path, name, size, rec_flags, rec_mtime) = match item.kind {
        ItemKind::File => {
            let Some(f) = index.files.get(item.id as usize) else {
                return blocked(item, String::new(), String::new(), 0, "Unknown item. Please rescan.");
            };
            (index.file_path(item.id), f.name.to_string(), f.size, f.flags, Some(f.modified))
        }
        ItemKind::Dir => {
            let Some(d) = index.dirs.get(item.id as usize) else {
                return blocked(item, String::new(), String::new(), 0, "Unknown item. Please rescan.");
            };
            if d.parent == crate::model::NONE {
                return blocked(item, index.dir_path(item.id).display().to_string(), d.name.to_string(), d.total_size, "Scanned root folders cannot be removed from within CLARITY.");
            }
            (index.dir_path(item.id), d.name.to_string(), d.total_size, d.flags, None)
        }
    };
    let path_s = path.display().to_string();
    if rec_flags & flags::REMOVED != 0 {
        return blocked(item, path_s, name, size, "Already removed.");
    }
    if !is_plain_absolute(&path) {
        return blocked(item, path_s, name, size, "Invalid path.");
    }
    if let Some(why) = protector.check(&path, item.kind == ItemKind::Dir) {
        return blocked(item, path_s, name, size, why);
    }
    if rec_flags & flags::SYSTEM != 0 {
        return blocked(item, path_s, name, size, "Marked as a Windows system item.");
    }

    // Live state.
    let md = match fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) => return blocked(item, path_s, name, size, format!("No longer accessible: {e}")),
    };
    let attrs = platform::attrs_of(&md);
    let cloud = platform::is_cloud_placeholder(attrs);
    if md.file_type().is_symlink() {
        return blocked(item, path_s, name, size, "This location is now a link. Please rescan.");
    }
    if md.is_dir() != (item.kind == ItemKind::Dir) {
        return blocked(item, path_s, name, size, "The item changed type since the scan. Please rescan.");
    }
    if item.kind == ItemKind::File {
        let (_, mtime, _) = platform::times_of(&md);
        if md.len() != size || Some(mtime) != rec_mtime {
            return blocked(item, path_s, name, size, "The file changed since the scan. Please rescan before removing it.");
        }
    }
    match fs::canonicalize(&path) {
        Ok(c) if normalize(&c) == normalize(&path) => {}
        Ok(_) => return blocked(item, path_s, name, size, "A parent folder is now a link to another location. Please rescan."),
        Err(e) => return blocked(item, path_s, name, size, format!("Cannot resolve location: {e}")),
    }
    let drive = platform::drive_kind(&path);
    if mode == Mode::Recycle && drive != DriveKind::Fixed {
        return blocked(item, path_s, name, size, "This drive has no Recycle Bin. Only permanent deletion is possible here.");
    }

    let mut warnings = Vec::new();
    let mut freeable = size;
    let norm = normalize(&path);
    if cloud {
        freeable = 0;
        warnings.push("Cloud-only file: it uses no local space, and removing it may also delete it from your cloud storage and other devices.".into());
    } else if cloud_roots().iter().any(|r| is_same_or_under(&norm, r)) {
        warnings.push("Synced with OneDrive: removing it here also removes it from OneDrive and your other devices.".into());
    }
    if rec_flags & flags::READONLY != 0 {
        warnings.push("Marked read-only.".into());
    }
    if item.kind == ItemKind::File && !cloud {
        if let Ok((_, _, links)) = platform::file_identity(&path) {
            if links > 1 {
                freeable = 0;
                warnings.push(format!("This file has {links} hard links. The space is only freed once every link is removed."));
            }
        }
        if freeable > 0 {
            if let Some(disk) = platform::on_disk_size(&path) {
                freeable = disk;
            }
        }
    }
    if item.kind == ItemKind::Dir && path.join(".git").exists() {
        warnings.push("Contains a Git repository. Make sure all work is pushed or backed up.".into());
    }
    ItemCheck { item, path: path_s, name, size, freeable, ok: true, blocked: None, warnings }
}

fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

/// Validate and remove one item. Updates the index on success.
pub fn execute_one(index: &mut ScanIndex, item: ItemRef, protector: &Protector, mode: Mode) -> ItemOutcome {
    let check = check_item(index, item, protector, mode);
    let path = PathBuf::from(&check.path);
    if !check.ok {
        return ItemOutcome { item, path: check.path, size: check.size, freed: 0, status: "skipped", error: check.blocked };
    }
    let result: Result<(), String> = match (mode, item.kind) {
        (Mode::Recycle, _) => trash::delete(&path).map_err(|e| e.to_string()),
        (Mode::Permanent, ItemKind::File) => fs::remove_file(&path).map_err(|e| e.to_string()),
        // remove_dir_all does not follow links inside the tree.
        (Mode::Permanent, ItemKind::Dir) => fs::remove_dir_all(&path).map_err(|e| e.to_string()),
    };
    let gone = !exists(&path);
    match (result, gone) {
        (Ok(()), true) => {
            match item.kind {
                ItemKind::File => index.mark_file_removed(item.id),
                ItemKind::Dir => index.mark_dir_removed(item.id),
            }
            ItemOutcome {
                item,
                path: check.path,
                size: check.size,
                freed: if mode == Mode::Permanent { check.freeable } else { 0 },
                status: if mode == Mode::Recycle { "recycled" } else { "deleted" },
                error: None,
            }
        }
        (Ok(()), false) => ItemOutcome { item, path: check.path, size: check.size, freed: 0, status: "failed", error: Some("The operation reported success, but the item still exists.".into()) },
        (Err(e), _) => ItemOutcome { item, path: check.path, size: check.size, freed: 0, status: "failed", error: Some(friendly_error(&e)) },
    }
}

pub fn friendly_error(e: &str) -> String {
    let l = e.to_lowercase();
    if l.contains("os error 32") || l.contains("being used by another process") {
        "The file is open in another program. Close it and try again.".into()
    } else if l.contains("os error 5") || l.contains("access is denied") {
        "Windows denied access to this item.".into()
    } else {
        e.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scan::{scan, Progress, ScanOptions};
    use std::sync::atomic::AtomicBool;

    fn index_of(root: &Path) -> ScanIndex {
        scan(
            &ScanOptions { roots: vec![root.to_path_buf()], exclusions: vec![], skip_system: false },
            &AtomicBool::new(false),
            &Progress::default(),
        )
    }

    fn file_id(idx: &ScanIndex, name: &str) -> u32 {
        idx.files.iter().position(|f| &*f.name == name).unwrap() as u32
    }

    fn open() -> Protector {
        Protector::new(vec![], vec![])
    }

    #[test]
    fn deletes_exactly_the_selected_file() {
        let t = tempfile::tempdir().unwrap();
        fs::write(t.path().join("victim.bin"), b"12345").unwrap();
        fs::write(t.path().join("bystander.bin"), b"12345").unwrap();
        let mut idx = index_of(t.path());
        let before = idx.total_bytes();
        let id = file_id(&idx, "victim.bin");
        let out = execute_one(&mut idx, ItemRef { kind: ItemKind::File, id }, &open(), Mode::Permanent);
        assert_eq!(out.status, "deleted", "{:?}", out.error);
        assert!(!t.path().join("victim.bin").exists());
        assert!(t.path().join("bystander.bin").exists());
        assert_eq!(idx.total_bytes(), before - 5);
        // A second attempt is refused.
        let again = execute_one(&mut idx, ItemRef { kind: ItemKind::File, id }, &open(), Mode::Permanent);
        assert_eq!(again.status, "skipped");
    }

    #[test]
    fn refuses_files_changed_since_scan() {
        let t = tempfile::tempdir().unwrap();
        fs::write(t.path().join("f.txt"), b"old").unwrap();
        let idx = index_of(t.path());
        fs::write(t.path().join("f.txt"), b"new and longer").unwrap();
        let c = check_item(&idx, ItemRef { kind: ItemKind::File, id: file_id(&idx, "f.txt") }, &open(), Mode::Permanent);
        assert!(!c.ok);
        assert!(c.blocked.unwrap().contains("changed"));
    }

    #[test]
    fn refuses_missing_and_retyped_items() {
        let t = tempfile::tempdir().unwrap();
        fs::write(t.path().join("gone.txt"), b"x").unwrap();
        fs::write(t.path().join("swap"), b"x").unwrap();
        let idx = index_of(t.path());
        fs::remove_file(t.path().join("gone.txt")).unwrap();
        fs::remove_file(t.path().join("swap")).unwrap();
        fs::create_dir(t.path().join("swap")).unwrap();
        for name in ["gone.txt", "swap"] {
            let c = check_item(&idx, ItemRef { kind: ItemKind::File, id: file_id(&idx, name) }, &open(), Mode::Permanent);
            assert!(!c.ok, "{name} should be blocked");
        }
    }

    #[test]
    fn refuses_roots_protected_and_unknown_ids() {
        let t = tempfile::tempdir().unwrap();
        fs::create_dir(t.path().join("keep")).unwrap();
        fs::write(t.path().join("keep/a.txt"), b"x").unwrap();
        let idx = index_of(t.path());
        let root = idx.roots[0];
        assert!(!check_item(&idx, ItemRef { kind: ItemKind::Dir, id: root }, &open(), Mode::Permanent).ok);
        assert!(!check_item(&idx, ItemRef { kind: ItemKind::File, id: 9999 }, &open(), Mode::Permanent).ok);
        let prot = Protector::new(vec![t.path().join("keep")], vec![]);
        let c = check_item(&idx, ItemRef { kind: ItemKind::File, id: file_id(&idx, "a.txt") }, &prot, Mode::Permanent);
        assert!(!c.ok);
    }

    #[test]
    fn removes_directories_and_updates_index() {
        let t = tempfile::tempdir().unwrap();
        fs::create_dir_all(t.path().join("old/nested")).unwrap();
        fs::write(t.path().join("old/nested/a.bin"), vec![0u8; 300]).unwrap();
        fs::write(t.path().join("stay.bin"), vec![0u8; 7]).unwrap();
        let mut idx = index_of(t.path());
        let d = idx.find_dir(&t.path().join("old")).unwrap();
        let out = execute_one(&mut idx, ItemRef { kind: ItemKind::Dir, id: d }, &open(), Mode::Permanent);
        assert_eq!(out.status, "deleted", "{:?}", out.error);
        assert_eq!(idx.total_bytes(), 7);
        assert!(t.path().join("stay.bin").exists());
    }

    #[cfg(windows)]
    #[test]
    fn refuses_when_parent_became_a_junction() {
        let t = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(t.path().join("dir")).unwrap();
        fs::write(t.path().join("dir/f.txt"), b"abc").unwrap();
        fs::write(outside.path().join("f.txt"), b"abc").unwrap();
        let idx = index_of(t.path());
        let id = file_id(&idx, "f.txt");
        // Swap the scanned folder for a junction to another location.
        fs::remove_dir_all(t.path().join("dir")).unwrap();
        let ok = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(t.path().join("dir")).arg(outside.path()).output().unwrap();
        assert!(ok.status.success());
        // Same size; align mtime so only the link check can catch it.
        let c = check_item(&idx, ItemRef { kind: ItemKind::File, id }, &open(), Mode::Permanent);
        assert!(!c.ok);
        assert!(outside.path().join("f.txt").exists());
    }
}
