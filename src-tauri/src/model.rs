//! In-memory representation of a scan.
//!
//! The index is built breadth-first, which gives two useful invariants:
//! a directory's id is always larger than its parent's, and the children
//! (directories and files) of one directory occupy a contiguous id range.
//! Paths are never stored per file; they are rebuilt from the parent chain.

use serde::{Deserialize, Serialize};
use std::ops::Range;
use std::path::{Path, PathBuf};

pub const NONE: u32 = u32::MAX;

/// Bit flags shared by files and directories.
pub mod flags {
    /// Cloud placeholder (OneDrive etc.): content is not stored locally.
    pub const CLOUD: u8 = 1;
    pub const HIDDEN: u8 = 2;
    /// Carries the Windows SYSTEM attribute.
    pub const SYSTEM: u8 = 4;
    pub const READONLY: u8 = 8;
    /// Removed by a CLARITY cleanup after the scan.
    pub const REMOVED: u8 = 16;
    /// Directory could not be (fully) read.
    pub const UNREADABLE: u8 = 32;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Documents,
    Images,
    Video,
    Audio,
    Archives,
    Installers,
    Code,
    Apps,
    System,
    Other,
}

impl Category {
    pub const ALL: [Category; 10] = [
        Category::Documents,
        Category::Images,
        Category::Video,
        Category::Audio,
        Category::Archives,
        Category::Installers,
        Category::Code,
        Category::Apps,
        Category::System,
        Category::Other,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Category::Documents => "documents",
            Category::Images => "images",
            Category::Video => "video",
            Category::Audio => "audio",
            Category::Archives => "archives",
            Category::Installers => "installers",
            Category::Code => "code",
            Category::Apps => "apps",
            Category::System => "system",
            Category::Other => "other",
        }
    }

    pub fn parse(s: &str) -> Option<Category> {
        Category::ALL.into_iter().find(|c| c.as_str() == s)
    }

    pub fn from_name(name: &str) -> Category {
        let ext = ext_of(name);
        match ext.as_str() {
            "pdf" | "doc" | "docx" | "odt" | "rtf" | "txt" | "md" | "xls" | "xlsx" | "ods"
            | "csv" | "ppt" | "pptx" | "odp" | "pages" | "numbers" | "key" | "epub" | "tex"
            | "one" | "msg" | "eml" => Category::Documents,
            "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "tif" | "tiff" | "heic" | "heif"
            | "avif" | "svg" | "ico" | "raw" | "cr2" | "cr3" | "nef" | "arw" | "dng" | "psd"
            | "ai" | "xcf" => Category::Images,
            "mp4" | "mkv" | "mov" | "avi" | "wmv" | "webm" | "m4v" | "flv" | "mpg" | "mpeg"
            | "3gp" | "mts" | "m2ts" | "vob" => Category::Video,
            "mp3" | "wav" | "flac" | "aac" | "m4a" | "ogg" | "opus" | "wma" | "aiff" | "aif"
            | "alac" | "mid" | "midi" => Category::Audio,
            "zip" | "7z" | "rar" | "tar" | "gz" | "tgz" | "bz2" | "xz" | "zst" | "cab"
            | "lz" | "lzma" => Category::Archives,
            "msi" | "msix" | "msixbundle" | "appx" | "appxbundle" | "iso" | "img" | "dmg"
            | "pkg" | "deb" | "rpm" | "apk" => Category::Installers,
            "rs" | "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "py" | "java" | "kt" | "c"
            | "h" | "cpp" | "hpp" | "cc" | "cs" | "go" | "rb" | "php" | "swift" | "json"
            | "yaml" | "yml" | "toml" | "xml" | "html" | "css" | "scss" | "sql" | "sh"
            | "ps1" | "lua" | "ipynb" | "vue" | "svelte" | "map" | "lock" => Category::Code,
            "exe" | "dll" | "com" | "jar" | "appimage" | "pak" | "asar" | "node" | "so"
            | "dylib" => Category::Apps,
            "sys" | "tmp" | "log" | "dmp" | "etl" | "evtx" | "cat" | "mui" | "vhd" | "vhdx"
            | "vmdk" | "bak" | "old" | "db" | "dat" | "ldf" | "mdf" | "edb" => Category::System,
            _ => Category::Other,
        }
    }
}

