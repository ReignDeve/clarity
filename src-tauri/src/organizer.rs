//! Smart Folder Organizer: proposes a tidy structure for the loose files
//! of one folder, applies it after confirmation, and can undo it.
//!
//! Only files directly inside the chosen folder are considered; existing
//! subfolders are left untouched (files may be placed into them). Files are
//! only ever renamed/moved within that folder; contents are never modified
//! and nothing is deleted. Moves can never overwrite (`rename_no_replace`).

use crate::media::group_stem;
use crate::model::{ext_of, plausible_time, Category};
use crate::paths::{is_plain_absolute, normalize};
use crate::platform::{self, attrs_of, times_of};
use crate::relations::version_base;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

// ------------------------------------------------------------------ input

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    /// "ext" | "name" | "category" | "olderThanDays" | "largerThanMb"
    pub field: String,
    pub value: String,
    pub dest: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    /// "smart" | "type" | "date" | "custom"
    pub mode: String,
    /// No new folder for fewer files than this.
    pub min_group: usize,
    pub keep_related: bool,
    pub rules: Vec<Rule>,
    /// Custom mode, unmatched files: "stay" | "smart"
    pub fallback: String,
}

impl Default for Options {
    fn default() -> Self {
        Self { mode: "smart".into(), min_group: 3, keep_related: true, rules: vec![], fallback: "stay".into() }
    }
}

// ----------------------------------------------------------------- output

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanFile {
    pub id: u32,
    pub name: String,
    pub size: u64,
    pub modified: i64,
    pub created: i64,
    pub category: &'static str,
    /// Relative destination folder ("" = stays where it is).
    pub dest: String,
    pub reason: String,
    /// Id of the file this one is kept together with (if any).
    pub group: Option<u32>,
    pub conflict: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanFolder {
    pub path: String,
    pub files: usize,
    pub bytes: u64,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub root: String,
    pub mode: String,
    pub files: Vec<PlanFile>,
    pub folders: Vec<PlanFolder>,
    pub skipped: Vec<Skipped>,
    pub existing_subfolders: Vec<String>,
    pub moving: usize,
    pub staying: usize,
    pub conflicts: usize,
}

// --------------------------------------------------------------- analysis

struct Entry {
    name: String,
    size: u64,
    created: i64,
    modified: i64,
    cat: Category,
    ext: String,
}

const IN_PROGRESS: &[&str] = &["crdownload", "part", "partial", "download", "opdownload", "!ut", "tmp"];

fn read_folder(root: &Path) -> Result<(Vec<Entry>, Vec<Skipped>, Vec<String>), String> {
    let rd = fs::read_dir(root).map_err(|e| format!("Cannot read this folder: {e}"))?;
    let (mut files, mut skipped, mut subs) = (Vec::new(), Vec::new(), Vec::new());
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Ok(md) = e.metadata() else {
            skipped.push(Skipped { name, reason: "Could not be read.".into() });
            continue;
        };
        if md.file_type().is_symlink() {
            skipped.push(Skipped { name, reason: "Link to another location.".into() });
            continue;
        }
        if md.is_dir() {
            subs.push(name);
            continue;
        }
        let attrs = attrs_of(&md);
        let ext = ext_of(&name);
        if attrs & (platform::ATTR_HIDDEN | platform::ATTR_SYSTEM) != 0 || name.eq_ignore_ascii_case("desktop.ini") {
            skipped.push(Skipped { name, reason: "Hidden or system file.".into() });
            continue;
        }
        if IN_PROGRESS.contains(&ext.as_str()) {
            skipped.push(Skipped { name, reason: "Unfinished download or temporary file.".into() });
            continue;
        }
        let (created, modified, _) = times_of(&md);
        files.push(Entry { cat: Category::from_name(&name), ext, name, size: md.len(), created, modified });
    }
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    subs.sort_by_key(|s| s.to_lowercase());
    Ok((files, skipped, subs))
}

fn top_folder(e: &Entry) -> &'static str {
    match e.ext.as_str() {
        "lnk" | "url" => return "Shortcuts",
        "exe" | "msi" | "msix" | "msixbundle" | "appx" => return "Installers",
        _ => {}
    }
    match e.cat {
        Category::Documents => "Documents",
        Category::Images => "Images",
        Category::Video => "Videos",
        Category::Audio => "Audio",
        Category::Archives => "Archives",
        Category::Installers => "Installers",
        Category::Code => "Code & data",
        Category::Apps => "Applications",
        Category::System | Category::Other => "Other",
    }
}

fn is_screenshot(n: &str) -> bool {
    let l = n.to_lowercase();
    ["screenshot", "screen shot", "bildschirmfoto", "capture d", "snip", "bildschirmaufnahme"].iter().any(|k| l.contains(k))
}

