//! Rule-based detection of related files.
//!
//! Everything is derived from names, extensions, folder structure, sizes and
//! (when available) verified duplicate groups. No content is read and
//! nothing leaves the machine. Each relation carries a confidence:
//!
//! - `confident`: an established convention (video + same-named subtitle,
//!   RAW + JPEG pair, sidecar files, verified identical copies)
//! - `likely`: strong naming evidence (document + same-named PDF, edited
//!   versions next to the original, same name and size elsewhere)
//! - `possible`: structural hints only (project file + media in its folder)

use crate::duplicates::DupResult;
use crate::model::{flags, Category, ScanIndex, NONE};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    Confident,
    Likely,
    Possible,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Relation {
    pub id: u32,
    /// Machine-readable kind, e.g. "subtitle", "rawPair", "export".
    pub kind: &'static str,
    /// What the *other* file is, from this file's point of view.
    pub label: String,
    pub confidence: Confidence,
    pub reason: String,
}

const SUBS: &[&str] = &["srt", "ass", "ssa", "vtt", "sub", "idx", "sup"];
const RAW: &[&str] = &["cr2", "cr3", "nef", "arw", "dng", "raf", "orf", "rw2", "pef", "srw"];
const DEVELOPED: &[&str] = &["jpg", "jpeg", "heic", "heif", "tif", "tiff", "png"];
const SIDECARS: &[&str] = &["xmp", "aae", "thm", "pp3", "dop"];
const DOC_SOURCES: &[&str] = &["docx", "doc", "odt", "rtf", "pages", "pptx", "ppt", "odp", "key", "xlsx", "xls", "ods", "numbers", "md", "tex", "indd"];
const DESIGN_SOURCES: &[&str] = &["psd", "psb", "ai", "xcf", "kra", "afphoto", "afdesign", "sketch", "fig", "svg"];
const PROJECTS: &[&str] = &["prproj", "aep", "drp", "fcpxml", "kdenlive", "veg", "mlt", "blend", "c4d", "max", "ma", "mb", "als", "flp", "cpr", "ptx", "rpp", "logicx", "psd", "psb", "kra", "xcf", "afphoto", "afdesign", "indd"];
const ASSET_DIRS: &[&str] = &["assets", "asset", "footage", "media", "audio", "music", "renders", "render", "exports", "export", "images", "img", "textures", "sources", "source", "raw", "clips", "sfx", "links"];
const EDIT_DIRS: &[&str] = &["edited", "edits", "exports", "export", "bearbeitet", "final", "finals", "retouched", "processed", "output"];

/// Stem (lower-case) and extension. "movie.en.srt" → ("movie.en", "srt").
pub fn split(name: &str) -> (String, String) {
    let lower = name.to_lowercase();
    match lower.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem.to_string(), ext.to_string()),
        _ => (lower, String::new()),
    }
}

/// Subtitle stems often carry a language or flag: "movie.en", "movie.de.forced".
fn subtitle_base(stem: &str) -> &str {
    let mut s = stem;
    for _ in 0..2 {
        if let Some((head, tail)) = s.rsplit_once('.') {
            let tag = tail.len() <= 3 && tail.chars().all(|c| c.is_ascii_alphabetic()) || matches!(tail, "forced" | "sdh" | "cc" | "hi" | "default");
            if tag && !head.is_empty() {
                s = head;
                continue;
            }
        }
        break;
    }
    s
}

const VERSION_WORDS: &[&str] = &["edited", "edit", "bearbeitet", "final", "retouched", "export", "exported", "hdr", "enhanced", "copy", "kopie", "crop", "cropped", "small", "web", "print", "compressed", "lowres", "hires", "new", "old", "orig", "original"];

