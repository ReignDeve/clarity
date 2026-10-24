//! Moving files (typically a file plus its related files) to another folder.
//!
//! Same rules as cleanup: items come from the scan index by id, are checked
//! against the live filesystem right before the move, and nothing is ever
//! overwritten. Moves across drives copy, verify the size, and only then
//! remove the original.

use crate::cleanup::{check_item, friendly_error, ItemKind, ItemRef, Mode};
use crate::model::ScanIndex;
use crate::paths::{is_plain_absolute, normalize};
use crate::protect::Protector;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveStep {
    pub id: u32,
    pub name: String,
    pub from: String,
    pub to: String,
    pub size: u64,
    pub ok: bool,
    pub blocked: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MovePlan {
    pub destination: String,
    pub steps: Vec<MoveStep>,
    pub movable: usize,
    pub bytes: u64,
    pub cross_drive: bool,
    pub error: Option<String>,
}

fn drive_of(p: &Path) -> String {
    normalize(p).chars().take(2).collect()
}

pub fn plan(index: &ScanIndex, ids: &[u32], dest: &Path, protector: &Protector) -> MovePlan {
    let destination = dest.display().to_string();
    let fail = |e: String| MovePlan { destination: destination.clone(), steps: vec![], movable: 0, bytes: 0, cross_drive: false, error: Some(e) };
    if !is_plain_absolute(dest) || !dest.is_dir() {
        return fail("The destination is not an existing folder.".into());
    }
    if let Some(why) = protector.check_destination(dest) {
        return fail(why);
    }
    if let Ok(md) = fs::symlink_metadata(dest) {
        if md.file_type().is_symlink() {
            return fail("The destination is a link to another location.".into());
        }
    }
    let mut seen_names = std::collections::HashSet::new();
    let mut steps = Vec::new();
    let mut ids: Vec<u32> = ids.to_vec();
    ids.dedup();
    for id in ids {
        let check = check_item(index, ItemRef { kind: ItemKind::File, id }, protector, Mode::Permanent);
        let from = PathBuf::from(&check.path);
        let name = check.name.clone();
        let to = dest.join(&name);
        let mut blocked = check.blocked.clone();
        if blocked.is_none() && from.parent().map(normalize) == Some(normalize(dest)) {
            blocked = Some("Already in this folder.".into());
        }
        if blocked.is_none() && fs::symlink_metadata(&to).is_ok() {
            blocked = Some("A file with this name already exists there. CLARITY never overwrites files.".into());
        }
        if blocked.is_none() && !seen_names.insert(name.to_lowercase()) {
            blocked = Some("Another selected file has the same name.".into());
        }
        steps.push(MoveStep { id, name, from: check.path, to: to.display().to_string(), size: check.size, ok: blocked.is_none(), blocked });
    }
    let cross_drive = steps.iter().any(|s| drive_of(Path::new(&s.from)) != drive_of(dest));
    MovePlan {
        movable: steps.iter().filter(|s| s.ok).count(),
        bytes: steps.iter().filter(|s| s.ok).map(|s| s.size).sum(),
        destination,
        steps,
        cross_drive,
        error: None,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveOutcome {
    pub id: u32,
    pub from: String,
    pub to: String,
    pub size: u64,
    pub status: &'static str, // "moved" | "skipped" | "failed"
    pub error: Option<String>,
}

fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    match crate::platform::rename_no_replace(from, to) {
        Ok(()) => Ok(()),
        // ERROR_NOT_SAME_DEVICE: copy, verify, then remove the original.
        Err(e) if e.raw_os_error() == Some(17) => {
            let want = fs::metadata(from).map_err(|e| e.to_string())?.len();
            fs::copy(from, to).map_err(|e| e.to_string())?;
            let got = fs::metadata(to).map(|m| m.len()).unwrap_or(0);
            if got != want {
                let _ = fs::remove_file(to);
                return Err("The copy did not match the original; the original was kept.".into());
            }
            fs::remove_file(from).map_err(|e| format!("Copied, but the original could not be removed: {e}"))
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Re-plans and executes. Updates the index for moved files.
pub fn execute(index: &mut ScanIndex, ids: &[u32], dest: &Path, protector: &Protector) -> Result<Vec<MoveOutcome>, String> {
    let p = plan(index, ids, dest, protector);
    if let Some(e) = p.error {
        return Err(e);
    }
    let mut out = Vec::new();
    for s in p.steps {
        if !s.ok {
            out.push(MoveOutcome { id: s.id, from: s.from, to: s.to, size: s.size, status: "skipped", error: s.blocked });
            continue;
        }
        // Last-moment re-check for this single item.
        let again = plan(index, &[s.id], dest, protector);
        if let Some(st) = again.steps.first().filter(|st| !st.ok) {
            out.push(MoveOutcome { id: s.id, from: s.from, to: s.to, size: s.size, status: "skipped", error: st.blocked.clone() });
            continue;
        }
        match move_file(Path::new(&s.from), Path::new(&s.to)) {
            Ok(()) if Path::new(&s.to).exists() && fs::symlink_metadata(&s.from).is_err() => {
                index.mark_file_removed(s.id);
                out.push(MoveOutcome { id: s.id, from: s.from, to: s.to, size: s.size, status: "moved", error: None });
            }
            Ok(()) => out.push(MoveOutcome { id: s.id, from: s.from, to: s.to, size: s.size, status: "failed", error: Some("The move could not be verified.".into()) }),
            Err(e) => out.push(MoveOutcome { id: s.id, from: s.from, to: s.to, size: s.size, status: "failed", error: Some(friendly_error(&e)) }),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scan::{scan, Progress, ScanOptions};
    use std::sync::atomic::AtomicBool;

    #[test]
    fn moves_together_without_overwriting() {
        let t = tempfile::tempdir().unwrap();
        let src = t.path().join("src");
        let dst = t.path().join("dst");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dst).unwrap();
        fs::write(src.join("film.mkv"), b"video").unwrap();
        fs::write(src.join("film.srt"), b"subs").unwrap();
        fs::write(src.join("taken.txt"), b"a").unwrap();
        fs::write(dst.join("taken.txt"), b"existing").unwrap();
        let mut idx = scan(&ScanOptions { roots: vec![t.path().into()], exclusions: vec![], skip_system: false }, &AtomicBool::new(false), &Progress::default());
        let id = |n: &str| idx.files.iter().position(|f| &*f.name == n && idx.dir_path(f.dir).ends_with("src")).unwrap() as u32;
        let ids = [id("film.mkv"), id("film.srt"), id("taken.txt")];
        let prot = Protector::new(vec![], vec![]);
        let p = plan(&idx, &ids, &dst, &prot);
        assert_eq!(p.movable, 2);
        assert!(p.steps[2].blocked.as_deref().unwrap().contains("already exists"));

        let out = execute(&mut idx, &ids, &dst, &prot).unwrap();
        assert_eq!(out.iter().filter(|o| o.status == "moved").count(), 2);
        assert!(dst.join("film.mkv").exists() && dst.join("film.srt").exists());
        assert!(!src.join("film.mkv").exists());
        assert_eq!(fs::read(dst.join("taken.txt")).unwrap(), b"existing");
        assert!(src.join("taken.txt").exists());
    }

    #[test]
    fn refuses_protected_destinations() {
        let t = tempfile::tempdir().unwrap();
        fs::create_dir_all(t.path().join("sys")).unwrap();
        fs::write(t.path().join("a.txt"), b"a").unwrap();
        let idx = scan(&ScanOptions { roots: vec![t.path().into()], exclusions: vec![], skip_system: false }, &AtomicBool::new(false), &Progress::default());
        let prot = Protector::new(vec![t.path().join("sys")], vec![]);
        let p = plan(&idx, &[0], &t.path().join("sys"), &prot);
        assert!(p.error.is_some());
        assert!(plan(&idx, &[0], &t.path().join("missing"), &prot).error.is_some());
    }
}