fn is_camera_name(n: &str) -> bool {
    let l = n.to_lowercase();
    let digits = |s: &str| s.chars().take(8).all(|c| c.is_ascii_digit()) && s.len() >= 8;
    ["img_", "img-", "dsc", "dscn", "dscf", "pxl_", "gopr", "dji_", "mvimg", "p_"].iter().any(|p| l.starts_with(p)) || digits(&l)
}

/// Subfolder inside the type folder, with a human-readable reason.
fn sub_folder(e: &Entry) -> (Option<&'static str>, String) {
    let ext = e.ext.as_str();
    match e.cat {
        Category::Documents => match ext {
            "pdf" => (Some("PDFs"), "PDF document".into()),
            "doc" | "docx" | "odt" | "rtf" | "pages" => (Some("Word documents"), "Text document".into()),
            "xls" | "xlsx" | "ods" | "csv" | "numbers" => (Some("Spreadsheets"), "Spreadsheet".into()),
            "ppt" | "pptx" | "odp" | "key" => (Some("Presentations"), "Presentation".into()),
            "txt" | "md" => (Some("Notes"), "Text or Markdown note".into()),
            "epub" => (Some("E-books"), "E-book".into()),
            _ => (None, "Document".into()),
        },
        Category::Images => {
            if is_screenshot(&e.name) {
                (Some("Screenshots"), "Screenshot (by its name)".into())
            } else if matches!(ext, "svg" | "ai" | "psd" | "psb" | "xcf" | "afdesign" | "afphoto" | "sketch" | "fig") {
                (Some("Design files"), "Design or editing file".into())
            } else if is_camera_name(&e.name) || matches!(ext, "heic" | "heif" | "cr2" | "cr3" | "nef" | "arw" | "dng" | "raf" | "orf") {
                (Some("Photos"), "Photo (camera file name or format)".into())
            } else {
                (None, "Image".into())
            }
        }
        Category::Video => {
            let l = e.name.to_lowercase();
            if l.contains("screen recording") || l.contains("bildschirmaufnahme") || l.contains("recording") && l.contains("screen") {
                (Some("Screen recordings"), "Screen recording (by its name)".into())
            } else {
                (None, "Video".into())
            }
        }
        _ => (None, String::new()),
    }
}

fn type_reason(e: &Entry, top: &str) -> String {
    match top {
        "Shortcuts" => "Shortcut".into(),
        "Installers" => format!("Installer (.{})", e.ext),
        _ => format!("{} file (.{})", top.trim_end_matches('s'), e.ext),
    }
}

const MONTHS: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/// (year, month 1-12) of a Unix timestamp (UTC calendar; good enough for folders).
pub fn year_month(ts: i64) -> (i32, u32) {
    let days = ts.div_euclid(86_400);
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    ((y + (m <= 2) as i64) as i32, m as u32)
}

fn rule_matches(r: &Rule, e: &Entry, now: i64) -> bool {
    let v = r.value.trim().to_lowercase();
    match r.field.as_str() {
        "ext" => v.split([',', ' ']).filter(|x| !x.is_empty()).any(|x| x.trim_start_matches('.') == e.ext),
        "name" => !v.is_empty() && e.name.to_lowercase().contains(&v),
        "category" => e.cat.as_str() == v,
        "olderThanDays" => v.parse::<i64>().is_ok_and(|d| plausible_time(e.modified, now) && e.modified < now - d * 86_400),
        "largerThanMb" => v.parse::<f64>().is_ok_and(|mb| e.size as f64 >= mb * 1024.0 * 1024.0),
        _ => false,
    }
}

/// Union related files (same stem, edited versions) — one O(n) pass.
fn related_groups(files: &[Entry]) -> HashMap<u32, u32> {
    let mut parent: Vec<usize> = (0..files.len()).collect();
    fn find(p: &mut [usize], x: usize) -> usize {
        let mut r = x;
        while p[r] != r {
            r = p[r];
        }
        let mut c = x;
        while p[c] != r {
            let n = p[c];
            p[c] = r;
            c = n;
        }
        r
    }
    let mut by_stem: HashMap<String, Vec<usize>> = HashMap::new();
    let mut by_version: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, f) in files.iter().enumerate() {
        let (stem, _) = group_stem(&f.name);
        if stem.len() >= 2 {
            by_stem.entry(stem.clone()).or_default().push(i);
        }
        let (base, marked) = version_base(&stem);
        if base.len() >= 3 && matches!(f.cat, Category::Images | Category::Video | Category::Documents) {
            by_version.entry(format!("{}|{}", f.cat.as_str(), base)).or_default().push((i << 1) | marked as usize);
        }
    }
    for ids in by_stem.values().filter(|v| v.len() > 1 && v.len() <= 8) {
        for w in ids.windows(2) {
            let (a, b) = (find(&mut parent, w[0]), find(&mut parent, w[1]));
            parent[b] = a;
        }
    }
    for ids in by_version.values().filter(|v| v.len() > 1 && v.len() <= 8 && v.iter().any(|x| x & 1 == 1)) {
        for w in ids.windows(2) {
            let (a, b) = (find(&mut parent, w[0] >> 1), find(&mut parent, w[1] >> 1));
            parent[b] = a;
        }
    }
    let mut sets: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..files.len() {
        let r = find(&mut parent, i);
        sets.entry(r).or_default().push(i);
    }
    let rank = |f: &Entry| -> (u8, std::cmp::Reverse<u64>) {
        let k = match f.cat {
            Category::Video => 0,
            Category::Images => 1,
            Category::Audio => 2,
            Category::Documents if f.ext != "pdf" => 3,
            Category::Documents => 4,
            _ => 9,
        };
        (k, std::cmp::Reverse(f.size))
    };
    let mut primary_of = HashMap::new();
    for (_, mut set) in sets.into_iter().filter(|(_, s)| s.len() > 1) {
        set.sort_by_key(|&i| rank(&files[i]));
        for &m in &set[1..] {
            primary_of.insert(m as u32, set[0] as u32);
        }
    }
    primary_of
}