/// 1990-01-01. Earlier modification dates are almost always placeholders:
/// ZIP/FAT cannot store dates before 1980, so extractors, package managers
/// and model downloads often stamp files with 1980-01-01.
pub const PLAUSIBLE_SINCE: i64 = 631_152_000;

/// `true` if a timestamp can be trusted for age-based reasoning: not
/// missing, not a 1980-style placeholder, not in the future.
pub fn plausible_time(t: i64, now: i64) -> bool {
    t >= PLAUSIBLE_SINCE && t <= now + 86_400
}

/// Lower-cased extension without the dot. Dotfiles (".gitignore") have none.
pub fn ext_of(name: &str) -> String {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => ext.to_ascii_lowercase(),
        _ => String::new(),
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FileRec {
    pub dir: u32,
    pub name: Box<str>,
    pub size: u64,
    /// Unix seconds; 0 = unknown.
    pub created: i64,
    pub modified: i64,
    pub accessed: i64,
    pub cat: Category,
    pub flags: u8,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DirRec {
    pub parent: u32,
    /// For roots this is the full root path, otherwise a single component.
    pub name: Box<str>,
    pub first_child: u32,
    pub child_count: u32,
    pub first_file: u32,
    pub file_count: u32,
    /// Bytes of files directly inside this directory.
    pub own_size: u64,
    /// Bytes of everything below this directory.
    pub total_size: u64,
    pub total_files: u64,
    /// Newest modification time of anything below (incl. the dir itself).
    pub latest_mtime: i64,
    pub modified: i64,
    pub flags: u8,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScanIssue {
    pub path: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct ScanIndex {
    pub id: String,
    pub started_at: i64,
    pub finished_at: i64,
    pub duration_ms: u64,
    pub roots: Vec<u32>,
    pub dirs: Vec<DirRec>,
    pub files: Vec<FileRec>,
    pub issues: Vec<ScanIssue>,
    pub error_count: u64,
    pub links_skipped: u64,
    pub excluded_skipped: u64,
    pub cancelled: bool,
    /// Loaded from the on-disk cache rather than scanned in this session.
    #[serde(default)]
    pub cached: bool,
}

impl ScanIndex {
    pub fn children(&self, dir: u32) -> Range<usize> {
        let d = &self.dirs[dir as usize];
        d.first_child as usize..(d.first_child + d.child_count) as usize
    }

    pub fn files_of(&self, dir: u32) -> Range<usize> {
        let d = &self.dirs[dir as usize];
        d.first_file as usize..(d.first_file + d.file_count) as usize
    }

    pub fn dir_path(&self, mut id: u32) -> PathBuf {
        let mut parts: Vec<&str> = Vec::new();
        while id != NONE {
            let d = &self.dirs[id as usize];
            parts.push(&d.name);
            id = d.parent;
        }
        let mut p = PathBuf::new();
        for part in parts.iter().rev() {
            p.push(part);
        }
        p
    }

    pub fn file_path(&self, id: u32) -> PathBuf {
        let f = &self.files[id as usize];
        self.dir_path(f.dir).join(&*f.name)
    }

    pub fn root_of(&self, mut id: u32) -> u32 {
        loop {
            let p = self.dirs[id as usize].parent;
            if p == NONE {
                return id;
            }
            id = p;
        }
    }

    pub fn is_root(&self, id: u32) -> bool {
        self.dirs[id as usize].parent == NONE
    }

    pub fn depth(&self, mut id: u32) -> u32 {
        let mut n = 0;
        while self.dirs[id as usize].parent != NONE {
            id = self.dirs[id as usize].parent;
            n += 1;
        }
        n
    }

    pub fn total_bytes(&self) -> u64 {
        self.roots.iter().map(|&r| self.dirs[r as usize].total_size).sum()
    }

    pub fn total_files(&self) -> u64 {
        self.roots.iter().map(|&r| self.dirs[r as usize].total_files).sum()
    }

    /// Resolve an absolute path to a directory id, case-insensitively.
    pub fn find_dir(&self, path: &Path) -> Option<u32> {
        let target = crate::paths::normalize(path);
        for &root in &self.roots {
            let root_norm = crate::paths::normalize(Path::new(&*self.dirs[root as usize].name));
            if target == root_norm {
                return Some(root);
            }
            let Some(rest) = crate::paths::strip_under(&target, &root_norm) else {
                continue;
            };
            let mut cur = root;
            for comp in rest.split('\\').filter(|c| !c.is_empty()) {
                let next = self
                    .children(cur)
                    .find(|&c| self.dirs[c].name.to_lowercase() == comp)?;
                cur = next as u32;
            }
            return Some(cur);
        }
        None
    }

    /// `true` if `dir` is `ancestor` or lies below it.
    pub fn is_within(&self, mut dir: u32, ancestor: u32) -> bool {
        while dir != NONE {
            if dir == ancestor {
                return true;
            }
            dir = self.dirs[dir as usize].parent;
        }
        false
    }

    /// Per-directory membership in the subtree of `root` (BFS order makes this O(n)).
    pub fn subtree_mask(&self, root: u32) -> Vec<bool> {
        let mut mask = vec![false; self.dirs.len()];
        for (i, d) in self.dirs.iter().enumerate() {
            mask[i] = i as u32 == root || (d.parent != NONE && mask[d.parent as usize]);
        }
        mask
    }

    fn subtract_up(&mut self, mut dir: u32, bytes: u64, files: u64) {
        while dir != NONE {
            let d = &mut self.dirs[dir as usize];
            d.total_size = d.total_size.saturating_sub(bytes);
            d.total_files = d.total_files.saturating_sub(files);
            dir = d.parent;
        }
    }

    /// Reflect a successful removal of a file in the index.
    pub fn mark_file_removed(&mut self, id: u32) {
        let (dir, size) = {
            let f = &mut self.files[id as usize];
            if f.flags & flags::REMOVED != 0 {
                return;
            }
            f.flags |= flags::REMOVED;
            (f.dir, f.size)
        };
        self.dirs[dir as usize].own_size = self.dirs[dir as usize].own_size.saturating_sub(size);
        self.subtract_up(dir, size, 1);
    }

    /// Reflect a successful removal of a whole directory subtree in the index.
    pub fn mark_dir_removed(&mut self, id: u32) {
        if self.dirs[id as usize].flags & flags::REMOVED != 0 {
            return;
        }
        let (bytes, files, parent) = {
            let d = &self.dirs[id as usize];
            (d.total_size, d.total_files, d.parent)
        };
        let mut stack = vec![id];
        while let Some(d) = stack.pop() {
            self.dirs[d as usize].flags |= flags::REMOVED;
            for f in self.files_of(d) {
                self.files[f].flags |= flags::REMOVED;
            }
            stack.extend(self.children(d).map(|c| c as u32));
        }
        self.subtract_up(parent, bytes, files);
        let d = &mut self.dirs[id as usize];
        d.total_size = 0;
        d.total_files = 0;
        d.own_size = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_dates_are_not_plausible() {
        let now = 1_792_000_000;
        assert!(!plausible_time(315_532_800, now)); // 1980-01-01 (ZIP epoch)
        assert!(!plausible_time(0, now));
        assert!(!plausible_time(now + 10 * 86_400, now)); // future
        assert!(plausible_time(now - 400 * 86_400, now));
    }

    #[test]
    fn extensions() {
        assert_eq!(ext_of("a.PDF"), "pdf");
        assert_eq!(ext_of(".gitignore"), "");
        assert_eq!(ext_of("archive.tar.gz"), "gz");
        assert_eq!(ext_of("noext"), "");
        assert_eq!(Category::from_name("Setup.MSI"), Category::Installers);
        assert_eq!(Category::from_name("clip.mkv"), Category::Video);
    }
}
