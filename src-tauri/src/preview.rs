//! Read-only inspection of file contents. Nothing is executed or extracted.

use serde::Serialize;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

pub const TEXT_LIMIT: usize = 512 * 1024;
const ARCHIVE_ENTRY_LIMIT: usize = 5_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPreview {
    pub text: String,
    pub truncated: bool,
    pub binary: bool,
    pub encoding: &'static str,
    pub total_bytes: u64,
}

pub fn read_text(path: &Path) -> std::io::Result<TextPreview> {
    let f = File::open(path)?;
    let total = f.metadata()?.len();
    let mut buf = Vec::with_capacity(TEXT_LIMIT.min(total as usize));
    f.take(TEXT_LIMIT as u64).read_to_end(&mut buf)?;
    let truncated = (buf.len() as u64) < total;

    if buf.starts_with(&[0xFF, 0xFE]) || buf.starts_with(&[0xFE, 0xFF]) {
        let le = buf[0] == 0xFF;
        let units: Vec<u16> = buf[2..]
            .chunks_exact(2)
            .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
            .collect();
        return Ok(TextPreview { text: String::from_utf16_lossy(&units), truncated, binary: false, encoding: if le { "UTF-16 LE" } else { "UTF-16 BE" }, total_bytes: total });
    }
    let sniff = &buf[..buf.len().min(8192)];
    let control = sniff.iter().filter(|&&b| b == 0 || (b < 9) || (b > 13 && b < 32 && b != 27)).count();
    if sniff.contains(&0) || (sniff.len() > 64 && control * 10 > sniff.len()) {
        return Ok(TextPreview { text: String::new(), truncated, binary: true, encoding: "binary", total_bytes: total });
    }
    let body = buf.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&buf);
    let (text, encoding) = match std::str::from_utf8(body) {
        Ok(s) => (s.to_string(), "UTF-8"),
        Err(e) if truncated && e.valid_up_to() + 4 >= body.len() => (String::from_utf8_lossy(&body[..e.valid_up_to()]).into_owned(), "UTF-8"),
        // Most likely a legacy single-byte code page (Windows-1252).
        Err(_) => (body.iter().map(|&b| b as char).collect(), "Windows-1252 (assumed)"),
    };
    Ok(TextPreview { text, truncated, binary: false, encoding, total_bytes: total })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub compressed: Option<u64>,
    pub encrypted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveListing {
    pub format: &'static str,
    pub entries: Vec<ArchiveEntry>,
    pub total_entries: usize,
    pub truncated: bool,
    pub uncompressed_total: u64,
    pub compressed_total: Option<u64>,
    pub supported: bool,
    pub note: Option<String>,
}

pub fn list_archive(path: &Path) -> Result<ArchiveListing, String> {
    let name = path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    if name.ends_with(".zip") || name.ends_with(".jar") || name.ends_with(".docx") || name.ends_with(".xlsx") || name.ends_with(".pptx") || name.ends_with(".epub") {
        list_zip(path)
    } else if name.ends_with(".tar") {
        list_tar(File::open(path).map_err(|e| e.to_string())?, "TAR")
    } else if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        let f = File::open(path).map_err(|e| e.to_string())?;
        list_tar(flate2::read::GzDecoder::new(BufReader::new(f)), "TAR.GZ")
    } else {
        Ok(ArchiveListing {
            format: "unsupported",
            entries: vec![],
            total_entries: 0,
            truncated: false,
            uncompressed_total: 0,
            compressed_total: None,
            supported: false,
            note: Some("CLARITY can list ZIP and TAR archives. Other formats can be opened with their default application.".into()),
        })
    }
}

fn list_zip(path: &Path) -> Result<ArchiveListing, String> {
    let f = File::open(path).map_err(|e| e.to_string())?;
    let mut z = zip::ZipArchive::new(BufReader::new(f)).map_err(|e| format!("Not a readable ZIP archive: {e}"))?;
    let total = z.len();
    let mut entries = Vec::new();
    let (mut unc, mut comp) = (0u64, 0u64);
    for i in 0..total {
        // Raw access reads only the central directory; nothing is decompressed.
        let e = match z.by_index_raw(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        unc += e.size();
        comp += e.compressed_size();
        if entries.len() < ARCHIVE_ENTRY_LIMIT {
            entries.push(ArchiveEntry { name: e.name().to_string(), is_dir: e.is_dir(), size: e.size(), compressed: Some(e.compressed_size()), encrypted: e.encrypted() });
        }
    }
    Ok(ArchiveListing { format: "ZIP", truncated: total > entries.len(), entries, total_entries: total, uncompressed_total: unc, compressed_total: Some(comp), supported: true, note: None })
}

fn list_tar<R: Read>(r: R, format: &'static str) -> Result<ArchiveListing, String> {
    let mut a = tar::Archive::new(r);
    let mut entries = Vec::new();
    let mut total = 0usize;
    let mut unc = 0u64;
    let mut note = None;
    for e in a.entries().map_err(|e| e.to_string())? {
        let e = match e {
            Ok(e) => e,
            Err(err) => {
                note = Some(format!("Listing stopped early: {err}"));
                break;
            }
        };
        total += 1;
        let size = e.header().size().unwrap_or(0);
        unc += size;
        if entries.len() < ARCHIVE_ENTRY_LIMIT {
            entries.push(ArchiveEntry {
                name: e.path().map(|p| p.display().to_string()).unwrap_or_else(|_| "?".into()),
                is_dir: e.header().entry_type().is_dir(),
                size,
                compressed: None,
                encrypted: false,
            });
        } else if total > 200_000 {
            note = Some("Very large archive; listing stopped after 200,000 entries.".into());
            break;
        }
    }
    Ok(ArchiveListing { format, truncated: total > entries.len(), entries, total_entries: total, uncompressed_total: unc, compressed_total: None, supported: true, note })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn text_and_binary() {
        let t = tempfile::tempdir().unwrap();
        std::fs::write(t.path().join("a.txt"), "hällo\nworld").unwrap();
        std::fs::write(t.path().join("b.bin"), [0u8, 1, 2, 3, 0, 0, 9]).unwrap();
        let a = read_text(&t.path().join("a.txt")).unwrap();
        assert_eq!(a.text, "hällo\nworld");
        assert!(!a.binary);
        assert!(read_text(&t.path().join("b.bin")).unwrap().binary);
    }

    #[test]
    fn lists_zip_without_extracting() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("x.zip");
        let mut w = zip::ZipWriter::new(File::create(&p).unwrap());
        let opts = zip::write::SimpleFileOptions::default();
        w.start_file("docs/readme.txt", opts).unwrap();
        w.write_all(&[b'a'; 1000]).unwrap();
        w.finish().unwrap();
        let l = list_archive(&p).unwrap();
        assert_eq!(l.total_entries, 1);
        assert_eq!(l.uncompressed_total, 1000);
        assert!(l.compressed_total.unwrap() < 1000);
    }
}
