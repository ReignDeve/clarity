//! Media gallery queries, related-media grouping and the metadata cache.

use crate::model::{ext_of, flags, Category, ScanIndex};
use crate::query::{row, FileRow};
use crate::relations::{split, version_base};
use crate::shell::MediaMeta;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::cmp::Reverse;
use std::collections::HashMap;

pub fn is_media(c: Category) -> bool {
    matches!(c, Category::Images | Category::Video | Category::Audio)
}

pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS media_meta (
            norm TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime INTEGER NOT NULL, json TEXT NOT NULL) WITHOUT ROWID;",
    )
}

/// Cached metadata for files whose size and mtime still match.
pub fn load_cached(conn: &Connection, index: &ScanIndex, ids: &[u32]) -> HashMap<u32, MediaMeta> {
    let mut out = HashMap::new();
    let Ok(mut st) = conn.prepare("SELECT size, mtime, json FROM media_meta WHERE norm = ?1") else { return out };
    for &id in ids {
        let f = &index.files[id as usize];
        let norm = crate::paths::normalize(&index.file_path(id));
        if let Ok((size, mtime, json)) = st.query_row(params![norm], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?))) {
            if size as u64 == f.size && mtime == f.modified {
                if let Ok(m) = serde_json::from_str(&json) {
                    out.insert(id, m);
                }
            }
        }
    }
    out
}

pub fn store(conn: &mut Connection, index: &ScanIndex, items: &[(u32, MediaMeta)]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    {
        let mut st = tx.prepare("INSERT OR REPLACE INTO media_meta (norm, size, mtime, json) VALUES (?1, ?2, ?3, ?4)")?;
        for (id, m) in items {
            let f = &index.files[*id as usize];
            st.execute(params![crate::paths::normalize(&index.file_path(*id)), f.size as i64, f.modified, serde_json::to_string(m).unwrap()])?;
        }
    }
    tx.commit()
}

/// Groups of related files around one primary media file.
#[derive(Default)]
pub struct Groups {
    /// primary → satellites (media and non-media)
    pub members: HashMap<u32, Vec<u32>>,
    /// satellite → primary
    pub primary_of: HashMap<u32, u32>,
}

const SUBS: &[&str] = &["srt", "ass", "ssa", "vtt", "sub", "idx", "sup"];
const SIDECARS: &[&str] = &["xmp", "aae", "thm", "pp3", "dop", "lrc", "cue"];

/// Key under which a file joins a same-folder group (stem without
/// subtitle language tags or sidecar double extensions).
pub fn group_stem(name: &str) -> (String, String) {
    let (stem, ext) = split(name);
    let mut s = stem.as_str();
    if SUBS.contains(&ext.as_str()) {
        for _ in 0..2 {
            match s.rsplit_once('.') {
                Some((h, t)) if !h.is_empty() && (t.len() <= 3 && t.chars().all(|c| c.is_ascii_alphabetic()) || matches!(t, "forced" | "sdh")) => s = h,
                _ => break,
            }
        }
    }
    if SIDECARS.contains(&ext.as_str()) {
        if let Some((h, t)) = s.rsplit_once('.') {
            if Category::from_name(&format!("x.{t}")) != Category::Other {
                s = h;
            }
        }
    }
    (s.to_string(), ext)
}

fn rank(index: &ScanIndex, id: u32) -> (u8, u8, Reverse<u64>) {
    let f = &index.files[id as usize];
    let ext = ext_of(&f.name);
    let kind = match f.cat {
        Category::Video => 0,
        Category::Images if matches!(ext.as_str(), "jpg" | "jpeg" | "heic" | "heif" | "png" | "webp") => 1,
        Category::Images => 2,
        Category::Audio => 3,
        _ => 9,
    };
    let versioned = version_base(&split(&f.name).0).1 as u8;
    (kind, versioned, Reverse(f.size))
}

