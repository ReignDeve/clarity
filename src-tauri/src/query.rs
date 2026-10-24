//! Read-side views over a scan index. Everything here is computed on demand
//! from real scan data; nothing is estimated or invented.

use crate::duplicates::DupResult;
use crate::model::{ext_of, flags, plausible_time, Category, FileRec, ScanIndex, NONE};
use crate::recommend::{human_size, Recommendation, DAY};
use serde::{Deserialize, Serialize};
use std::cmp::Reverse;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRow {
    pub id: u32,
    pub name: String,
    pub dir: String,
    pub dir_id: u32,
    pub ext: String,
    pub size: u64,
    pub created: i64,
    pub modified: i64,
    pub accessed: i64,
    pub category: &'static str,
    pub cloud: bool,
    pub hidden: bool,
    pub readonly: bool,
    pub system: bool,
    pub recs: u16,
}

pub fn row(index: &ScanIndex, id: u32, masks: &[u16]) -> FileRow {
    let f = &index.files[id as usize];
    FileRow {
        id,
        name: f.name.to_string(),
        dir: index.dir_path(f.dir).display().to_string(),
        dir_id: f.dir,
        ext: ext_of(&f.name),
        size: f.size,
        created: f.created,
        modified: f.modified,
        accessed: f.accessed,
        category: f.cat.as_str(),
        cloud: f.flags & flags::CLOUD != 0,
        hidden: f.flags & flags::HIDDEN != 0,
        readonly: f.flags & flags::READONLY != 0,
        system: f.flags & flags::SYSTEM != 0,
        recs: masks.get(id as usize).copied().unwrap_or(0),
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct FileQuery {
    pub search: String,
    pub categories: Vec<String>,
    pub min_size: Option<u64>,
    /// "modified" | "created" | "accessed"
    pub date_field: String,
    /// Only files whose date is older than this many days.
    pub older_than_days: Option<i64>,
    /// Inclusive Unix-second range on `date_field`.
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub under_dir: Option<u32>,
    /// Bit mask of `RecKind`s; 0 = no filter.
    pub rec_mask: u16,
    pub include_hidden: bool,
    pub include_cloud: bool,
    /// "size" | "name" | "modified" | "created" | "accessed" | "type" | "path"
    pub sort: String,
    pub desc: bool,
    #[serde(skip_serializing)]
    pub offset: usize,
    #[serde(skip_serializing)]
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub total: usize,
    pub total_bytes: u64,
    pub offset: usize,
    pub items: Vec<FileRow>,
}

fn date_of(f: &FileRec, field: &str) -> i64 {
    match field {
        "created" => f.created,
        "accessed" => f.accessed,
        _ => f.modified,
    }
}

/// Filter + sort, returning matching ids (cached by the caller).
pub fn run_query(index: &ScanIndex, q: &FileQuery, masks: &[u16], now: i64) -> Vec<u32> {
    let search = q.search.trim().to_lowercase();
    let search_path = search.contains('\\') || search.contains('/');
    let cats: Vec<Category> = q.categories.iter().filter_map(|c| Category::parse(c)).collect();
    let under = q.under_dir.map(|d| index.subtree_mask(d));
    let cutoff = q.older_than_days.map(|d| now - d * DAY);
    let mut ids: Vec<u32> = index
        .files
        .iter()
        .enumerate()
        .filter(|(i, f)| {
            if f.flags & flags::REMOVED != 0 {
                return false;
            }
            if !q.include_hidden && f.flags & (flags::HIDDEN | flags::SYSTEM) != 0 {
                return false;
            }
            if !q.include_cloud && f.flags & flags::CLOUD != 0 {
                return false;
            }
            if !cats.is_empty() && !cats.contains(&f.cat) {
                return false;
            }
            if q.min_size.is_some_and(|m| f.size < m) {
                return false;
            }
            let date = date_of(f, &q.date_field);
            if let Some(c) = cutoff {
                if !plausible_time(date, now) || date >= c {
                    return false;
                }
            }
            if q.from.is_some_and(|from| date < from) || q.to.is_some_and(|to| date > to) {
                return false;
            }
            if q.rec_mask != 0 && masks.get(*i).copied().unwrap_or(0) & q.rec_mask == 0 {
                return false;
            }
            if let Some(m) = &under {
                if !m[f.dir as usize] {
                    return false;
                }
            }
            true
        })
        .map(|(i, _)| i as u32)
        .collect();

    if !search.is_empty() {
        let needle = search.replace('/', "\\");
        ids.retain(|&id| {
            let f = &index.files[id as usize];
            if search_path {
                index.file_path(id).to_string_lossy().to_lowercase().contains(&needle)
            } else {
                f.name.to_lowercase().contains(&needle)
            }
        });
    }

    let files = &index.files;
    match q.sort.as_str() {
        "name" => ids.sort_by_cached_key(|&i| files[i as usize].name.to_lowercase()),
        "modified" => ids.sort_by_key(|&i| files[i as usize].modified),
        "created" => ids.sort_by_key(|&i| files[i as usize].created),
        "accessed" => ids.sort_by_key(|&i| files[i as usize].accessed),
        "type" => ids.sort_by_cached_key(|&i| (ext_of(&files[i as usize].name), Reverse(files[i as usize].size))),
        "path" => ids.sort_by_cached_key(|&i| index.file_path(i).to_string_lossy().to_lowercase()),
        "reason" => ids.sort_by_key(|&i| (masks.get(i as usize).copied().unwrap_or(0).trailing_zeros(), Reverse(files[i as usize].size))),
        _ => ids.sort_by_key(|&i| files[i as usize].size),
    }
    if q.desc {
        ids.reverse();
    }
    ids
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryStat {
    pub category: &'static str,
    pub bytes: u64,
    pub count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirRow {
    pub id: u32,
    pub name: String,
    pub path: String,
    pub size: u64,
    pub own_size: u64,
    pub files: u64,
    pub subdirs: u32,
    pub latest_modified: i64,
    pub unreadable: bool,
}

pub fn dir_row(index: &ScanIndex, id: u32) -> DirRow {
    let d = &index.dirs[id as usize];
    DirRow {
        id,
        name: d.name.to_string(),
        path: index.dir_path(id).display().to_string(),
        size: d.total_size,
        own_size: d.own_size,
        files: d.total_files,
        subdirs: d.child_count,
        latest_modified: d.latest_mtime,
        unreadable: d.flags & flags::UNREADABLE != 0,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootInfo {
    pub id: u32,
    pub path: String,
    pub size: u64,
    pub files: u64,
    pub volume_total: Option<u64>,
    pub volume_free: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanInfo {
    pub id: String,
    pub started_at: i64,
    pub finished_at: i64,
    pub duration_ms: u64,
    pub roots: Vec<RootInfo>,
    pub files: u64,
    pub dirs: usize,
    pub bytes: u64,
    pub errors: u64,
    pub links_skipped: u64,
    pub excluded: u64,
    pub cancelled: bool,
    pub cached: bool,
}

pub fn scan_info(index: &ScanIndex) -> ScanInfo {
    ScanInfo {
        id: index.id.clone(),
        started_at: index.started_at,
        finished_at: index.finished_at,
        duration_ms: index.duration_ms,
        roots: index
            .roots
            .iter()
            .map(|&r| {
                let d = &index.dirs[r as usize];
                let vol = crate::platform::disk_space(std::path::Path::new(&*d.name));
                RootInfo { id: r, path: d.name.to_string(), size: d.total_size, files: d.total_files, volume_total: vol.map(|v| v.0), volume_free: vol.map(|v| v.1) }
            })
            .collect(),
        files: index.total_files(),
        dirs: index.dirs.iter().filter(|d| d.flags & flags::REMOVED == 0).count(),
        bytes: index.total_bytes(),
        errors: index.error_count,
        links_skipped: index.links_skipped,
        excluded: index.excluded_skipped,
        cancelled: index.cancelled,
        cached: index.cached,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Insight {
    pub text: String,
    pub detail: String,
    /// Navigation hint for the UI ("large", "old", "duplicates", "downloads", ...).
    pub target: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadsInfo {
    pub dir_id: u32,
    pub path: String,
    pub bytes: u64,
    pub files: u64,
    pub old_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub scan: ScanInfo,
    pub categories: Vec<CategoryStat>,
    pub largest_files: Vec<FileRow>,
    pub top_folders: Vec<DirRow>,
    pub hotspots: Vec<DirRow>,
    pub cloud_bytes: u64,
    pub old_bytes_1y: u64,
    pub old_bytes_2y: u64,
    pub old_count_1y: u64,
    pub rec_count: usize,
    pub rec_bytes: u64,
    pub downloads: Option<DownloadsInfo>,
    pub duplicates: Option<(usize, u64)>,
    pub insights: Vec<Insight>,
}

pub fn overview(index: &ScanIndex, recs: &[Recommendation], masks: &[u16], dups: Option<&DupResult>, downloads: Option<u32>, now: i64, old_days: i64) -> Overview {
    let mut cats: Vec<CategoryStat> = Category::ALL.iter().map(|c| CategoryStat { category: c.as_str(), bytes: 0, count: 0 }).collect();
    let (mut cloud, mut old1, mut old2, mut oldc) = (0u64, 0u64, 0u64, 0u64);
    let mut largest: Vec<(u64, u32)> = Vec::new();
    for (i, f) in index.files.iter().enumerate() {
        if f.flags & flags::REMOVED != 0 {
            continue;
        }
        let c = &mut cats[f.cat as usize];
        c.bytes += f.size;
        c.count += 1;
        if f.flags & flags::CLOUD != 0 {
            cloud += f.size;
            continue;
        }
        let dated = plausible_time(f.modified, now);
        if dated && f.modified < now - old_days * DAY {
            old1 += f.size;
            oldc += 1;
        }
        if dated && f.modified < now - 730 * DAY {
            old2 += f.size;
        }
        if largest.len() < 10 || f.size > largest[largest.len() - 1].0 {
            largest.push((f.size, i as u32));
            largest.sort_by(|a, b| b.0.cmp(&a.0));
            largest.truncate(10);
        }
    }
    cats.sort_by(|a, b| b.bytes.cmp(&a.bytes));

    let mut top: Vec<u32> = index.roots.iter().flat_map(|&r| index.children(r).map(|c| c as u32)).filter(|&d| index.dirs[d as usize].flags & flags::REMOVED == 0).collect();
    top.sort_by_key(|&d| Reverse(index.dirs[d as usize].total_size));
    top.truncate(8);

    let mut hot: Vec<u32> = (0..index.dirs.len() as u32).filter(|&d| index.dirs[d as usize].flags & flags::REMOVED == 0).collect();
    hot.sort_by_key(|&d| Reverse(index.dirs[d as usize].own_size));
    hot.truncate(8);

    let downloads_info = downloads.map(|d| {
        let mask = index.subtree_mask(d);
        let old_bytes = index
            .files
            .iter()
            .filter(|f| f.flags & flags::REMOVED == 0 && mask[f.dir as usize] && plausible_time(f.modified, now) && f.modified < now - 180 * DAY)
            .map(|f| f.size)
            .sum();
        let dr = &index.dirs[d as usize];
        DownloadsInfo { dir_id: d, path: index.dir_path(d).display().to_string(), bytes: dr.total_size, files: dr.total_files, old_bytes }
    });

    let rec_bytes: u64 = recs.iter().map(|r| r.size).sum();
    let mut insights = Vec::new();
    let large_old = recs.iter().filter(|r| matches!(r.kind, crate::recommend::RecKind::LargeOld)).count();
    if large_old > 0 {
        insights.push(Insight {
            text: format!("{large_old} large file{} worth reviewing", if large_old == 1 { "" } else { "s" }),
            detail: "Large files whose content has not changed for a long time.".into(),
            target: "old",
        });
    }
    if let Some(d) = dups.filter(|d| !d.groups.is_empty()) {
        insights.push(Insight {
            text: format!("{} of confirmed duplicate content", human_size(d.reclaimable)),
            detail: format!("{} groups of byte-identical files.", d.groups.len()),
            target: "duplicates",
        });
    }
    if let Some(dl) = &downloads_info {
        if dl.bytes > 0 {
            insights.push(Insight {
                text: format!("Your Downloads folder contains {}", human_size(dl.bytes)),
                detail: if dl.old_bytes > 0 { format!("{} of it has not been modified in over 6 months.", human_size(dl.old_bytes)) } else { format!("{} files.", dl.files) },
                target: "downloads",
            });
        }
    }
    let old_archives = recs.iter().filter(|r| matches!(r.kind, crate::recommend::RecKind::ArchiveReview)).count();
    if old_archives > 1 {
        insights.push(Insight { text: format!("{old_archives} large archives haven't changed in over a year"), detail: "Archives are often forgotten backups or duplicates of extracted folders.".into(), target: "suggestions" });
    }
    let builds: Vec<&Recommendation> = recs.iter().filter(|r| matches!(r.kind, crate::recommend::RecKind::BuildArtifacts)).collect();
    if !builds.is_empty() {
        insights.push(Insight {
            text: format!("{} in regenerable build folders", human_size(builds.iter().map(|r| r.size).sum())),
            detail: format!("{} folders like node_modules that have not changed in months.", builds.len()),
            target: "suggestions",
        });
    }
    if old2 > 0 && index.total_bytes() > 0 && old2 * 10 > index.total_bytes() {
        insights.push(Insight {
            text: format!("{} in files unchanged for over 2 years", human_size(old2)),
            detail: format!("That is {:.0}% of the scanned data. Unchanged does not mean unused.", old2 as f64 * 100.0 / index.total_bytes() as f64),
            target: "old",
        });
    }

    Overview {
        scan: scan_info(index),
        categories: cats,
        largest_files: largest.iter().map(|&(_, i)| row(index, i, masks)).collect(),
        top_folders: top.iter().map(|&d| dir_row(index, d)).collect(),
        hotspots: hot.iter().filter(|&&d| index.dirs[d as usize].own_size > 0).map(|&d| dir_row(index, d)).collect(),
        cloud_bytes: cloud,
        old_bytes_1y: old1,
        old_bytes_2y: old2,
        old_count_1y: oldc,
        rec_count: recs.len(),
        rec_bytes,
        downloads: downloads_info,
        duplicates: dups.map(|d| (d.groups.len(), d.reclaimable)),
        insights,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Crumb {
    pub id: u32,
    pub name: String,
}

pub fn crumbs(index: &ScanIndex, mut id: u32) -> Vec<Crumb> {
    let mut out = Vec::new();
    while id != NONE {
        out.push(Crumb { id, name: index.dirs[id as usize].name.to_string() });
        id = index.dirs[id as usize].parent;
    }
    out.reverse();
    out
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub dir: Option<DirRow>,
    pub crumbs: Vec<Crumb>,
    pub dirs: Vec<DirRow>,
    pub files: Vec<FileRow>,
    pub file_total: usize,
}

pub fn list_dir(index: &ScanIndex, dir: Option<u32>, masks: &[u16], include_hidden: bool) -> DirListing {
    let Some(dir) = dir else {
        return DirListing { dir: None, crumbs: vec![], dirs: index.roots.iter().map(|&r| dir_row(index, r)).collect(), files: vec![], file_total: 0 };
    };
    let mut dirs: Vec<u32> = index.children(dir).map(|c| c as u32).filter(|&c| index.dirs[c as usize].flags & flags::REMOVED == 0).collect();
    dirs.sort_by_key(|&c| Reverse(index.dirs[c as usize].total_size));
    let mut files: Vec<u32> = index
        .files_of(dir)
        .map(|f| f as u32)
        .filter(|&f| {
            let fl = index.files[f as usize].flags;
            fl & flags::REMOVED == 0 && (include_hidden || fl & (flags::HIDDEN | flags::SYSTEM) == 0)
        })
        .collect();
    files.sort_by_key(|&f| Reverse(index.files[f as usize].size));
    let total = files.len();
    files.truncate(5_000);
    DirListing {
        dir: Some(dir_row(index, dir)),
        crumbs: crumbs(index, dir),
        dirs: dirs.iter().map(|&c| dir_row(index, c)).collect(),
        files: files.iter().map(|&f| row(index, f, masks)).collect(),
        file_total: total,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    /// Directory or file id; -1 for synthetic nodes.
    pub id: i64,
    /// "dir" | "file" | "files" | "rest"
    pub kind: &'static str,
    pub name: String,
    pub size: u64,
    pub category: Option<&'static str>,
    pub children: Vec<TreeNode>,
}

pub fn tree(index: &ScanIndex, dir: u32, depth: u8, max_children: usize) -> TreeNode {
    let d = &index.dirs[dir as usize];
    let mut node = TreeNode { id: dir as i64, kind: "dir", name: d.name.to_string(), size: d.total_size, category: None, children: vec![] };
    if depth == 0 || d.total_size == 0 {
        return node;
    }
    let mut kids: Vec<TreeNode> = index
        .children(dir)
        .map(|c| c as u32)
        .filter(|&c| index.dirs[c as usize].total_size > 0 && index.dirs[c as usize].flags & flags::REMOVED == 0)
        .map(|c| tree(index, c, depth - 1, max_children))
        .collect();
    // Large individual files get their own tiles; the remainder is grouped.
    let threshold = d.total_size / 50;
    let mut loose = 0u64;
    let mut loose_count = 0u64;
    for f in index.files_of(dir) {
        let rec = &index.files[f];
        if rec.flags & flags::REMOVED != 0 || rec.size == 0 {
            continue;
        }
        if rec.size >= threshold && rec.size > 0 {
            kids.push(TreeNode { id: f as i64, kind: "file", name: rec.name.to_string(), size: rec.size, category: Some(rec.cat.as_str()), children: vec![] });
        } else {
            loose += rec.size;
            loose_count += 1;
        }
    }
    if loose > 0 {
        kids.push(TreeNode { id: -1, kind: "files", name: format!("{loose_count} smaller files"), size: loose, category: None, children: vec![] });
    }
    kids.sort_by_key(|k| Reverse(k.size));
    if kids.len() > max_children {
        let rest: Vec<TreeNode> = kids.split_off(max_children);
        let size = rest.iter().map(|k| k.size).sum();
        kids.push(TreeNode { id: -1, kind: "rest", name: format!("{} more items", rest.len()), size, category: None, children: vec![] });
    }
    node.children = kids;
    node
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scan::{scan, Progress, ScanOptions};
    use std::sync::atomic::AtomicBool;

    #[test]
    fn query_filters_and_sorts() {
        let t = tempfile::tempdir().unwrap();
        std::fs::write(t.path().join("small.txt"), vec![0u8; 10]).unwrap();
        std::fs::write(t.path().join("big.mp4"), vec![0u8; 1000]).unwrap();
        std::fs::create_dir(t.path().join("d")).unwrap();
        std::fs::write(t.path().join("d/mid.pdf"), vec![0u8; 100]).unwrap();
        let idx = scan(&ScanOptions { roots: vec![t.path().into()], exclusions: vec![], skip_system: false }, &AtomicBool::new(false), &Progress::default());
        let masks = vec![0; idx.files.len()];
        let names = |q: &FileQuery| run_query(&idx, q, &masks, 0).iter().map(|&i| idx.files[i as usize].name.to_string()).collect::<Vec<_>>();

        let mut q = FileQuery { sort: "size".into(), desc: true, include_hidden: true, ..Default::default() };
        assert_eq!(names(&q), ["big.mp4", "mid.pdf", "small.txt"]);
        q.desc = false;
        assert_eq!(names(&q), ["small.txt", "mid.pdf", "big.mp4"]);
        q.sort = "name".into();
        assert_eq!(names(&q), ["big.mp4", "mid.pdf", "small.txt"]);
        q.desc = true;
        assert_eq!(names(&q), ["small.txt", "mid.pdf", "big.mp4"]);
        q.categories = vec!["video".into(), "documents".into()];
        q.min_size = Some(50);
        assert_eq!(names(&q), ["mid.pdf", "big.mp4"]);
        q.search = "MID".into();
        assert_eq!(names(&q), ["mid.pdf"]);
        let d = idx.find_dir(&t.path().join("d")).unwrap();
        let q2 = FileQuery { under_dir: Some(d), include_hidden: true, ..Default::default() };
        assert_eq!(names(&q2), ["mid.pdf"]);

        let tr = tree(&idx, idx.roots[0], 2, 10);
        assert_eq!(tr.size, 1110);
        assert_eq!(tr.children.iter().map(|c| c.size).sum::<u64>(), 1110);
    }
}
