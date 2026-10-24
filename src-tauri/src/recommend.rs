//! Transparent, rule-based review suggestions.
//!
//! Every rule only uses facts CLARITY can verify (size, type, location,
//! modification date, verified duplicate content). Last-access times are
//! deliberately not used: Windows often does not record them reliably.
//! Suggestions say "review", never "safe to delete".

use crate::duplicates::DupResult;
use crate::model::{ext_of, flags, plausible_time, Category, ScanIndex, NONE};
use serde::Serialize;

pub const DAY: i64 = 86_400;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RecKind {
    LargeOld,
    OldInstaller,
    OldDownload,
    ArchiveReview,
    LargeVideo,
    Duplicate,
    BuildArtifacts,
    StaleProject,
    TempFolder,
}

impl RecKind {
    pub fn bit(self) -> u16 {
        1 << (self as u16)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub kind: &'static str, // "file" | "dir" | "dupGroup"
    pub id: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recommendation {
    pub kind: RecKind,
    pub target: Target,
    pub name: String,
    pub path: String,
    pub size: u64,
    pub category: &'static str,
    pub title: String,
    pub reason: String,
    pub risk: Risk,
    pub risk_note: String,
    pub action: String,
    pub modified: i64,
}

#[derive(Debug, Clone)]
pub struct RecParams {
    pub now: i64,
    pub old_days: i64,
    pub large_bytes: u64,
    pub downloads_dir: Option<u32>,
}

pub fn human_size(b: u64) -> String {
    const U: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = b as f64;
    let mut i = 0;
    // Binary units, labelled the way Windows Explorer labels them.
    while v >= 1024.0 && i < U.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{b} B")
    } else if v >= 100.0 {
        format!("{v:.0} {}", U[i])
    } else {
        format!("{v:.1} {}", U[i])
    }
}

/// "18 months", "2 years", "45 days".
pub fn age_phrase(secs: i64) -> String {
    let days = secs / DAY;
    if days < 60 {
        format!("{days} days")
    } else if days < 730 {
        format!("{} months", days / 30)
    } else {
        let y = days as f64 / 365.25;
        if (y - y.round()).abs() < 0.15 {
            format!("{} years", y.round() as i64)
        } else {
            format!("{:.1} years", y)
        }
    }
}

const PROJECT_MARKERS: &[&str] = &["package.json", "cargo.toml", "pyproject.toml", "go.mod", "pom.xml", "build.gradle", "composer.json", "gemfile"];
const INSTALLER_EXTS: &[&str] = &["msi", "msix", "msixbundle", "appx", "appxbundle", "iso", "img"];

fn dir_has_file(index: &ScanIndex, dir: u32, pred: impl Fn(&str) -> bool) -> bool {
    index.files_of(dir).any(|f| pred(&index.files[f].name.to_lowercase()))
}

fn dir_has_child(index: &ScanIndex, dir: u32, name: &str) -> bool {
    index.children(dir).any(|c| index.dirs[c].name.eq_ignore_ascii_case(name))
}

/// Compute suggestions plus a per-file bit mask of matching rules.
pub fn compute(index: &ScanIndex, p: &RecParams, dups: Option<&DupResult>) -> (Vec<Recommendation>, Vec<u16>) {
    let mut out = Vec::new();
    let mut masks = vec![0u16; index.files.len()];
    let in_downloads = p.downloads_dir.map(|d| index.subtree_mask(d));
    let old_cut = p.now - p.old_days * DAY;

    for (i, f) in index.files.iter().enumerate() {
        if f.flags & (flags::REMOVED | flags::CLOUD | flags::SYSTEM) != 0 || f.size == 0 {
            continue;
        }
        // Placeholder or future dates say nothing about age.
        let dated = plausible_time(f.modified, p.now);
        let age = if dated { p.now - f.modified } else { 0 };
        let ext = ext_of(&f.name);
        let in_dl = in_downloads.as_ref().is_some_and(|m| m[f.dir as usize]);
        let size_s = human_size(f.size);

        let mut rec: Option<(RecKind, String, String, Risk, String, String)> = None;
        let add = |kind: RecKind, masks: &mut Vec<u16>| masks[i] |= kind.bit();

        if (INSTALLER_EXTS.contains(&ext.as_str()) || (in_dl && ext == "exe")) && age > 90 * DAY && f.size >= 5_000_000 {
            add(RecKind::OldInstaller, &mut masks);
            rec.get_or_insert((
                RecKind::OldInstaller,
                format!("Old installer: {}", f.name),
                format!("This {size_s} installer package has not been modified in {}. Installers are usually only needed once; most can be downloaded again from the vendor.", age_phrase(age)),
                Risk::Low,
                "Keep it if the software is no longer available for download or you need this exact version.".into(),
                "Review, then move to Recycle Bin".into(),
            ));
        }
        if f.cat == Category::Archives && f.size >= 100_000_000 && dated && f.modified < old_cut {
            add(RecKind::ArchiveReview, &mut masks);
            rec.get_or_insert((
                RecKind::ArchiveReview,
                format!("Large archive: {}", f.name),
                format!("This {size_s} archive has not been modified in {}. Review whether you still need it, or whether its contents exist elsewhere.", age_phrase(age)),
                Risk::Medium,
                "Archives are often the only copy of a backup or a finished project. Check its contents in the preview first.".into(),
                "Inspect contents, then decide".into(),
            ));
        }
        if f.size >= p.large_bytes && dated && f.modified < old_cut {
            add(RecKind::LargeOld, &mut masks);
            rec.get_or_insert((
                RecKind::LargeOld,
                format!("Large, unchanged file: {}", f.name),
                format!("This {size_s} file has not been modified in {}. That does not mean it is unused, but it is a good candidate to review.", age_phrase(age)),
                Risk::Medium,
                "An old modification date only means the content has not changed. The file may still be read regularly.".into(),
                "Review".into(),
            ));
        }
        if in_dl && f.size >= 10_000_000 && dated && age > 180 * DAY {
            add(RecKind::OldDownload, &mut masks);
            rec.get_or_insert((
                RecKind::OldDownload,
                format!("Old download: {}", f.name),
                format!("This {size_s} file in your Downloads folder has not been modified in {}. Downloads are often kept by accident after being used once.", age_phrase(age)),
                Risk::Low,
                "Make sure it is not the only copy of something you received (e.g. an invoice or contract).".into(),
                "Review".into(),
            ));
        }
        if f.cat == Category::Video && f.size >= 1_000_000_000 {
            add(RecKind::LargeVideo, &mut masks);
            rec.get_or_insert((
                RecKind::LargeVideo,
                format!("Large video: {}", f.name),
                format!("This video uses {size_s}. Videos are usually the largest personal files. Check whether you have another copy or still need it at full quality."),
                Risk::Medium,
                "Personal recordings may be irreplaceable.".into(),
                "Preview, then decide".into(),
            ));
        }
        if let Some((kind, title, reason, risk, risk_note, action)) = rec {
            out.push(Recommendation {
                kind,
                target: Target { kind: "file", id: i as u32 },
                name: f.name.to_string(),
                path: index.file_path(i as u32).display().to_string(),
                size: f.size,
                category: f.cat.as_str(),
                title,
                reason,
                risk,
                risk_note,
                action,
                modified: f.modified,
            });
        }
    }

    // Folder rules.
    let mut flagged_dirs: Vec<bool> = vec![false; index.dirs.len()];
    for (i, d) in index.dirs.iter().enumerate() {
        let id = i as u32;
        if d.parent == NONE || d.flags & (flags::REMOVED | flags::CLOUD) != 0 {
            continue;
        }
        if flagged_dirs[d.parent as usize] {
            flagged_dirs[i] = true; // only report the outermost folder
            continue;
        }
        let name = d.name.to_lowercase();
        let idle = p.now - d.latest_mtime;
        let size_s = human_size(d.total_size);
        let build_dir = match name.as_str() {
            "node_modules" | "__pycache__" | ".gradle" | ".next" | ".nuxt" | ".parcel-cache" | ".turbo" => true,
            "target" => dir_has_file(index, d.parent, |n| n == "cargo.toml" || n == "pom.xml"),
            "obj" | "bin" => dir_has_file(index, d.parent, |n| n.ends_with(".csproj")),
            _ => false,
        };
        let rec = if build_dir && d.total_size >= 50_000_000 && idle > 90 * DAY {
            Some((
                RecKind::BuildArtifacts,
                format!("Build output: {}", d.name),
                format!("This {size_s} \u{201c}{}\u{201d} folder contains generated files and has not changed in {}. Build tools can recreate it when you work on the project again.", d.name, age_phrase(idle)),
                Risk::Low,
                "Rebuilding or reinstalling dependencies may take time and needs an internet connection.".to_string(),
                "Move to Recycle Bin".to_string(),
            ))
        } else if d.total_size >= 100_000_000
            && d.latest_mtime > 0
            && d.latest_mtime < old_cut
            && (dir_has_child(index, id, ".git") || dir_has_file(index, id, |n| PROJECT_MARKERS.contains(&n) || n.ends_with(".sln")))
        {
            Some((
                RecKind::StaleProject,
                format!("Inactive project: {}", d.name),
                format!("Nothing in this {size_s} project folder has been modified in {}.", age_phrase(idle)),
                Risk::High,
                "Contains source code and possibly unpublished work. Make sure it is backed up or pushed to a remote before removing it.".to_string(),
                "Review, archive or back up".to_string(),
            ))
        } else if matches!(name.as_str(), "temp" | "tmp" | "cache" | ".cache" | "scratch") && d.total_size >= 100_000_000 && idle > 90 * DAY {
            Some((
                RecKind::TempFolder,
                format!("Forgotten work folder: {}", d.name),
                format!("This {size_s} folder is named like a temporary or cache folder and nothing inside has changed in {}.", age_phrase(idle)),
                Risk::Medium,
                "Some programs keep important data in folders called \u{201c}cache\u{201d}. Check the contents first.".to_string(),
                "Inspect, then decide".to_string(),
            ))
        } else {
            None
        };
        if let Some((kind, title, reason, risk, risk_note, action)) = rec {
            flagged_dirs[i] = true;
            out.push(Recommendation {
                kind,
                target: Target { kind: "dir", id },
                name: d.name.to_string(),
                path: index.dir_path(id).display().to_string(),
                size: d.total_size,
                category: "folder",
                title,
                reason,
                risk,
                risk_note,
                action,
                modified: d.latest_mtime,
            });
        }
    }

    if let Some(dups) = dups {
        for g in &dups.groups {
            let live: Vec<u32> = g.files.iter().copied().filter(|&f| index.files[f as usize].flags & flags::REMOVED == 0).collect();
            if live.len() < 2 {
                continue;
            }
            for &f in &live {
                masks[f as usize] |= RecKind::Duplicate.bit();
            }
            let f0 = &index.files[live[0] as usize];
            let extra = g.size * (live.len() as u64 - 1);
            out.push(Recommendation {
                kind: RecKind::Duplicate,
                target: Target { kind: "dupGroup", id: g.id },
                name: f0.name.to_string(),
                path: index.file_path(live[0]).display().to_string(),
                size: extra,
                category: f0.cat.as_str(),
                title: format!("{} identical copies of {}", live.len(), f0.name),
                reason: format!("These {} files have byte-for-byte identical content ({} each). Keeping one copy would free about {}.", live.len(), human_size(g.size), human_size(extra)),
                risk: Risk::Low,
                risk_note: "Some programs expect their own copy in a specific place. Keep the copy in the location you actually use.".into(),
                action: "Choose which copy to keep".into(),
                modified: f0.modified,
            });
        }
    }

    out.sort_by(|a, b| b.size.cmp(&a.size));
    (out, masks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phrases() {
        assert_eq!(age_phrase(45 * DAY), "45 days");
        assert_eq!(age_phrase(548 * DAY), "18 months");
        assert_eq!(age_phrase(730 * DAY), "2 years");
        assert_eq!(human_size(4_509_715_660), "4.2 GB");
        assert_eq!(human_size(512), "512 B");
    }
}
