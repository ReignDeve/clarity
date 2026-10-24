//! Thumbnails and media metadata from the Windows shell.
//!
//! Windows already knows how to thumbnail and describe every image, video
//! and audio format it has a codec for (the same data Explorer shows), and
//! keeps its own thumbnail cache. Using it means no bundled codecs, local
//! processing only, and HEIC/RAW support wherever the user installed it.
//!
//! COM objects are created on dedicated worker threads that initialise COM
//! once; callers use the blocking helpers from any thread.

use serde::{Deserialize, Serialize};
#[cfg(not(windows))]
use std::path::Path;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaMeta {
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// Milliseconds.
    pub duration_ms: Option<u64>,
    pub frame_rate: Option<f32>,
    pub bitrate: Option<u32>,
    /// Unix seconds (photo EXIF "date taken").
    pub taken: Option<i64>,
    pub camera: Option<String>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
}

impl MediaMeta {
    pub fn pixels(&self) -> u64 {
        self.width.unwrap_or(0) as u64 * self.height.unwrap_or(0) as u64
    }
}

#[cfg(windows)]
mod imp {
    use super::MediaMeta;
    use std::path::Path;
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::Foundation::{PROPERTYKEY, SIZE};
    use windows::Win32::Graphics::Gdi::{CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, HGDIOBJ};
    use windows::Win32::Storage::EnhancedStorage::*;
    use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{IShellItem2, IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF, SIIGBF_BIGGERSIZEOK, SIIGBF_INCACHEONLY, SIIGBF_THUMBNAILONLY};