/// O(n): bucket files per folder by stem and by version base.
pub fn build_groups(index: &ScanIndex) -> Groups {
    let mut g = Groups::default();
    for d in 0..index.dirs.len() as u32 {
        let files: Vec<u32> = index.files_of(d).map(|f| f as u32).filter(|&f| index.files[f as usize].flags & flags::REMOVED == 0).collect();
        if files.len() < 2 || !files.iter().any(|&f| is_media(index.files[f as usize].cat)) {
            continue;
        }
        let mut by_stem: HashMap<String, Vec<u32>> = HashMap::new();
        let mut by_version: HashMap<String, Vec<u32>> = HashMap::new();
        for &f in &files {
            let rec = &index.files[f as usize];
            let (stem, ext) = group_stem(&rec.name);
            let attach = is_media(rec.cat) || SUBS.contains(&ext.as_str()) || SIDECARS.contains(&ext.as_str());
            if attach {
                by_stem.entry(stem.clone()).or_default().push(f);
            }
            if rec.cat == Category::Images || rec.cat == Category::Video {
                let (base, _) = version_base(&stem);
                if base.len() >= 3 {
                    by_version.entry(base).or_default().push(f);
                }
            }
        }
        // Union of both bucket kinds.
        let mut parent: HashMap<u32, u32> = HashMap::new();
        fn find(p: &mut HashMap<u32, u32>, x: u32) -> u32 {
            let mut r = x;
            while let Some(&n) = p.get(&r) {
                if n == r {
                    break;
                }
                r = n;
            }
            p.insert(x, r);
            r
        }
        let join = |p: &mut HashMap<u32, u32>, ids: &[u32]| {
            for w in ids.windows(2) {
                let (a, b) = (find(p, w[0]), find(p, w[1]));
                if a != b {
                    p.insert(b, a);
                }
            }
        };
        for ids in by_stem.values().filter(|v| v.len() > 1 && v.iter().any(|&f| is_media(index.files[f as usize].cat))) {
            join(&mut parent, ids);
        }
        for ids in by_version.values().filter(|v| v.len() > 1) {
            // Only when a version marker is actually present.
            if ids.iter().any(|&f| version_base(&split(&index.files[f as usize].name).0).1) {
                join(&mut parent, ids);
            }
        }
        let mut sets: HashMap<u32, Vec<u32>> = HashMap::new();
        let keys: Vec<u32> = parent.keys().copied().collect();
        for k in keys {
            let r = find(&mut parent, k);
            sets.entry(r).or_default().push(k);
        }
        for (_, mut set) in sets {
            set.sort();
            set.dedup();
            if set.len() < 2 {
                continue;
            }
            set.sort_by_key(|&f| rank(index, f));
            let primary = set[0];
            if !is_media(index.files[primary as usize].cat) {
                continue;
            }
            for &s in &set[1..] {
                g.primary_of.insert(s, primary);
            }
            g.members.insert(primary, set[1..].to_vec());
        }
    }
    g
}

