//! Parallel, level-synchronous breadth-first scanner.
//!
//! Each level of the tree is listed in parallel (rayon); results are then
//! appended sequentially so ids stay deterministic and children stay
//! contiguous. Reparse points that redirect elsewhere (symbolic links,
//! junctions, volume mount points) are never followed, which rules out
//! traversal loops and keeps the scan inside the folders the user picked.

use crate::model::{flags, Category, DirRec, FileRec, ScanIndex, ScanIssue, NONE};
use crate::paths;
use crate::platform::{self, attrs_of, times_of};
use parking_lot::Mutex;
use rayon::prelude::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;

const MAX_STORED_ISSUES: usize = 400;

#[derive(Default)]
pub struct Progress {
    pub files: AtomicU64,
    pub dirs: AtomicU64,
    pub bytes: AtomicU64,
    pub errors: AtomicU64,
    pub current: Mutex<String>,
}

pub struct ScanOptions {
    pub roots: Vec<PathBuf>,
    /// Normalized (see `paths::normalize`) absolute paths that are skipped.
    pub exclusions: Vec<String>,
    /// Skip `\Windows`, `$Recycle.Bin`, `System Volume Information` etc.
    pub skip_system: bool,
}

/// Directory names skipped directly below a drive root when `skip_system` is set.
const SYSTEM_ROOT_DIRS: &[&str] = &[
    "windows",
    "$recycle.bin",
    "system volume information",
    "recovery",
    "$winreagent",
    "$windows.~bt",
    "$windows.~ws",
    "config.msi",
];

struct Listing {
    files: Vec<FileRec>,
    dirs: Vec<(Box<str>, i64, u8)>,
    links: u64,
    excluded: u64,
    issues: Vec<ScanIssue>,
}

/// Remove duplicates and roots nested inside other roots.
pub fn dedupe_roots(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut norm: Vec<(String, PathBuf)> = roots
        .iter()
        .map(|r| (paths::normalize(r), r.clone()))
        .collect();
    norm.sort_by(|a, b| a.0.len().cmp(&b.0.len()));
    let mut kept: Vec<(String, PathBuf)> = Vec::new();
    for (n, p) in norm {
        if !kept.iter().any(|(k, _)| paths::is_same_or_under(&n, k)) {
            kept.push((n, p));
        }
    }
    kept.into_iter().map(|(_, p)| p).collect()
}

fn is_drive_root(norm: &str) -> bool {
    norm.len() == 3 && norm.ends_with(":\\")
}

fn list_dir(path: &Path, opts: &ScanOptions, cancel: &AtomicBool, progress: &Progress) -> Result<Listing, String> {
    let rd = fs::read_dir(path).map_err(|e| e.to_string())?;
    let norm = paths::normalize(path);
    let at_drive_root = is_drive_root(&norm);
    let mut out = Listing { files: Vec::new(), dirs: Vec::new(), links: 0, excluded: 0, issues: Vec::new() };
    let mut bytes = 0u64;
    for (i, entry) in rd.enumerate() {
        if i % 512 == 0 && cancel.load(Ordering::Relaxed) {
            break;
        }
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                out.issues.push(ScanIssue { path: path.display().to_string(), message: e.to_string() });
                continue;
            }
        };
        let name_os = entry.file_name();
        let name = name_os.to_string_lossy();
        // On Windows, DirEntry::metadata comes from the directory listing
        // itself and does not follow reparse points.
        let md = match entry.metadata() {
            Ok(m) => m,
            Err(e) => {
                out.issues.push(ScanIssue { path: path.join(&name_os).display().to_string(), message: e.to_string() });
                continue;
            }
        };
        if md.file_type().is_symlink() {
            out.links += 1;
            continue;
        }
        let attrs = attrs_of(&md);
        let mut fl = 0u8;
        if attrs & platform::ATTR_HIDDEN != 0 {
            fl |= flags::HIDDEN;
        }
        if attrs & platform::ATTR_SYSTEM != 0 {
            fl |= flags::SYSTEM;
        }
        if attrs & platform::ATTR_READONLY != 0 {
            fl |= flags::READONLY;
        }
        if platform::is_cloud_placeholder(attrs) {
            fl |= flags::CLOUD;
        }
        let (created, modified, accessed) = times_of(&md);
        if md.is_dir() {
            let lname = name.to_lowercase();
            if opts.skip_system && at_drive_root && SYSTEM_ROOT_DIRS.contains(&lname.as_str()) {
                out.excluded += 1;
                continue;
            }
            if !opts.exclusions.is_empty() {
                let child = paths::normalize(&path.join(&name_os));
                if opts.exclusions.iter().any(|ex| paths::is_same_or_under(&child, ex)) {
                    out.excluded += 1;
                    continue;
                }
            }
            out.dirs.push((name.into(), modified, fl));
        } else {
            let size = md.len();
            bytes += size;
            out.files.push(FileRec {
                dir: NONE,
                cat: Category::from_name(&name),
                name: name.into(),
                size,
                created,
                modified,
                accessed,
                flags: fl,
            });
        }
    }
    progress.files.fetch_add(out.files.len() as u64, Ordering::Relaxed);
    progress.dirs.fetch_add(1, Ordering::Relaxed);
    progress.bytes.fetch_add(bytes, Ordering::Relaxed);
    if let Some(mut cur) = progress.current.try_lock() {
        *cur = path.display().to_string();
    }
    Ok(out)
}

pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Scan the given roots. Always returns an index; on cancellation it is
/// partial and flagged `cancelled`.
pub fn scan(opts: &ScanOptions, cancel: &AtomicBool, progress: &Progress) -> ScanIndex {
    let started = Instant::now();
    let mut index = ScanIndex {
        id: format!("scan-{}", now_unix()),
        started_at: now_unix(),
        ..Default::default()
    };

    let mut frontier: Vec<(u32, PathBuf)> = Vec::new();
    for root in dedupe_roots(&opts.roots) {
        let md = match fs::metadata(&root) {
            Ok(m) if m.is_dir() => m,
            Ok(_) => {
                index.issues.push(ScanIssue { path: root.display().to_string(), message: "Not a folder".into() });
                continue;
            }
            Err(e) => {
                index.error_count += 1;
                index.issues.push(ScanIssue { path: root.display().to_string(), message: e.to_string() });
                continue;
            }
        };
        let id = index.dirs.len() as u32;
        index.dirs.push(DirRec {
            parent: NONE,
            name: root.display().to_string().into(),
            first_child: 0,
            child_count: 0,
            first_file: 0,
            file_count: 0,
            own_size: 0,
            total_size: 0,
            total_files: 0,
            latest_mtime: 0,
            modified: times_of(&md).1,
            flags: 0,
        });
        index.roots.push(id);
        frontier.push((id, root));
    }

    while !frontier.is_empty() {
        if cancel.load(Ordering::Relaxed) {
            index.cancelled = true;
            break;
        }
        let listings: Vec<Result<Listing, String>> = frontier
            .par_iter()
            .map(|(_, path)| {
                if cancel.load(Ordering::Relaxed) {
                    return Err("cancelled".into());
                }
                list_dir(path, opts, cancel, progress)
            })
            .collect();

        let mut next: Vec<(u32, PathBuf)> = Vec::new();
        for ((dir_id, path), listing) in frontier.into_iter().zip(listings) {
            let listing = match listing {
                Ok(l) => l,
                Err(msg) => {
                    if msg != "cancelled" {
                        index.error_count += 1;
                        progress.errors.fetch_add(1, Ordering::Relaxed);
                        index.dirs[dir_id as usize].flags |= flags::UNREADABLE;
                        if index.issues.len() < MAX_STORED_ISSUES {
                            index.issues.push(ScanIssue { path: path.display().to_string(), message: msg });
                        }
                    }
                    continue;
                }
            };
            index.links_skipped += listing.links;
            index.excluded_skipped += listing.excluded;
            index.error_count += listing.issues.len() as u64;
            progress.errors.fetch_add(listing.issues.len() as u64, Ordering::Relaxed);
            for issue in listing.issues {
                if index.issues.len() < MAX_STORED_ISSUES {
                    index.issues.push(issue);
                }
            }

            let first_file = index.files.len() as u32;
            let file_count = listing.files.len() as u32;
            for mut f in listing.files {
                f.dir = dir_id;
                index.files.push(f);
            }
            let first_child = index.dirs.len() as u32;
            let child_count = listing.dirs.len() as u32;
            for (name, modified, fl) in listing.dirs {
                let child_path = path.join(&*name);
                let cid = index.dirs.len() as u32;
                index.dirs.push(DirRec {
                    parent: dir_id,
                    name,
                    first_child: 0,
                    child_count: 0,
                    first_file: 0,
                    file_count: 0,
                    own_size: 0,
                    total_size: 0,
                    total_files: 0,
                    latest_mtime: 0,
                    modified,
                    flags: fl,
                });
                next.push((cid, child_path));
            }
            let d = &mut index.dirs[dir_id as usize];
            d.first_file = first_file;
            d.file_count = file_count;
            d.first_child = first_child;
            d.child_count = child_count;
        }
        frontier = next;
    }

    aggregate(&mut index);
    index.finished_at = now_unix();
    index.duration_ms = started.elapsed().as_millis() as u64;
    index
}