    thread_local! {
        static COM: () = unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        };
    }

    fn com() {
        COM.with(|_| {});
    }

    /// JPEG thumbnail no larger than `size` on its longer side.
    pub fn thumbnail(path: &Path, size: u32, cache_only: bool) -> Result<Vec<u8>, String> {
        com();
        unsafe {
            let factory: IShellItemImageFactory = SHCreateItemFromParsingName(&HSTRING::from(path.as_os_str()), None).map_err(|e| e.to_string())?;
            let mut flags: SIIGBF = SIIGBF_THUMBNAILONLY | SIIGBF_BIGGERSIZEOK;
            if cache_only {
                // Cloud placeholders: never trigger a download.
                flags |= SIIGBF_INCACHEONLY;
            }
            let hbmp = factory.GetImage(SIZE { cx: size as i32, cy: size as i32 }, flags).map_err(|e| e.to_string())?;
            let obj = HGDIOBJ::from(hbmp);
            let result = (|| {
                let mut bm = BITMAP::default();
                if GetObjectW(obj, std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut _)) == 0 {
                    return Err("GetObject failed".to_string());
                }
                let (w, h) = (bm.bmWidth, bm.bmHeight.abs());
                if w <= 0 || h <= 0 || w > 4096 || h > 4096 {
                    return Err("unexpected bitmap size".into());
                }
                let mut info = BITMAPINFO::default();
                info.bmiHeader = BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    biHeight: -h, // top-down
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: 0, // BI_RGB
                    ..Default::default()
                };
                let mut buf = vec![0u8; (w * h * 4) as usize];
                let dc = CreateCompatibleDC(None);
                let lines = GetDIBits(dc, hbmp, 0, h as u32, Some(buf.as_mut_ptr() as *mut _), &mut info, DIB_RGB_COLORS);
                let _ = DeleteDC(dc);
                if lines == 0 {
                    return Err("GetDIBits failed".into());
                }
                // Shell bitmaps carry (premultiplied) alpha; composite over a
                // neutral dark tone so transparent areas don't turn black.
                for px in buf.chunks_exact_mut(4) {
                    let a = px[3] as u32;
                    if a < 255 {
                        let bg = 28u32 * (255 - a) / 255;
                        px[0] = (px[0] as u32 + bg).min(255) as u8;
                        px[1] = (px[1] as u32 + bg).min(255) as u8;
                        px[2] = (px[2] as u32 + bg).min(255) as u8;
                    }
                }
                // Downscale (box filter) if the shell returned something big.
                let (buf, w, h) = shrink(buf, w as usize, h as usize, size as usize);
                let mut out = Vec::with_capacity(w * h / 4);
                jpeg_encoder::Encoder::new(&mut out, 82).encode(&buf, w as u16, h as u16, jpeg_encoder::ColorType::Bgra).map_err(|e| e.to_string())?;
                Ok(out)
            })();
            let _ = DeleteObject(obj);
            result
        }
    }

    fn shrink(buf: Vec<u8>, w: usize, h: usize, max: usize) -> (Vec<u8>, usize, usize) {
        let f = ((w.max(h) + max - 1) / max).max(1);
        if f == 1 {
            return (buf, w, h);
        }
        let (nw, nh) = (w / f, h / f);
        let mut out = vec![0u8; nw * nh * 4];
        for y in 0..nh {
            for x in 0..nw {
                let mut acc = [0u32; 4];
                for dy in 0..f {
                    for dx in 0..f {
                        let i = ((y * f + dy) * w + (x * f + dx)) * 4;
                        for c in 0..4 {
                            acc[c] += buf[i + c] as u32;
                        }
                    }
                }
                let o = (y * nw + x) * 4;
                for c in 0..4 {
                    out[o + c] = (acc[c] / (f * f) as u32) as u8;
                }
            }
        }
        (out, nw, nh)
    }

    unsafe fn string(item: &IShellItem2, key: &PROPERTYKEY) -> Option<String> {
        let p: PWSTR = item.GetString(key).ok()?;
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as *const _));
        s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    }

    pub fn metadata(path: &Path) -> Result<MediaMeta, String> {
        com();
        unsafe {
            let item: IShellItem2 = SHCreateItemFromParsingName(&HSTRING::from(path.as_os_str()), None).map_err(|e| e.to_string())?;
            let u32p = |k: &PROPERTYKEY| item.GetUInt32(k).ok().filter(|&v| v > 0);
            let width = u32p(&PKEY_Image_HorizontalSize).or_else(|| u32p(&PKEY_Video_FrameWidth));
            let height = u32p(&PKEY_Image_VerticalSize).or_else(|| u32p(&PKEY_Video_FrameHeight));
            // 100-ns units.
            let duration_ms = item.GetUInt64(&PKEY_Media_Duration).ok().filter(|&d| d > 0).map(|d| d / 10_000);
            let frame_rate = u32p(&PKEY_Video_FrameRate).map(|f| f as f32 / 1000.0);
            let bitrate = u32p(&PKEY_Audio_EncodingBitrate);
            let taken = item.GetFileTime(&PKEY_Photo_DateTaken).ok().map(|ft| crate::platform::filetime_to_unix(((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64)).filter(|&t| t > 0);
            Ok(MediaMeta {
                width,
                height,
                duration_ms,
                frame_rate,
                bitrate,
                taken,
                camera: string(&item, &PKEY_Photo_CameraModel),
                title: string(&item, &PKEY_Title),
                artist: string(&item, &PKEY_Music_Artist),
                album: string(&item, &PKEY_Music_AlbumTitle),
            })
        }
    }
}

#[cfg(windows)]
pub use imp::{metadata, thumbnail};

#[cfg(not(windows))]
pub fn thumbnail(_path: &Path, _size: u32, _cache_only: bool) -> Result<Vec<u8>, String> {
    Err("thumbnails are only available on Windows".into())
}
#[cfg(not(windows))]
pub fn metadata(_path: &Path) -> Result<MediaMeta, String> {
    Ok(MediaMeta::default())
}


#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// A 40×30 24-bit BMP, written by hand.
    fn bmp(w: u32, h: u32) -> Vec<u8> {
        let row = ((w * 3 + 3) / 4) * 4;
        let data = row * h;
        let mut v = Vec::new();
        v.extend(b"BM");
        v.extend((54 + data).to_le_bytes());
        v.extend([0u8; 4]);
        v.extend(54u32.to_le_bytes());
        v.extend(40u32.to_le_bytes());
        v.extend((w as i32).to_le_bytes());
        v.extend((h as i32).to_le_bytes());
        v.extend(1u16.to_le_bytes());
        v.extend(24u16.to_le_bytes());
        v.extend([0u8; 24]);
        for y in 0..h {
            for x in 0..w {
                v.extend([(x * 6) as u8, (y * 8) as u8, 180u8]);
            }
            v.extend(vec![0u8; (row - w * 3) as usize]);
        }
        v
    }

    #[test]
    fn shell_thumbnail_and_metadata() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("pic.bmp");
        std::fs::write(&p, bmp(40, 30)).unwrap();
        let m = metadata(&p).unwrap();
        assert_eq!((m.width, m.height), (Some(40), Some(30)));
        let jpg = thumbnail(&p, 64, false).unwrap();
        assert_eq!(&jpg[..2], &[0xFF, 0xD8]); // JPEG SOI marker
    }
}