#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MediaQuery {
    /// "all" | "images" | "video" | "audio"
    pub kind: String,
    pub search: String,
    pub under_dir: Option<u32>,
    /// "date" | "taken" | "size" | "name" | "resolution" | "duration"
    pub sort: String,
    pub desc: bool,
    /// "landscape" | "portrait" | "square"
    pub orientation: String,
    pub min_pixels: Option<u64>,
    pub min_duration_ms: Option<u64>,
    pub max_duration_ms: Option<u64>,
    pub formats: Vec<String>,
    pub group: bool,
    #[serde(skip_serializing)]
    pub offset: usize,
    #[serde(skip_serializing)]
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    pub row: FileRow,
    pub meta: Option<MediaMeta>,
    /// Grouped related files (subtitles, RAW, sidecars, versions…).
    pub grouped: Vec<GroupedFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupedFile {
    pub id: u32,
    pub name: String,
    pub ext: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaResult {
    pub total: usize,
    pub total_bytes: u64,
    pub items: Vec<MediaItem>,
    pub formats: Vec<(String, usize)>,
    pub counts: HashMap<String, usize>,
    pub media_total: usize,
    pub meta_known: usize,
}

pub fn run(index: &ScanIndex, q: &MediaQuery, meta: &HashMap<u32, MediaMeta>, groups: &Groups, masks: &[u16]) -> MediaResult {
    let search = q.search.trim().to_lowercase();
    let under = q.under_dir.map(|d| index.subtree_mask(d));
    let mut counts: HashMap<String, usize> = HashMap::new();
    let mut formats: HashMap<String, usize> = HashMap::new();
    let mut media_total = 0;
    let mut ids: Vec<u32> = Vec::new();
    for (i, f) in index.files.iter().enumerate() {
        if f.flags & flags::REMOVED != 0 || !is_media(f.cat) {
            continue;
        }
        if under.as_ref().is_some_and(|m| !m[f.dir as usize]) {
            continue;
        }
        media_total += 1;
        if q.group && groups.primary_of.get(&(i as u32)).is_some_and(|&p| is_media(index.files[p as usize].cat)) {
            continue;
        }
        let kind = match f.cat {
            Category::Images => "images",
            Category::Video => "video",
            _ => "audio",
        };
        if !search.is_empty() && !f.name.to_lowercase().contains(&search) {
            continue;
        }
        *counts.entry(kind.into()).or_default() += 1;
        if !(q.kind.is_empty() || q.kind == "all" || q.kind == kind) {
            continue;
        }
        let ext = ext_of(&f.name);
        *formats.entry(ext.clone()).or_default() += 1;
        if !q.formats.is_empty() && !q.formats.contains(&ext) {
            continue;
        }
        let m = meta.get(&(i as u32));
        if !q.orientation.is_empty() || q.min_pixels.is_some() {
            let Some((w, h)) = m.and_then(|m| Some((m.width?, m.height?))) else { continue };
            let ok = match q.orientation.as_str() {
                "landscape" => w as f32 > h as f32 * 1.05,
                "portrait" => (h as f32) > w as f32 * 1.05,
                "square" => (w as f32 / h.max(1) as f32 - 1.0).abs() <= 0.05,
                _ => true,
            };
            if !ok || q.min_pixels.is_some_and(|p| (w as u64 * h as u64) < p) {
                continue;
            }
        }
        if q.min_duration_ms.is_some() || q.max_duration_ms.is_some() {
            let Some(d) = m.and_then(|m| m.duration_ms) else { continue };
            if q.min_duration_ms.is_some_and(|x| d < x) || q.max_duration_ms.is_some_and(|x| d > x) {
                continue;
            }
        }
        ids.push(i as u32);
    }

    let files = &index.files;
    let taken = |id: &u32| meta.get(id).and_then(|m| m.taken).unwrap_or(files[*id as usize].modified);
    match q.sort.as_str() {
        "size" => ids.sort_by_key(|&i| files[i as usize].size),
        "name" => ids.sort_by_cached_key(|&i| files[i as usize].name.to_lowercase()),
        "taken" => ids.sort_by_key(taken),
        // Unknown values sort as the smallest, so "largest first" puts them last.
        "resolution" => ids.sort_by_key(|i| meta.get(i).map(|m| m.pixels()).unwrap_or(0)),
        "duration" => ids.sort_by_key(|i| meta.get(i).and_then(|m| m.duration_ms).unwrap_or(0)),
        _ => ids.sort_by_key(|&i| files[i as usize].modified),
    }
    if q.desc {
        ids.reverse();
    }
    let total_bytes = ids.iter().map(|&i| files[i as usize].size).sum();
    let limit = if q.limit == 0 { 300 } else { q.limit.min(3000) };
    let items = ids
        .iter()
        .skip(q.offset)
        .take(limit)
        .map(|&i| MediaItem {
            row: row(index, i, masks),
            meta: meta.get(&i).cloned(),
            grouped: if q.group {
                groups
                    .members
                    .get(&i)
                    .map(|v| v.iter().filter(|&&s| files[s as usize].flags & flags::REMOVED == 0).map(|&s| GroupedFile { id: s, name: files[s as usize].name.to_string(), ext: ext_of(&files[s as usize].name), size: files[s as usize].size }).collect())
                    .unwrap_or_default()
            } else {
                vec![]
            },
        })
        .collect();
    let mut formats: Vec<(String, usize)> = formats.into_iter().collect();
    formats.sort_by(|a, b| b.1.cmp(&a.1));
    MediaResult { total: ids.len(), total_bytes, items, formats, counts, media_total, meta_known: meta.len() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scan::{scan, Progress, ScanOptions};
    use std::fs;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn groups_related_media_in_one_pass() {
        let t = tempfile::tempdir().unwrap();
        let w = |n: &str, s: usize| fs::write(t.path().join(n), vec![1u8; s]).unwrap();
        w("Film.mkv", 900);
        w("Film.en.srt", 5);
        w("Film.jpg", 50);
        w("IMG_1.CR2", 800);
        w("IMG_1.jpg", 300);
        w("IMG_1.CR2.xmp", 3);
        w("IMG_1-edited.jpg", 310);
        w("Song.mp3", 400);
        w("Lonely.png", 10);
        let idx = scan(&ScanOptions { roots: vec![t.path().into()], exclusions: vec![], skip_system: false }, &AtomicBool::new(false), &Progress::default());
        let g = build_groups(&idx);
        let id = |n: &str| idx.files.iter().position(|f| &*f.name == n).unwrap() as u32;
        let name = |i: &u32| idx.files[*i as usize].name.to_string();
        let mut film: Vec<String> = g.members[&id("Film.mkv")].iter().map(name).collect();
        film.sort();
        assert_eq!(film, ["Film.en.srt", "Film.jpg"]);
        let mut photo: Vec<String> = g.members[&id("IMG_1.jpg")].iter().map(name).collect();
        photo.sort();
        assert_eq!(photo, ["IMG_1-edited.jpg", "IMG_1.CR2", "IMG_1.CR2.xmp"]);
        assert!(!g.members.contains_key(&id("Song.mp3")));
        assert!(!g.primary_of.contains_key(&id("Lonely.png")));

        let q = MediaQuery { group: true, sort: "name".into(), ..Default::default() };
        let r = run(&idx, &q, &HashMap::new(), &g, &vec![0; idx.files.len()]);
        let shown: Vec<String> = r.items.iter().map(|i| i.row.name.clone()).collect();
        assert_eq!(shown, ["Film.mkv", "IMG_1.jpg", "Lonely.png", "Song.mp3"]);
        let ungrouped = run(&idx, &MediaQuery { kind: "images".into(), ..Default::default() }, &HashMap::new(), &g, &vec![0; idx.files.len()]);
        assert_eq!(ungrouped.total, 5);
    }
}
