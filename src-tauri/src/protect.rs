//! Locations CLARITY will never remove, regardless of what the user selects.

use crate::paths::{is_same_or_under, normalize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct Protector {
    /// Nothing at or below these paths may be removed.
    subtrees: Vec<String>,
    /// These exact folders may not be removed (their contents may).
    anchors: Vec<String>,
}

/// File names that are critical wherever they appear at a drive root.
const ROOT_SYSTEM_FILES: &[&str] = &["pagefile.sys", "hiberfil.sys", "swapfile.sys", "bootmgr", "bootnxt", "dumpstack.log", "dumpstack.log.tmp"];

/// Folder names that are protected wherever they appear (any depth).
const PROTECTED_NAMES: &[&str] = &["$recycle.bin", "system volume information", "windowsapps", "$windows.~bt", "$windows.~ws", "$winreagent"];

impl Protector {
    pub fn new(subtrees: Vec<PathBuf>, anchors: Vec<PathBuf>) -> Self {
        Self {
            subtrees: subtrees.iter().map(|p| normalize(p)).collect(),
            anchors: anchors.iter().map(|p| normalize(p)).collect(),
        }
    }

    /// Protection list for the current Windows installation and user.
    pub fn from_system() -> Self {
        let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
        let mut subtrees: Vec<PathBuf> = Vec::new();
        for key in ["SystemRoot", "windir", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData", "APPDATA", "LOCALAPPDATA"] {
            if let Some(p) = env(key) {
                subtrees.push(p);
            }
        }
        let sys_drive = env("SystemDrive").unwrap_or_else(|| PathBuf::from("C:"));
        let sd = format!("{}\\", sys_drive.display());
        for name in ["Windows", "Program Files", "Program Files (x86)", "ProgramData", "Recovery", "Boot", "EFI", "PerfLogs", "Windows.old", "Users\\Default", "Users\\Public\\Desktop"] {
            subtrees.push(PathBuf::from(&sd).join(name));
        }
        let mut anchors: Vec<PathBuf> = vec![PathBuf::from(&sd).join("Users"), PathBuf::from(&sd).join("Users\\Public")];
        if let Some(home) = dirs::home_dir() {
            // Everything in AppData belongs to installed applications.
            subtrees.push(home.join("AppData"));
            anchors.push(home.clone());
        }
        for d in [dirs::desktop_dir(), dirs::document_dir(), dirs::download_dir(), dirs::picture_dir(), dirs::audio_dir(), dirs::video_dir()].into_iter().flatten() {
            anchors.push(d);
        }
        if let Some(od) = env("OneDrive") {
            anchors.push(od);
        }
        Self::new(subtrees, anchors)
    }

    /// `Some(reason)` if nothing may be placed into or below `path`
    /// (system and application locations). Known folders such as Downloads
    /// are fine as destinations.
    pub fn check_destination(&self, path: &Path) -> Option<String> {
        let n = normalize(path);
        for s in &self.subtrees {
            if is_same_or_under(&n, s) {
                return Some(format!("Files cannot be moved into a protected system or application location ({s})."));
            }
        }
        if n.split('\\').any(|c| PROTECTED_NAMES.contains(&c)) {
            return Some("Files cannot be moved into a protected Windows folder.".into());
        }
        None
    }

    /// `Some(reason)` if `path` must not be removed.
    pub fn check(&self, path: &Path, is_dir: bool) -> Option<String> {
        let n = normalize(path);
        if n.len() <= 3 {
            return Some("Drive roots can never be removed.".into());
        }
        if n.starts_with(r"\\") && n.matches('\\').count() <= 3 {
            return Some("Network share roots can never be removed.".into());
        }
        for s in &self.subtrees {
            if is_same_or_under(&n, s) {
                return Some(format!("Inside a protected system or application location ({s})."));
            }
        }
        if self.anchors.iter().any(|a| *a == n) {
            return Some("This is a system-managed folder. Its contents can be reviewed, but the folder itself stays.".into());
        }
        let components: Vec<&str> = n.split('\\').collect();
        if components.iter().any(|c| PROTECTED_NAMES.contains(c)) {
            return Some("Inside a protected Windows folder.".into());
        }
        if !is_dir && components.len() == 2 {
            if let Some(name) = components.last() {
                if ROOT_SYSTEM_FILES.contains(name) {
                    return Some("This is a Windows system file.".into());
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p() -> Protector {
        Protector::new(
            vec![PathBuf::from(r"C:\Windows"), PathBuf::from(r"C:\Program Files"), PathBuf::from(r"C:\Users\me\AppData")],
            vec![PathBuf::from(r"C:\Users\me"), PathBuf::from(r"C:\Users\me\Downloads")],
        )
    }

    #[test]
    fn blocks_system_locations() {
        let p = p();
        assert!(p.check(Path::new(r"C:\"), true).is_some());
        assert!(p.check(Path::new(r"D:\"), true).is_some());
        assert!(p.check(Path::new(r"c:\windows\system32\x.dll"), false).is_some());
        assert!(p.check(Path::new(r"C:\WINDOWS"), true).is_some());
        assert!(p.check(Path::new(r"C:\Program Files\App"), true).is_some());
        assert!(p.check(Path::new(r"C:\Users\me\AppData\Local\x.tmp"), false).is_some());
        assert!(p.check(Path::new(r"D:\$Recycle.Bin\S-1\x"), false).is_some());
        assert!(p.check(Path::new(r"C:\pagefile.sys"), false).is_some());
        assert!(p.check(Path::new(r"\\server\share"), true).is_some());
    }

    #[test]
    fn anchors_protect_only_themselves() {
        let p = p();
        assert!(p.check(Path::new(r"C:\Users\me\Downloads"), true).is_some());
        assert!(p.check(Path::new(r"C:\Users\me\Downloads\"), true).is_some());
        assert!(p.check(Path::new(r"C:\Users\me\Downloads\setup.msi"), false).is_none());
        assert!(p.check(Path::new(r"C:\Users\me"), true).is_some());
    }

    #[test]
    fn allows_user_content() {
        let p = p();
        assert!(p.check(Path::new(r"C:\Users\me\Videos\clip.mp4"), false).is_none());
        assert!(p.check(Path::new(r"C:\Windowsish\file.txt"), false).is_none());
        assert!(p.check(Path::new(r"D:\Backups\old.zip"), false).is_none());
        assert!(p.check(Path::new(r"D:\sub\pagefile.sys"), false).is_none());
    }
}