/// Strip version markers: "IMG_1234-edited (2)" → "img_1234".
/// Returns (base, whether anything was stripped).
pub fn version_base(stem: &str) -> (String, bool) {
    let mut s = stem.trim().to_lowercase();
    let mut changed = false;
    loop {
        let before = s.clone();
        // " (2)" / "(2)"
        if s.ends_with(')') {
            if let Some(open) = s.rfind('(') {
                if s[open + 1..s.len() - 1].chars().all(|c| c.is_ascii_digit()) && open + 2 < s.len() {
                    s.truncate(open);
                }
            }
        }
        s = s.trim_end_matches([' ', '-', '_', '.']).to_string();
        // trailing version words, possibly with separators: "-edited", " - copy", "_v2", "v3"
        if let Some(pos) = s.rfind([' ', '-', '_']) {
            let tail = &s[pos + 1..];
            let is_version = VERSION_WORDS.contains(&tail) || (tail.len() >= 2 && tail.starts_with('v') && tail[1..].chars().all(|c| c.is_ascii_digit()));
            if is_version && pos > 0 {
                s.truncate(pos);
            }
        }
        s = s.trim_end_matches([' ', '-', '_', '.']).to_string();
        if s == before {
            break;
        }
        changed = true;
    }
    (s, changed)
}

/// Lazily built lookup tables for one scan index.
pub struct RelIndex {
    /// lower-case file name → ids (for copies elsewhere)
    by_name: HashMap<String, Vec<u32>>,
    /// file id → duplicate group members (verified)
    dup_of: HashMap<u32, Vec<u32>>,
}

impl RelIndex {
    pub fn build(index: &ScanIndex, dups: Option<&DupResult>) -> Self {
        let mut by_name: HashMap<String, Vec<u32>> = HashMap::new();
        for (i, f) in index.files.iter().enumerate() {
            if f.flags & flags::REMOVED == 0 && f.size >= 64 * 1024 {
                by_name.entry(f.name.to_lowercase()).or_default().push(i as u32);
            }
        }
        by_name.retain(|_, v| v.len() > 1 && v.len() <= 50);
        let mut dup_of = HashMap::new();
        if let Some(d) = dups {
            for g in &d.groups {
                for &f in &g.files {
                    dup_of.insert(f, g.files.clone());
                }
            }
        }
        Self { by_name, dup_of }
    }
}

fn live(index: &ScanIndex, id: usize) -> bool {
    index.files[id].flags & flags::REMOVED == 0
}