pub fn analyze(root: &Path, opts: &Options, now: i64) -> Result<Plan, String> {
    if !is_plain_absolute(root) || !root.is_dir() {
        return Err("Choose an existing folder.".into());
    }
    let (files, skipped, subs) = read_folder(root)?;
    let min = opts.min_group.max(2);
    let groups = if opts.keep_related { related_groups(&files) } else { HashMap::new() };
    let units: Vec<usize> = (0..files.len()).filter(|i| !groups.contains_key(&(*i as u32))).collect();

    let mut dest: HashMap<usize, (String, String)> = HashMap::new();
    let smart_like = |mode: &str, i: usize, dest: &mut HashMap<usize, (String, String)>| {
        let e = &files[i];
        let top = top_folder(e);
        let (sub, why) = if mode == "smart" { sub_folder(e) } else { (None, String::new()) };
        let reason = if why.is_empty() { type_reason(e, top) } else { why };
        dest.insert(i, (sub.map(|s| format!("{top}/{s}")).unwrap_or_else(|| top.to_string()), reason));
    };

    match opts.mode.as_str() {
        "date" => {
            for &i in &units {
                let e = &files[i];
                if plausible_time(e.modified, now) {
                    let (y, m) = year_month(e.modified);
                    dest.insert(i, (format!("{y}/{m:02} {}", MONTHS[m as usize - 1]), format!("Modified {} {y}", MONTHS[m as usize - 1])));
                } else {
                    dest.insert(i, ("Undated".into(), "No usable modification date".into()));
                }
            }
            // Small months fold into their year.
            let mut counts: HashMap<String, usize> = HashMap::new();
            for (d, _) in dest.values() {
                *counts.entry(d.clone()).or_default() += 1;
            }
            for (d, why) in dest.values_mut() {
                if counts[d.as_str()] < min && d.contains('/') {
                    *d = d.split('/').next().unwrap().to_string();
                    *why = format!("{why} (few files that month)");
                }
            }
        }
        "custom" => {
            for &i in &units {
                let e = &files[i];
                if let Some(r) = opts.rules.iter().find(|r| !r.dest.trim().is_empty() && rule_matches(r, e, now)) {
                    dest.insert(i, (r.dest.trim().replace('\\', "/"), format!("Rule: {} “{}”", r.field, r.value)));
                } else if opts.fallback == "smart" {
                    smart_like("smart", i, &mut dest);
                }
            }
        }
        mode => {
            let mode = if mode == "type" { "type" } else { "smart" };
            for &i in &units {
                smart_like(mode, i, &mut dest);
            }
            if mode == "smart" {
                // Subfolders only when the type folder is busy (≥ 2 × minimum) and the
                // subfolder itself reaches the minimum.
                let mut top_n: HashMap<String, usize> = HashMap::new();
                let mut sub_n: HashMap<String, usize> = HashMap::new();
                for (d, _) in dest.values() {
                    *top_n.entry(d.split('/').next().unwrap().to_string()).or_default() += 1;
                    *sub_n.entry(d.clone()).or_default() += 1;
                }
                for (d, _) in dest.values_mut() {
                    let top = d.split('/').next().unwrap().to_string();
                    if d.contains('/') && (top_n[&top] < (2 * min).max(6) || sub_n[d.as_str()] < min) {
                        *d = top;
                    }
                }
                // Very large folders spanning several years get year subfolders.
                let mut by_dest: HashMap<String, Vec<usize>> = HashMap::new();
                for (i, (d, _)) in &dest {
                    by_dest.entry(d.clone()).or_default().push(*i);
                }
                for (d, ids) in by_dest {
                    if ids.len() < 80 {
                        continue;
                    }
                    let years: HashSet<i32> = ids.iter().filter(|&&i| plausible_time(files[i].modified, now)).map(|&i| year_month(files[i].modified).0).collect();
                    if years.len() < 2 {
                        continue;
                    }
                    let mut per_year: HashMap<i32, usize> = HashMap::new();
                    for &i in &ids {
                        if plausible_time(files[i].modified, now) {
                            *per_year.entry(year_month(files[i].modified).0).or_default() += 1;
                        }
                    }
                    for &i in &ids {
                        if plausible_time(files[i].modified, now) {
                            let y = year_month(files[i].modified).0;
                            if per_year[&y] >= min {
                                let entry = dest.get_mut(&i).unwrap();
                                entry.0 = format!("{d}/{y}");
                            }
                        }
                    }
                }
            }
        }
    }

    // Too few files for a folder of their own: "Other" if enough, else stay.
    if opts.mode != "custom" {
        let mut counts: HashMap<String, usize> = HashMap::new();
        for (d, _) in dest.values() {
            *counts.entry(d.split('/').next().unwrap().to_string()).or_default() += 1;
        }
        let existing: HashSet<String> = subs.iter().map(|s| s.to_lowercase()).collect();
        let small: Vec<usize> = dest.iter().filter(|(_, (d, _))| {
            let top = d.split('/').next().unwrap();
            counts[top] < min && !existing.contains(&top.to_lowercase())
        }).map(|(i, _)| *i).collect();
        let to_other = small.len() >= min;
        for i in small {
            let e = dest.get_mut(&i).unwrap();
            if to_other {
                *e = ("Other".into(), format!("{} (too few similar files for their own folder)", e.1));
            } else {
                *e = (String::new(), "Too few similar files to justify a new folder".into());
            }
        }
    }

    // Satellites follow their primary.
    let mut out: Vec<PlanFile> = files
        .iter()
        .enumerate()
        .map(|(i, e)| {
            let (d, reason, group) = match groups.get(&(i as u32)) {
                Some(&p) => {
                    let pd = dest.get(&(p as usize)).map(|x| x.0.clone()).unwrap_or_default();
                    (pd, format!("Kept together with {}", files[p as usize].name), Some(p))
                }
                None => {
                    let (d, r) = dest.get(&i).cloned().unwrap_or_else(|| (String::new(), "No rule matched".into()));
                    (d, r, None)
                }
            };
            PlanFile { id: i as u32, name: e.name.clone(), size: e.size, modified: e.modified, created: e.created, category: e.cat.as_str(), dest: d, reason, group, conflict: None }
        })
        .collect();
    let primaries: HashSet<u32> = groups.values().copied().collect();
    for f in out.iter_mut().filter(|f| primaries.contains(&f.id) && f.group.is_none()) {
        f.group = Some(f.id);
    }

    mark_conflicts(root, &mut out);
    Ok(summarize(root, opts.mode.clone(), out, skipped, subs))
}