/// Fill own/total sizes and newest modification times bottom-up.
pub fn aggregate(index: &mut ScanIndex) {
    let now = now_unix();
    let ok = |t: i64| if crate::model::plausible_time(t, now) { t } else { 0 };
    for d in index.dirs.iter_mut() {
        d.own_size = 0;
        d.total_size = 0;
        d.total_files = 0;
        d.latest_mtime = ok(d.modified);
    }
    for f in &index.files {
        if f.flags & flags::REMOVED != 0 {
            continue;
        }
        let d = &mut index.dirs[f.dir as usize];
        d.own_size += f.size;
        d.total_files += 1;
        d.latest_mtime = d.latest_mtime.max(ok(f.modified));
    }
    for d in index.dirs.iter_mut() {
        d.total_size = d.own_size;
    }
    // Children always have larger ids than their parents.
    for i in (0..index.dirs.len()).rev() {
        let (parent, total, files, latest) = {
            let d = &index.dirs[i];
            (d.parent, d.total_size, d.total_files, d.latest_mtime)
        };
        if parent != NONE {
            let p = &mut index.dirs[parent as usize];
            p.total_size += total;
            p.total_files += files;
            p.latest_mtime = p.latest_mtime.max(latest);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(p: &Path, bytes: usize) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        let mut f = fs::File::create(p).unwrap();
        f.write_all(&vec![7u8; bytes]).unwrap();
    }

    fn opts(root: &Path) -> ScanOptions {
        ScanOptions { roots: vec![root.to_path_buf()], exclusions: vec![], skip_system: true }
    }

    #[test]
    fn scans_tree_and_aggregates() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path();
        write(&r.join("a.txt"), 10);
        write(&r.join("sub/b.bin"), 100);
        write(&r.join("sub/deeper/c.pdf"), 1000);
        fs::create_dir_all(r.join("empty")).unwrap();

        let idx = scan(&opts(r), &AtomicBool::new(false), &Progress::default());
        assert_eq!(idx.files.len(), 3);
        assert_eq!(idx.total_bytes(), 1110);
        assert_eq!(idx.total_files(), 3);
        let sub = idx.find_dir(&r.join("sub")).unwrap();
        assert_eq!(idx.dirs[sub as usize].total_size, 1100);
        assert_eq!(idx.dirs[sub as usize].own_size, 100);
        let deeper = idx.find_dir(&r.join("SUB").join("Deeper")).unwrap();
        assert_eq!(idx.dir_path(deeper), r.join("sub").join("deeper"));
        let c = idx.files.iter().position(|f| &*f.name == "c.pdf").unwrap() as u32;
        assert_eq!(idx.file_path(c), r.join("sub/deeper/c.pdf"));
        // Children are contiguous.
        let root = idx.roots[0];
        let names: Vec<_> = idx.children(root).map(|c| idx.dirs[c].name.to_string()).collect();
        assert_eq!(names.len(), 2);
    }

    #[test]
    fn exclusions_are_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path();
        write(&r.join("keep/x.txt"), 5);
        write(&r.join("skip/y.txt"), 50);
        let mut o = opts(r);
        o.exclusions = vec![paths::normalize(&r.join("Skip"))];
        let idx = scan(&o, &AtomicBool::new(false), &Progress::default());
        assert_eq!(idx.total_bytes(), 5);
        assert_eq!(idx.excluded_skipped, 1);
    }

    #[test]
    fn cancellation_stops_early() {
        let tmp = tempfile::tempdir().unwrap();
        write(&tmp.path().join("a/b/c.txt"), 5);
        let idx = scan(&opts(tmp.path()), &AtomicBool::new(true), &Progress::default());
        assert!(idx.cancelled);
        assert_eq!(idx.files.len(), 0);
    }

    #[test]
    fn nested_roots_are_deduped() {
        let r = dedupe_roots(&[PathBuf::from(r"C:\Users\me"), PathBuf::from(r"C:\Users"), PathBuf::from(r"c:\users\")]);
        assert_eq!(r, vec![PathBuf::from(r"C:\Users")]);
    }

    #[cfg(windows)]
    #[test]
    fn junction_loops_are_not_followed() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path();
        write(&r.join("real/f.txt"), 10);
        // A junction pointing back at the root would loop forever if followed.
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(r.join("real").join("loop"))
            .arg(r)
            .output()
            .unwrap();
        assert!(status.status.success(), "mklink failed");
        let idx = scan(&opts(r), &AtomicBool::new(false), &Progress::default());
        assert_eq!(idx.files.len(), 1);
        assert_eq!(idx.links_skipped, 1);
    }
}