/// All relations of file `id`, strongest first.
pub fn related(index: &ScanIndex, rel: &RelIndex, id: u32) -> Vec<Relation> {
    let f = &index.files[id as usize];
    let (stem, ext) = split(&f.name);
    let mut out: Vec<Relation> = Vec::new();
    let push = |out: &mut Vec<Relation>, other: u32, kind: &'static str, label: &str, c: Confidence, reason: String| {
        if other != id && !out.iter().any(|r| r.id == other) {
            out.push(Relation { id: other, kind, label: label.to_string(), confidence: c, reason });
        }
    };

    // ---- siblings in the same folder
    let siblings: Vec<usize> = index.files_of(f.dir).filter(|&s| s != id as usize && live(index, s)).collect();
    let (my_base, my_versioned) = version_base(&stem);
    for &s in &siblings {
        let g = &index.files[s];
        let (gs, ge) = split(&g.name);
        let same_stem = gs == stem;
        let s32 = s as u32;
        // Video ↔ subtitles
        if f.cat == Category::Video && SUBS.contains(&ge.as_str()) && subtitle_base(&gs) == stem {
            push(&mut out, s32, "subtitle", "Subtitle", Confidence::Confident, format!("“{}” has the same name as the video, with a subtitle extension.", g.name));
        } else if SUBS.contains(&ext.as_str()) && g.cat == Category::Video && subtitle_base(&stem) == gs {
            push(&mut out, s32, "subtitle", "Video for this subtitle", Confidence::Confident, "The video has the same name as this subtitle file.".into());
        }
        // RAW ↔ developed photo
        else if same_stem && RAW.contains(&ext.as_str()) && DEVELOPED.contains(&ge.as_str()) {
            push(&mut out, s32, "rawPair", "Developed copy of this RAW photo", Confidence::Confident, "Cameras save RAW and JPEG/HEIC versions of a shot under the same name.".into());
        } else if same_stem && DEVELOPED.contains(&ext.as_str()) && RAW.contains(&ge.as_str()) {
            push(&mut out, s32, "rawPair", "RAW original", Confidence::Confident, "Cameras save RAW and JPEG/HEIC versions of a shot under the same name.".into());
        }
        // Sidecars (IMG_1.xmp or IMG_1.CR2.xmp)
        else if SIDECARS.contains(&ge.as_str()) && (same_stem || gs == f.name.to_lowercase()) {
            push(&mut out, s32, "sidecar", "Sidecar with edit settings", Confidence::Confident, format!("{} files store edits or metadata for the file of the same name.", ge.to_uppercase()));
        } else if SIDECARS.contains(&ext.as_str()) && (same_stem || stem == g.name.to_lowercase()) {
            push(&mut out, s32, "sidecar", "File this sidecar describes", Confidence::Confident, format!("{} sidecars belong to the file of the same name.", ext.to_uppercase()));
        }
        // Lyrics / cue sheets
        else if f.cat == Category::Audio && same_stem && matches!(ge.as_str(), "lrc" | "cue") {
            push(&mut out, s32, "lyrics", if ge == "cue" { "Cue sheet" } else { "Lyrics" }, Confidence::Confident, "Same name as the audio file.".into());
        } else if matches!(ext.as_str(), "lrc" | "cue") && same_stem && g.cat == Category::Audio {
            push(&mut out, s32, "lyrics", "Audio file", Confidence::Confident, "Same name as this file.".into());
        }
        // Documents / designs ↔ exports
        else if same_stem && (DOC_SOURCES.contains(&ext.as_str()) && ge == "pdf" || DESIGN_SOURCES.contains(&ext.as_str()) && matches!(ge.as_str(), "png" | "jpg" | "jpeg" | "pdf" | "webp")) {
            push(&mut out, s32, "export", "Export", Confidence::Likely, format!("A .{ge} with the same name usually is an export of this .{ext} file."));
        } else if same_stem && (ext == "pdf" && DOC_SOURCES.contains(&ge.as_str()) || matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "pdf" | "webp") && DESIGN_SOURCES.contains(&ge.as_str())) {
            push(&mut out, s32, "export", "Source file", Confidence::Likely, format!("This file is probably exported from the .{ge} of the same name."));
        }
        // Video ↔ poster / thumbnail image
        else if same_stem && f.cat == Category::Video && g.cat == Category::Images {
            push(&mut out, s32, "poster", "Poster or thumbnail", Confidence::Likely, "An image with the same name as the video.".into());
        } else if same_stem && f.cat == Category::Images && g.cat == Category::Video {
            push(&mut out, s32, "poster", "Video this image belongs to", Confidence::Likely, "A video with the same name as this image.".into());
        }
        // Edited / other versions in the same folder
        else if f.cat == g.cat && matches!(f.cat, Category::Images | Category::Video | Category::Audio | Category::Documents) && !same_stem {
            let (gb, g_versioned) = version_base(&gs);
            if gb == my_base && gb.len() >= 3 && (my_versioned || g_versioned) {
                let label = if g_versioned && !my_versioned { "Edited or other version" } else if my_versioned && !g_versioned { "Original" } else { "Other version" };
                push(&mut out, s32, "version", label, Confidence::Likely, "Same name apart from a version marker like “edited”, “final”, “v2” or “(1)”.".into());
            }
        }
    }

    // ---- versions in an "Edited"/"Exports" subfolder or parent
    if matches!(f.cat, Category::Images | Category::Video) {
        let d = &index.dirs[f.dir as usize];
        let mut related_dirs: Vec<u32> = index.children(f.dir).map(|c| c as u32).filter(|&c| EDIT_DIRS.contains(&index.dirs[c as usize].name.to_lowercase().as_str())).collect();
        if EDIT_DIRS.contains(&d.name.to_lowercase().as_str()) && d.parent != NONE {
            related_dirs.push(d.parent);
        }
        for rd in related_dirs {
            for s in index.files_of(rd).filter(|&s| live(index, s)) {
                let g = &index.files[s];
                if g.cat != f.cat {
                    continue;
                }
                let (gs, _) = split(&g.name);
                if version_base(&gs).0 == my_base && my_base.len() >= 3 {
                    let up = rd == d.parent;
                    push(&mut out, s as u32, "version", if up { "Original" } else { "Edited version" }, Confidence::Likely, format!("Same base name in the “{}” folder.", index.dirs[rd as usize].name));
                }
            }
        }
    }

    // ---- verified duplicates, then same name + size elsewhere
    if let Some(members) = rel.dup_of.get(&id) {
        for &m in members.iter().filter(|&&m| live(index, m as usize)) {
            push(&mut out, m, "copy", "Identical copy", Confidence::Confident, "Byte-for-byte identical (verified by the duplicate search).".into());
        }
    }
    if let Some(same) = rel.by_name.get(&f.name.to_lowercase()) {
        for &m in same.iter().filter(|&&m| m != id && live(index, m as usize)) {
            let g = &index.files[m as usize];
            if g.size == f.size && g.dir != f.dir {
                push(&mut out, m, "copy", "Probable copy", Confidence::Likely, "Same name and exactly the same size in another folder. Run the duplicate search to verify.".into());
            }
        }
    }

    // ---- project files and their assets
    if PROJECTS.contains(&ext.as_str()) {
        let mut assets: Vec<usize> = Vec::new();
        for s in &siblings {
            if matches!(index.files[*s].cat, Category::Images | Category::Video | Category::Audio) {
                assets.push(*s);
            }
        }
        for c in index.children(f.dir) {
            if ASSET_DIRS.contains(&index.dirs[c].name.to_lowercase().as_str()) {
                assets.extend(index.files_of(c as u32).filter(|&s| live(index, s) && matches!(index.files[s].cat, Category::Images | Category::Video | Category::Audio)));
            }
        }
        assets.sort_by_key(|&s| std::cmp::Reverse(index.files[s].size));
        let n = assets.len();
        for s in assets.into_iter().take(24) {
            push(&mut out, s as u32, "asset", "Possible project asset", Confidence::Possible, format!("Media stored next to this project file{}.", if n > 24 { format!(" (showing 24 of {n})") } else { String::new() }));
        }
    } else if matches!(f.cat, Category::Images | Category::Video | Category::Audio) {
        let d = &index.dirs[f.dir as usize];
        let mut look = vec![f.dir];
        if ASSET_DIRS.contains(&d.name.to_lowercase().as_str()) && d.parent != NONE {
            look.push(d.parent);
        }
        for dir in look {
            for s in index.files_of(dir).filter(|&s| live(index, s)) {
                if PROJECTS.contains(&split(&index.files[s].name).1.as_str()) && s != id as usize {
                    push(&mut out, s as u32, "asset", "Project that may use this file", Confidence::Possible, "A project file in the same or parent folder.".into());
                }
            }
        }
    }

    out.sort_by(|a, b| a.confidence.cmp(&b.confidence).then_with(|| a.kind.cmp(b.kind)));
    out
}