/// Recompute conflicts (also after the user edited destinations).
pub fn mark_conflicts(root: &Path, files: &mut [PlanFile]) {
    let mut seen: HashMap<String, usize> = HashMap::new();
    for f in files.iter() {
        if !f.dest.is_empty() {
            *seen.entry(format!("{}/{}", f.dest.to_lowercase(), f.name.to_lowercase())).or_default() += 1;
        }
    }
    for f in files.iter_mut() {
        f.conflict = None;
        if f.dest.is_empty() {
            continue;
        }
        if let Err(e) = validate_dest(&f.dest) {
            f.conflict = Some(e);
            continue;
        }
        let dir = root.join(f.dest.replace('/', "\\"));
        // A path component exists as a file?
        let mut p = root.to_path_buf();
        for c in f.dest.split('/') {
            p.push(c);
            if p.is_file() {
                f.conflict = Some(format!("“{c}” already exists as a file, so no folder can be created there."));
                break;
            }
        }
        if f.conflict.is_some() {
            continue;
        }
        if fs::symlink_metadata(dir.join(&f.name)).is_ok() {
            f.conflict = Some(format!("A file named “{}” already exists in {}.", f.name, f.dest));
        } else if seen[&format!("{}/{}", f.dest.to_lowercase(), f.name.to_lowercase())] > 1 {
            f.conflict = Some("Another file with the same name would land in the same folder.".into());
        }
    }
}

pub fn summarize(root: &Path, mode: String, files: Vec<PlanFile>, skipped: Vec<Skipped>, subs: Vec<String>) -> Plan {
    let mut folders: BTreeMap<String, (usize, u64)> = BTreeMap::new();
    for f in files.iter().filter(|f| !f.dest.is_empty()) {
        let e = folders.entry(f.dest.clone()).or_default();
        e.0 += 1;
        e.1 += f.size;
    }
    Plan {
        root: root.display().to_string(),
        mode,
        moving: files.iter().filter(|f| !f.dest.is_empty()).count(),
        staying: files.iter().filter(|f| f.dest.is_empty()).count(),
        conflicts: files.iter().filter(|f| f.conflict.is_some()).count(),
        folders: folders.into_iter().map(|(path, (n, b))| PlanFolder { exists: root.join(path.replace('/', "\\")).is_dir(), path, files: n, bytes: b }).collect(),
        files,
        skipped,
        existing_subfolders: subs,
    }
}

