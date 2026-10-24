//! Thin wrappers around the few Win32 calls CLARITY needs. Declared by hand
//! to keep the dependency surface small; everything degrades to a neutral
//! answer on other platforms so the core logic stays testable.

use serde::Serialize;
use std::fs::Metadata;
use std::io;
use std::path::Path;

pub const ATTR_READONLY: u32 = 0x1;
pub const ATTR_HIDDEN: u32 = 0x2;
pub const ATTR_SYSTEM: u32 = 0x4;
pub const ATTR_REPARSE_POINT: u32 = 0x400;
pub const ATTR_OFFLINE: u32 = 0x1000;
pub const ATTR_RECALL_ON_OPEN: u32 = 0x40000;
pub const ATTR_RECALL_ON_DATA_ACCESS: u32 = 0x400000;

/// Content lives in the cloud; reading it would trigger a download.
pub fn is_cloud_placeholder(attrs: u32) -> bool {
    attrs & (ATTR_OFFLINE | ATTR_RECALL_ON_OPEN | ATTR_RECALL_ON_DATA_ACCESS) != 0
}

#[cfg(windows)]
pub fn attrs_of(md: &Metadata) -> u32 {
    use std::os::windows::fs::MetadataExt;
    md.file_attributes()
}
#[cfg(not(windows))]
pub fn attrs_of(_md: &Metadata) -> u32 {
    0
}

/// (created, modified, accessed) as Unix seconds, 0 when unknown.
#[cfg(windows)]
pub fn times_of(md: &Metadata) -> (i64, i64, i64) {
    use std::os::windows::fs::MetadataExt;
    (
        filetime_to_unix(md.creation_time()),
        filetime_to_unix(md.last_write_time()),
        filetime_to_unix(md.last_access_time()),
    )
}
#[cfg(not(windows))]
pub fn times_of(md: &Metadata) -> (i64, i64, i64) {
    fn secs(t: io::Result<std::time::SystemTime>) -> i64 {
        t.ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }
    (secs(md.created()), secs(md.modified()), secs(md.accessed()))
}