/// Kinds that make a file a "satellite" of a media file in the gallery.
pub fn groups_with_media(kind: &str) -> bool {
    matches!(kind, "subtitle" | "rawPair" | "sidecar" | "poster" | "lyrics" | "version")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scan::{scan, Progress, ScanOptions};
    use std::fs;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn version_bases() {
        assert_eq!(version_base("img_1234-edited (2)"), ("img_1234".into(), true));
        assert_eq!(version_base("report_final_v2"), ("report".into(), true));
        assert_eq!(version_base("holiday - copy"), ("holiday".into(), true));
        assert_eq!(version_base("plain"), ("plain".into(), false));
        assert_eq!(subtitle_base("movie.en.forced"), "movie");
        assert_eq!(subtitle_base("movie"), "movie");
    }

    fn names(idx: &ScanIndex, rels: &[Relation]) -> Vec<(String, Confidence)> {
        let mut v: Vec<_> = rels.iter().map(|r| (idx.files[r.id as usize].name.to_string(), r.confidence)).collect();
        v.sort();
        v
    }

    #[test]
    fn detects_common_relationships() {
        let t = tempfile::tempdir().unwrap();
        let r = t.path();
        for d in ["movies", "photos/Edited", "docs", "proj/footage", "elsewhere"] {
            fs::create_dir_all(r.join(d)).unwrap();
        }
        let w = |p: &str, n: usize| fs::write(r.join(p), vec![7u8; n]).unwrap();
        w("movies/Film.mkv", 1000);
        w("movies/Film.en.srt", 10);
        w("movies/Film.de.forced.srt", 10);
        w("movies/Other.srt", 10);
        w("photos/IMG_1.CR2", 900);
        w("photos/IMG_1.JPG", 300);
        w("photos/IMG_1.xmp", 5);
        w("photos/Edited/IMG_1-edited.jpg", 310);
        w("docs/Thesis.docx", 400);
        w("docs/Thesis.pdf", 500);
        w("proj/cut.prproj", 50);
        w("proj/footage/a.mp4", 800);
        w("elsewhere/IMG_1.JPG", 300);
        let idx = scan(&ScanOptions { roots: vec![r.into()], exclusions: vec![], skip_system: false }, &AtomicBool::new(false), &Progress::default());
        let rel = RelIndex::build(&idx, None);
        let id = |dir: &str, n: &str| idx.files.iter().position(|f| &*f.name == n && idx.dir_path(f.dir).ends_with(dir)).unwrap() as u32;

        let film = related(&idx, &rel, id("movies", "Film.mkv"));
        assert_eq!(names(&idx, &film), vec![("Film.de.forced.srt".into(), Confidence::Confident), ("Film.en.srt".into(), Confidence::Confident)]);

        let jpg = related(&idx, &rel, id("photos", "IMG_1.JPG"));
        let n = names(&idx, &jpg);
        assert!(n.contains(&("IMG_1.CR2".into(), Confidence::Confident)));
        assert!(n.contains(&("IMG_1.xmp".into(), Confidence::Confident)));
        assert!(n.contains(&("IMG_1-edited.jpg".into(), Confidence::Likely)));
        // Same name but the size is below the "copy" floor (64 KB): not reported.
        assert!(!n.iter().any(|(_, c)| *c == Confidence::Possible));

        let thesis = related(&idx, &rel, id("docs", "Thesis.pdf"));
        assert_eq!(names(&idx, &thesis), vec![("Thesis.docx".into(), Confidence::Likely)]);

        let project = related(&idx, &rel, id("proj", "cut.prproj"));
        assert_eq!(names(&idx, &project), vec![("a.mp4".into(), Confidence::Possible)]);
        let asset = related(&idx, &rel, id("footage", "a.mp4"));
        assert_eq!(names(&idx, &asset), vec![("cut.prproj".into(), Confidence::Possible)]);

        // An unrelated subtitle is not attached to anything.
        assert!(related(&idx, &rel, id("movies", "Other.srt")).is_empty());
    }

    #[test]
    fn copies_by_name_and_size() {
        let t = tempfile::tempdir().unwrap();
        fs::create_dir_all(t.path().join("a")).unwrap();
        fs::create_dir_all(t.path().join("b")).unwrap();
        fs::write(t.path().join("a/clip.mov"), vec![1u8; 70_000]).unwrap();
        fs::write(t.path().join("b/clip.mov"), vec![2u8; 70_000]).unwrap();
        fs::write(t.path().join("b/CLIP.MOV.bak"), vec![2u8; 70_000]).unwrap();
        let idx = scan(&ScanOptions { roots: vec![t.path().into()], exclusions: vec![], skip_system: false }, &AtomicBool::new(false), &Progress::default());
        let rel = RelIndex::build(&idx, None);
        let a = idx.files.iter().position(|f| &*f.name == "clip.mov" && idx.dir_path(f.dir).ends_with("a")).unwrap() as u32;
        let r = related(&idx, &rel, a);
        assert_eq!(r.len(), 1);
        assert_eq!((r[0].kind, r[0].confidence), ("copy", Confidence::Likely));
    }
}