const RESERVED: &[&str] = &["con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"];

/// Relative folder path: 1–4 components, no "..", no illegal characters.
pub fn validate_dest(dest: &str) -> Result<Vec<String>, String> {
    let parts: Vec<String> = dest.replace('\\', "/").split('/').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    if parts.is_empty() || parts.len() > 4 {
        return Err("Folder paths can have 1 to 4 levels.".into());
    }
    for p in &parts {
        if p == "." || p == ".." || p.ends_with('.') || p.chars().any(|c| "<>:\"|?*".contains(c) || (c as u32) < 32) || RESERVED.contains(&p.to_lowercase().as_str()) || p.len() > 120 {
            return Err(format!("“{p}” is not a valid folder name."));
        }
    }
    Ok(parts)
}

/// File names from the UI (for "keep both" renames).
fn validate_name(n: &str) -> Result<(), String> {
    if n.trim().is_empty() || n.contains(['/', '\\']) || n.chars().any(|c| "<>:\"|?*".contains(c) || (c as u32) < 32) || n.ends_with('.') || n.ends_with(' ') {
        return Err(format!("“{n}” is not a valid file name."));
    }
    Ok(())
}

/// "name (2).ext" style alternative that is free in `dir`.
pub fn free_name(dir: &Path, name: &str, taken: &HashSet<String>) -> String {
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    for n in 2..1000 {
        let cand = format!("{stem} ({n}){ext}");
        if !taken.contains(&cand.to_lowercase()) && fs::symlink_metadata(dir.join(&cand)).is_err() {
            return cand;
        }
    }
    format!("{stem} ({}){ext}", std::process::id())
}

// ---------------------------------------------------------------- history

pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS organize_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, root TEXT NOT NULL, mode TEXT NOT NULL,
            moved INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
            cancelled INTEGER NOT NULL DEFAULT 0, finished INTEGER NOT NULL DEFAULT 0,
            undone_at INTEGER, restored INTEGER NOT NULL DEFAULT 0, kept INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE IF NOT EXISTS organize_items (
            run_id INTEGER NOT NULL REFERENCES organize_runs(id) ON DELETE CASCADE,
            seq INTEGER NOT NULL, src TEXT NOT NULL, dst TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL,
            status TEXT NOT NULL, error TEXT,
            PRIMARY KEY (run_id, seq)) WITHOUT ROWID;
         CREATE TABLE IF NOT EXISTS organize_dirs (
            run_id INTEGER NOT NULL REFERENCES organize_runs(id) ON DELETE CASCADE,
            path TEXT NOT NULL, PRIMARY KEY (run_id, path)) WITHOUT ROWID;",
    )
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyItem {
    pub name: String,
    pub dest: String,
    /// Different target name ("keep both").
    pub rename_to: Option<String>,
    pub size: u64,
    pub modified: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemResult {
    pub name: String,
    pub from: String,
    pub to: String,
    pub size: u64,
    pub status: String, // "moved" | "skipped" | "failed" | "restored" | "kept"
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub run_id: i64,
    pub root: String,
    pub mode: String,
    pub at: i64,
    pub moved: usize,
    pub skipped: usize,
    pub failed: usize,
    pub bytes: u64,
    pub cancelled: bool,
    pub folders_created: usize,
    pub items: Vec<ItemResult>,
    pub undone_at: Option<i64>,
    pub restored: usize,
    pub kept: usize,
    pub can_undo: bool,
}

/// Apply a reviewed plan. Every item is re-checked right before its move.
pub fn apply(conn: &Connection, root: &Path, mode: &str, items: &[ApplyItem], cancel: &AtomicBool, now: i64, mut progress: impl FnMut(usize, usize, &str)) -> Result<RunSummary, String> {
    if !is_plain_absolute(root) || !root.is_dir() {
        return Err("The folder is no longer available.".into());
    }
    let e = |x: rusqlite::Error| x.to_string();
    conn.execute("INSERT INTO organize_runs (at, root, mode) VALUES (?1, ?2, ?3)", params![now, root.display().to_string(), mode]).map_err(e)?;
    let run = conn.last_insert_rowid();
    let mut created: Vec<PathBuf> = Vec::new();
    let mut results = Vec::new();
    let total = items.len();
    let mut taken: HashMap<PathBuf, HashSet<String>> = HashMap::new();
    for (seq, it) in items.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        progress(seq, total, &it.name);
        let src = root.join(&it.name);
        let mut res = ItemResult { name: it.name.clone(), from: src.display().to_string(), to: String::new(), size: it.size, status: "skipped".into(), error: None };
        let outcome: Result<PathBuf, String> = (|| {
            if it.name.contains(['/', '\\']) || it.name == ".." {
                return Err("Invalid file name.".into());
            }
            let parts = validate_dest(&it.dest)?;
            let md = fs::symlink_metadata(&src).map_err(|_| "No longer in this folder.".to_string())?;
            if !md.is_file() {
                return Err("Not a regular file anymore.".into());
            }
            if md.len() != it.size || times_of(&md).1 != it.modified {
                return Err("Changed since the preview. Analyze the folder again.".into());
            }
            let mut dir = root.to_path_buf();
            for p in &parts {
                dir.push(p);
                match fs::symlink_metadata(&dir) {
                    Ok(m) if m.file_type().is_symlink() => return Err("The destination folder is a link to another location.".into()),
                    Ok(m) if !m.is_dir() => return Err(format!("“{p}” exists as a file.")),
                    Ok(_) => {}
                    Err(_) => {
                        fs::create_dir(&dir).map_err(|e| format!("Could not create folder: {}", crate::cleanup::friendly_error(&e.to_string())))?;
                        created.push(dir.clone());
                        conn.execute("INSERT OR IGNORE INTO organize_dirs (run_id, path) VALUES (?1, ?2)", params![run, dir.display().to_string()]).ok();
                    }
                }
            }
            let target_name = match &it.rename_to {
                Some(n) => {
                    validate_name(n)?;
                    n.clone()
                }
                None => it.name.clone(),
            };
            let dst = dir.join(&target_name);
            if fs::symlink_metadata(&dst).is_ok() || !taken.entry(dir.clone()).or_default().insert(target_name.to_lowercase()) {
                return Err("A file with this name is already there. Nothing was overwritten.".into());
            }
            // Must stay inside the chosen folder.
            if !normalize(&dst).starts_with(&format!("{}\\", normalize(root).trim_end_matches('\\'))) {
                return Err("Destination outside the folder.".into());
            }
            platform::rename_no_replace(&src, &dst).map_err(|e| crate::cleanup::friendly_error(&e.to_string()))?;
            Ok(dst)
        })();
        match outcome {
            Ok(dst) => {
                res.to = dst.display().to_string();
                res.status = "moved".into();
            }
            Err(msg) => {
                res.status = if msg.contains("open in another program") || msg.contains("denied") || msg.contains("Could not create") { "failed".into() } else { "skipped".into() };
                res.error = Some(msg);
            }
        }
        conn.execute(
            "INSERT INTO organize_items (run_id, seq, src, dst, size, mtime, status, error) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![run, seq as i64, res.from, res.to, it.size as i64, it.modified, res.status, res.error],
        )
        .map_err(e)?;
        results.push(res);
    }
    let cancelled = cancel.load(Ordering::SeqCst);
    let count = |s: &str| results.iter().filter(|r| r.status == s).count();
    conn.execute(
        "UPDATE organize_runs SET moved = ?2, skipped = ?3, failed = ?4, cancelled = ?5, finished = 1 WHERE id = ?1",
        params![run, count("moved") as i64, (count("skipped") + total - results.len()) as i64, count("failed") as i64, cancelled],
    )
    .map_err(e)?;
    progress(total, total, "");
    load_run(conn, run).map_err(e)
}