/// FILETIME (100 ns ticks since 1601) to Unix seconds.
pub fn filetime_to_unix(ft: u64) -> i64 {
    if ft == 0 {
        return 0;
    }
    (ft / 10_000_000) as i64 - 11_644_473_600
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DriveKind {
    Fixed,
    Removable,
    Network,
    Optical,
    Ram,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveInfo {
    pub mount: String,
    pub label: String,
    pub file_system: String,
    pub kind: DriveKind,
    pub total: u64,
    pub free: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastAccessInfo {
    /// `Some(true)` if NTFS updates last-access times at all.
    pub enabled: Option<bool>,
    pub system_managed: bool,
    pub explanation: String,
}

#[cfg(windows)]
mod ffi {
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Default)]
    pub struct FileTime {
        pub low: u32,
        pub high: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    pub struct ByHandleFileInformation {
        pub attributes: u32,
        pub creation: FileTime,
        pub last_access: FileTime,
        pub last_write: FileTime,
        pub volume_serial: u32,
        pub size_high: u32,
        pub size_low: u32,
        pub links: u32,
        pub index_high: u32,
        pub index_low: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetLogicalDrives() -> u32;
        pub fn GetDriveTypeW(root: *const u16) -> u32;
        pub fn GetDiskFreeSpaceExW(
            dir: *const u16,
            free_to_caller: *mut u64,
            total: *mut u64,
            total_free: *mut u64,
        ) -> i32;
        pub fn GetVolumeInformationW(
            root: *const u16,
            name: *mut u16,
            name_len: u32,
            serial: *mut u32,
            max_component: *mut u32,
            fs_flags: *mut u32,
            fs_name: *mut u16,
            fs_name_len: u32,
        ) -> i32;
        pub fn GetFileInformationByHandle(h: *mut c_void, info: *mut ByHandleFileInformation) -> i32;
        pub fn GetCompressedFileSizeW(name: *const u16, high: *mut u32) -> u32;
        pub fn SetErrorMode(mode: u32) -> u32;
    }

    #[link(name = "advapi32")]
    extern "system" {
        pub fn RegGetValueW(
            hkey: isize,
            subkey: *const u16,
            value: *const u16,
            flags: u32,
            ty: *mut u32,
            data: *mut c_void,
            len: *mut u32,
        ) -> i32;
    }
}

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn wide_path(p: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    p.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

/// Suppress "There is no disk in the drive" system dialogs for the process.
pub fn quiet_error_mode() {
    #[cfg(windows)]
    unsafe {
        // SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX
        ffi::SetErrorMode(0x0001 | 0x8000);
    }
}

#[cfg(windows)]
pub fn drive_kind(path: &Path) -> DriveKind {
    let s = path.to_string_lossy();
    let root = if s.starts_with(r"\\") {
        return DriveKind::Network;
    } else if s.len() >= 2 && s.as_bytes()[1] == b':' {
        format!("{}\\", &s[..2])
    } else {
        return DriveKind::Unknown;
    };
    let w = wide(&root);
    match unsafe { ffi::GetDriveTypeW(w.as_ptr()) } {
        2 => DriveKind::Removable,
        3 => DriveKind::Fixed,
        4 => DriveKind::Network,
        5 => DriveKind::Optical,
        6 => DriveKind::Ram,
        _ => DriveKind::Unknown,
    }
}
#[cfg(not(windows))]
pub fn drive_kind(_path: &Path) -> DriveKind {
    DriveKind::Fixed
}

/// (total, free) bytes of the volume holding `path`.
#[cfg(windows)]
pub fn disk_space(path: &Path) -> Option<(u64, u64)> {
    let w = wide_path(path);
    let (mut avail, mut total, mut free) = (0u64, 0u64, 0u64);
    let ok = unsafe { ffi::GetDiskFreeSpaceExW(w.as_ptr(), &mut avail, &mut total, &mut free) };
    (ok != 0).then_some((total, avail))
}
#[cfg(not(windows))]
pub fn disk_space(_path: &Path) -> Option<(u64, u64)> {
    None
}

#[cfg(windows)]
pub fn list_drives() -> Vec<DriveInfo> {
    let mask = unsafe { ffi::GetLogicalDrives() };
    let mut out = Vec::new();
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let mount = format!("{}:\\", (b'A' + i as u8) as char);
        let kind = drive_kind(Path::new(&mount));
        if kind == DriveKind::Unknown {
            continue;
        }
        let Some((total, free)) = disk_space(Path::new(&mount)) else {
            continue; // empty card reader, disconnected share, ...
        };
        let w = wide(&mount);
        let mut name = [0u16; 261];
        let mut fs = [0u16; 261];
        let (mut serial, mut maxc, mut fl) = (0u32, 0u32, 0u32);
        let ok = unsafe {
            ffi::GetVolumeInformationW(
                w.as_ptr(),
                name.as_mut_ptr(),
                name.len() as u32,
                &mut serial,
                &mut maxc,
                &mut fl,
                fs.as_mut_ptr(),
                fs.len() as u32,
            )
        };
        let decode = |b: &[u16]| {
            let end = b.iter().position(|&c| c == 0).unwrap_or(b.len());
            String::from_utf16_lossy(&b[..end])
        };
        out.push(DriveInfo {
            label: if ok != 0 { decode(&name) } else { String::new() },
            file_system: if ok != 0 { decode(&fs) } else { String::new() },
            mount,
            kind,
            total,
            free,
        });
    }
    out
}
#[cfg(not(windows))]
pub fn list_drives() -> Vec<DriveInfo> {
    Vec::new()
}

/// Physical identity of a file: (volume serial, file index, hard-link count).
#[cfg(windows)]
pub fn file_identity(path: &Path) -> io::Result<(u64, u64, u32)> {
    use std::os::windows::io::AsRawHandle;
    let f = std::fs::File::open(path)?;
    let mut info = ffi::ByHandleFileInformation::default();
    let ok = unsafe { ffi::GetFileInformationByHandle(f.as_raw_handle() as _, &mut info) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let index = ((info.index_high as u64) << 32) | info.index_low as u64;
    Ok((info.volume_serial as u64, index, info.links))
}
#[cfg(not(windows))]
pub fn file_identity(path: &Path) -> io::Result<(u64, u64, u32)> {
    use std::os::unix::fs::MetadataExt;
    let md = std::fs::metadata(path)?;
    Ok((md.dev(), md.ino(), md.nlink() as u32))
}

/// Bytes the file actually occupies (NTFS compression, sparse files).
#[cfg(windows)]
pub fn on_disk_size(path: &Path) -> Option<u64> {
    let w = wide_path(path);
    let mut high = 0u32;
    let low = unsafe { ffi::GetCompressedFileSizeW(w.as_ptr(), &mut high) };
    if low == u32::MAX && io::Error::last_os_error().raw_os_error() != Some(0) {
        return None;
    }
    Some(((high as u64) << 32) | low as u64)
}
#[cfg(not(windows))]
pub fn on_disk_size(path: &Path) -> Option<u64> {
    std::fs::metadata(path).ok().map(|m| m.len())
}

/// How trustworthy "last accessed" timestamps are on this machine.
pub fn last_access_info() -> LastAccessInfo {
    #[cfg(windows)]
    {
        let sub = wide(r"SYSTEM\CurrentControlSet\Control\FileSystem");
        let val = wide("NtfsDisableLastAccessUpdate");
        let mut data = 0u32;
        let mut len = 4u32;
        const HKLM: isize = 0x8000_0002u32 as i32 as isize;
        const RRF_RT_REG_DWORD: u32 = 0x10;
        let rc = unsafe {
            ffi::RegGetValueW(
                HKLM,
                sub.as_ptr(),
                val.as_ptr(),
                RRF_RT_REG_DWORD,
                std::ptr::null_mut(),
                &mut data as *mut u32 as *mut _,
                &mut len,
            )
        };
        if rc == 0 {
            let system_managed = data & 0x8000_0000 != 0;
            let disabled = data & 1 == 1;
            let explanation = if disabled {
                "Windows does not record when files are opened on this PC, so CLARITY cannot tell when a file was last used. Only modification dates are reliable."
            } else {
                "Windows records last-access times here, but only approximately (to the hour) and other programs such as antivirus scanners and indexers also update them. Treat them as hints, never as proof that a file is unused."
            };
            return LastAccessInfo {
                enabled: Some(!disabled),
                system_managed,
                explanation: explanation.into(),
            };
        }
    }
    LastAccessInfo {
        enabled: None,
        system_managed: false,
        explanation: "CLARITY could not determine whether this PC records last-access times. Only modification dates are reliable.".into(),
    }
}

/// Rename/move that never replaces an existing file (std::fs::rename does
/// on Windows). Fails with an error if `to` exists.
#[cfg(windows)]
pub fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVE_FILE_FLAGS};
    unsafe { MoveFileExW(&HSTRING::from(from.as_os_str()), &HSTRING::from(to.as_os_str()), MOVE_FILE_FLAGS(0)) }.map_err(|e| io::Error::from_raw_os_error((e.code().0 & 0xFFFF) as i32))
}
#[cfg(not(windows))]
pub fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    if std::fs::symlink_metadata(to).is_ok() {
        return Err(io::Error::new(io::ErrorKind::AlreadyExists, "destination exists"));
    }
    std::fs::rename(from, to)
}