pub fn load_run(conn: &Connection, run: i64) -> rusqlite::Result<RunSummary> {
    let (at, root, mode, moved, skipped, failed, cancelled, undone_at, restored, kept): (i64, String, String, i64, i64, i64, bool, Option<i64>, i64, i64) = conn.query_row(
        "SELECT at, root, mode, moved, skipped, failed, cancelled, undone_at, restored, kept FROM organize_runs WHERE id = ?1",
        params![run],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?)),
    )?;
    let mut st = conn.prepare("SELECT src, dst, size, status, error FROM organize_items WHERE run_id = ?1 ORDER BY seq")?;
    let items: Vec<ItemResult> = st
        .query_map(params![run], |r| {
            let src: String = r.get(0)?;
            Ok(ItemResult { name: Path::new(&src).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(), from: src, to: r.get(1)?, size: r.get::<_, i64>(2)? as u64, status: r.get(3)?, error: r.get(4)? })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let folders: i64 = conn.query_row("SELECT COUNT(*) FROM organize_dirs WHERE run_id = ?1", params![run], |r| r.get(0))?;
    let bytes = items.iter().filter(|i| i.status == "moved" || i.status == "restored" || i.status == "kept").map(|i| i.size).sum();
    Ok(RunSummary {
        run_id: run,
        root,
        mode,
        at,
        moved: moved as usize,
        skipped: skipped as usize,
        failed: failed as usize,
        bytes,
        cancelled,
        folders_created: folders as usize,
        can_undo: undone_at.is_none() && items.iter().any(|i| i.status == "moved"),
        items,
        undone_at,
        restored: restored as usize,
        kept: kept as usize,
    })
}

pub fn runs(conn: &Connection, limit: i64) -> rusqlite::Result<Vec<RunSummary>> {
    let ids: Vec<i64> = conn.prepare("SELECT id FROM organize_runs WHERE finished = 1 ORDER BY id DESC LIMIT ?1")?.query_map(params![limit], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    ids.into_iter().map(|id| load_run(conn, id)).collect()
}

/// Move files back where they came from, if that is still safe. Folders
/// the run created are removed only if they are empty again.
pub fn undo(conn: &Connection, run: i64, now: i64) -> Result<RunSummary, String> {
    let e = |x: rusqlite::Error| x.to_string();
    let summary = load_run(conn, run).map_err(e)?;
    if summary.undone_at.is_some() {
        return Err("This organization was already undone.".into());
    }
    let mut st = conn.prepare("SELECT seq, src, dst, size, mtime FROM organize_items WHERE run_id = ?1 AND status = 'moved' ORDER BY seq DESC").map_err(e)?;
    let moved: Vec<(i64, String, String, i64, i64)> = st.query_map(params![run], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).map_err(e)?.collect::<rusqlite::Result<_>>().map_err(e)?;
    let (mut restored, mut kept) = (0, 0);
    for (seq, src, dst, size, mtime) in moved {
        let (src_p, dst_p) = (PathBuf::from(&src), PathBuf::from(&dst));
        let check: Result<(), String> = (|| {
            let md = fs::symlink_metadata(&dst_p).map_err(|_| "The file is no longer where CLARITY put it.".to_string())?;
            if !md.is_file() || md.len() != size as u64 || times_of(&md).1 != mtime {
                return Err("The file was changed after organizing, so it was left in place.".into());
            }
            if fs::symlink_metadata(&src_p).is_ok() {
                return Err("Another file now uses the original name, so it was left in place.".into());
            }
            if !src_p.parent().is_some_and(|p| p.is_dir()) {
                return Err("The original folder no longer exists.".into());
            }
            platform::rename_no_replace(&dst_p, &src_p).map_err(|e| crate::cleanup::friendly_error(&e.to_string()))
        })();
        let (status, err) = match check {
            Ok(()) => {
                restored += 1;
                ("restored", None)
            }
            Err(m) => {
                kept += 1;
                ("kept", Some(m))
            }
        };
        conn.execute("UPDATE organize_items SET status = ?3, error = ?4 WHERE run_id = ?1 AND seq = ?2", params![run, seq, status, err]).map_err(e)?;
    }
    // Remove folders we created, deepest first, only if empty.
    let mut dirs: Vec<String> = conn.prepare("SELECT path FROM organize_dirs WHERE run_id = ?1").map_err(e)?.query_map(params![run], |r| r.get(0)).map_err(e)?.collect::<rusqlite::Result<_>>().map_err(e)?;
    dirs.sort_by_key(|d| std::cmp::Reverse(d.len()));
    for d in dirs {
        let _ = fs::remove_dir(&d); // fails (harmlessly) unless empty
    }
    conn.execute("UPDATE organize_runs SET undone_at = ?2, restored = ?3, kept = ?4 WHERE id = ?1", params![run, now, restored, kept]).map_err(e)?;
    load_run(conn, run).map_err(e)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        init(&c).unwrap();
        c
    }

    fn opts(mode: &str) -> Options {
        Options { mode: mode.into(), ..Default::default() }
    }

    fn items(plan: &Plan) -> Vec<ApplyItem> {
        plan.files.iter().filter(|f| !f.dest.is_empty() && f.conflict.is_none()).map(|f| ApplyItem { name: f.name.clone(), dest: f.dest.clone(), rename_to: None, size: f.size, modified: f.modified }).collect()
    }

    #[test]
    fn dates() {
        assert_eq!(year_month(0), (1970, 1));
        assert_eq!(year_month(1_767_225_600), (2026, 1)); // 2026-01-01
        assert_eq!(year_month(1_709_251_200), (2024, 3)); // 2024-03-01 (leap year)
        assert!(validate_dest("Documents/PDFs").is_ok());
        assert!(validate_dest("../x").is_err());
        assert!(validate_dest("a:b").is_err());
        assert!(validate_dest("CON").is_err());
        assert!(validate_dest("").is_err());
    }

    #[test]
    fn smart_plan_groups_and_thresholds() {
        let t = tempfile::tempdir().unwrap();
        let r = t.path();
        let w = |n: &str| fs::write(r.join(n), b"x").unwrap();
        for i in 0..6 {
            w(&format!("invoice-{i}.pdf"));
        }
        for i in 0..4 {
            w(&format!("Screenshot 2026-0{i}.png"));
        }
        w("Report.docx");
        w("Report.pdf");
        w("Film.mkv");
        w("Film.en.srt");
        w("lonely.zip");
        w("setup.exe");
        w("partial.crdownload");
        fs::create_dir(r.join("Existing")).unwrap();
        let plan = analyze(r, &opts("smart"), 1_800_000_000).unwrap();
        let dest = |n: &str| plan.files.iter().find(|f| f.name == n).unwrap().dest.clone();
        assert_eq!(dest("invoice-0.pdf"), "Documents/PDFs");
        // 4 images are not enough to split the Images folder.
        assert_eq!(dest("Screenshot 2026-00.png"), "Images");
        // Related files move together.
        assert_eq!(dest("Report.pdf"), dest("Report.docx"));
        assert_eq!(dest("Film.en.srt"), dest("Film.mkv"));
        // Singletons: fewer than 3 per folder → "Other" when enough of them, else stay.
        assert!(["Other", ""].contains(&dest("lonely.zip").as_str()));
        assert!(plan.skipped.iter().any(|s| s.name == "partial.crdownload"));
        assert_eq!(plan.existing_subfolders, vec!["Existing".to_string()]);
    }

    #[test]
    fn apply_and_undo_round_trip() {
        let t = tempfile::tempdir().unwrap();
        let r = t.path();
        for i in 0..5 {
            fs::write(r.join(format!("doc{i}.pdf")), format!("pdf {i}")).unwrap();
        }
        fs::create_dir(r.join("Documents")).unwrap();
        fs::write(r.join("Documents").join("doc0.pdf"), b"already here").unwrap();
        let plan = analyze(r, &opts("type"), 1_800_000_000).unwrap();
        assert_eq!(plan.conflicts, 1);
        let c = db();
        let run = apply(&c, r, "type", &items(&plan), &AtomicBool::new(false), 1, |_, _, _| {}).unwrap();
        assert_eq!(run.moved, 4);
        assert!(r.join("Documents/doc3.pdf").exists() && !r.join("doc3.pdf").exists());
        // The conflicting file was never touched.
        assert_eq!(fs::read(r.join("Documents/doc0.pdf")).unwrap(), b"already here");
        assert!(r.join("doc0.pdf").exists());

        // A user edit after organizing blocks undo for that file only.
        fs::write(r.join("Documents/doc4.pdf"), b"edited later, longer").unwrap();
        let u = undo(&c, run.run_id, 2).unwrap();
        assert_eq!((u.restored, u.kept), (3, 1));
        assert!(r.join("doc1.pdf").exists() && r.join("Documents/doc4.pdf").exists());
        assert!(r.join("Documents").exists()); // pre-existing folder kept
        assert!(undo(&c, run.run_id, 3).is_err());
    }

    #[test]
    fn created_folders_are_removed_on_undo_and_conflicts_never_overwrite() {
        let t = tempfile::tempdir().unwrap();
        let r = t.path();
        fs::write(r.join("a.txt"), b"a").unwrap();
        fs::write(r.join("b.txt"), b"b").unwrap();
        let c = db();
        let mut its: Vec<ApplyItem> = ["a.txt", "b.txt"].iter().map(|n| {
            let md = fs::metadata(r.join(n)).unwrap();
            ApplyItem { name: n.to_string(), dest: "New/Deep".into(), rename_to: None, size: md.len(), modified: times_of(&md).1 }
        }).collect();
        // Second item targets the same name as the first: must be refused.
        its[1].rename_to = Some("a.txt".into());
        let run = apply(&c, r, "custom", &its, &AtomicBool::new(false), 1, |_, _, _| {}).unwrap();
        assert_eq!(run.moved, 1);
        assert_eq!(fs::read(r.join("New/Deep/a.txt")).unwrap(), b"a");
        assert!(r.join("b.txt").exists());
        undo(&c, run.run_id, 2).unwrap();
        assert!(r.join("a.txt").exists());
        assert!(!r.join("New").exists(), "empty folders created by the run are removed");
        let runs = runs(&c, 10).unwrap();
        assert_eq!(runs.len(), 1);
        assert!(runs[0].undone_at.is_some() && !runs[0].can_undo);
    }

    #[test]
    fn date_and_custom_modes() {
        let t = tempfile::tempdir().unwrap();
        let r = t.path();
        for i in 0..4 {
            fs::write(r.join(format!("note{i}.txt")), b"n").unwrap();
        }
        fs::write(r.join("big.iso"), vec![0u8; 3 * 1024 * 1024]).unwrap();
        let now = crate::scan::now_unix();
        let d = analyze(r, &opts("date"), now).unwrap();
        let (y, m) = year_month(now);
        assert!(d.files.iter().filter(|f| f.name.starts_with("note")).all(|f| f.dest == format!("{y}/{m:02} {}", MONTHS[m as usize - 1])));
        let custom = Options { mode: "custom".into(), rules: vec![Rule { field: "largerThanMb".into(), value: "2".into(), dest: "Big stuff".into() }], fallback: "stay".into(), ..Default::default() };
        let p = analyze(r, &custom, now).unwrap();
        assert_eq!(p.files.iter().find(|f| f.name == "big.iso").unwrap().dest, "Big stuff");
        assert!(p.files.iter().filter(|f| f.name.starts_with("note")).all(|f| f.dest.is_empty()));
        assert!(free_name(r, "note0.txt", &HashSet::new()).starts_with("note0 (2)"));
    }
}
