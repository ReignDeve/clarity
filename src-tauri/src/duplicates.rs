//! Content-based duplicate detection.
//!
//! 1. group candidates by exact size
//! 2. collapse hard links (same volume + file index = the same file)
//! 3. BLAKE3 of the first and last 16 KiB
//! 4. full BLAKE3
//! 5. byte-for-byte verification against the group's first member
//!
//! Only groups that survive step 5 are reported.

use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};

const EDGE: u64 = 16 * 1024;
const BUF: usize = 1 << 20;

#[derive(Debug, Clone)]
pub struct Candidate {
    pub id: u32,
    pub path: PathBuf,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DupGroup {
    pub id: u32,
    pub size: u64,
    pub hash: String,
    pub files: Vec<u32>,
    /// Extra paths that are hard links to a member (not separate copies).
    pub hardlinked: Vec<u32>,
}

impl DupGroup {
    pub fn reclaimable(&self) -> u64 {
        self.size * (self.files.len() as u64 - 1)
    }
}

#[derive(Default)]
pub struct DupProgress {
    /// 1 = sizing, 2 = identity, 3 = quick hash, 4 = full hash, 5 = verify
    pub stage: AtomicU8,
    pub done_bytes: AtomicU64,
    pub total_bytes: AtomicU64,
    pub candidates: AtomicU64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DupResult {
    pub groups: Vec<DupGroup>,
    pub reclaimable: u64,
    pub files_considered: u64,
    pub hashed_bytes: u64,
    pub unreadable: u64,
    pub min_size: u64,
    pub finished_at: i64,
    pub cancelled: bool,
}

fn edge_hash(c: &Candidate) -> io::Result<[u8; 32]> {
    let mut f = File::open(&c.path)?;
    let mut h = blake3::Hasher::new();
    let mut buf = vec![0u8; EDGE as usize];
    let n = read_full(&mut f, &mut buf)?;
    h.update(&buf[..n]);
    if c.size > 2 * EDGE {
        f.seek(SeekFrom::End(-(EDGE as i64)))?;
        let n = read_full(&mut f, &mut buf)?;
        h.update(&buf[..n]);
    }
    Ok(*h.finalize().as_bytes())
}

fn read_full(f: &mut File, buf: &mut [u8]) -> io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match f.read(&mut buf[n..])? {
            0 => break,
            k => n += k,
        }
    }
    Ok(n)
}

fn full_hash(c: &Candidate, cancel: &AtomicBool, progress: &DupProgress) -> io::Result<[u8; 32]> {
    let mut f = File::open(&c.path)?;
    let mut h = blake3::Hasher::new();
    let mut buf = vec![0u8; BUF];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(io::Error::other("cancelled"));
        }
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        progress.done_bytes.fetch_add(n as u64, Ordering::Relaxed);
    }
    Ok(*h.finalize().as_bytes())
}

/// Byte-for-byte comparison.
pub fn same_content(a: &PathBuf, b: &PathBuf, cancel: &AtomicBool) -> io::Result<bool> {
    let (mut fa, mut fb) = (File::open(a)?, File::open(b)?);
    if fa.metadata()?.len() != fb.metadata()?.len() {
        return Ok(false);
    }
    let mut ba = vec![0u8; BUF];
    let mut bb = vec![0u8; BUF];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(io::Error::other("cancelled"));
        }
        let na = read_full(&mut fa, &mut ba)?;
        let nb = read_full(&mut fb, &mut bb)?;
        if na != nb || ba[..na] != bb[..nb] {
            return Ok(false);
        }
        if na == 0 {
            return Ok(true);
        }
    }
}

fn regroup<K: std::hash::Hash + Eq + Send>(
    groups: Vec<Vec<Candidate>>,
    key: impl Fn(&Candidate) -> Option<K> + Sync,
    unreadable: &AtomicU64,
) -> Vec<Vec<Candidate>> {
    groups
        .into_par_iter()
        .flat_map_iter(|g| {
            let keyed: Vec<(Option<K>, Candidate)> = g.into_iter().map(|c| (key(&c), c)).collect();
            let mut map: HashMap<K, Vec<Candidate>> = HashMap::new();
            for (k, c) in keyed {
                match k {
                    Some(k) => map.entry(k).or_default().push(c),
                    None => {
                        unreadable.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
            map.into_values().filter(|v| v.len() > 1)
        })
        .collect()
}

pub fn find_duplicates(cands: Vec<Candidate>, cancel: &AtomicBool, progress: &DupProgress) -> DupResult {
    let mut result = DupResult { files_considered: cands.len() as u64, ..Default::default() };
    let unreadable = AtomicU64::new(0);
    progress.stage.store(1, Ordering::Relaxed);
    progress.candidates.store(cands.len() as u64, Ordering::Relaxed);

    let mut by_size: HashMap<u64, Vec<Candidate>> = HashMap::new();
    for c in cands.into_iter().filter(|c| c.size > 0) {
        by_size.entry(c.size).or_default().push(c);
    }
    let groups: Vec<Vec<Candidate>> = by_size.into_values().filter(|g| g.len() > 1).collect();

    // Hard links: keep one representative per physical file.
    progress.stage.store(2, Ordering::Relaxed);
    let mut hardlinked: HashMap<u32, Vec<u32>> = HashMap::new();
    let groups: Vec<Vec<Candidate>> = groups
        .into_par_iter()
        .map(|g| {
            let mut seen: HashMap<(u64, u64), u32> = HashMap::new();
            let mut kept = Vec::new();
            let mut links: Vec<(u32, u32)> = Vec::new();
            for c in g {
                match crate::platform::file_identity(&c.path) {
                    Ok((vol, idx, _)) => {
                        if let Some(&rep) = seen.get(&(vol, idx)) {
                            links.push((rep, c.id));
                        } else {
                            seen.insert((vol, idx), c.id);
                            kept.push(c);
                        }
                    }
                    Err(_) => {
                        unreadable.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
            (kept, links)
        })
        .collect::<Vec<_>>()
        .into_iter()
        .filter_map(|(kept, links)| {
            for (rep, id) in links {
                hardlinked.entry(rep).or_default().push(id);
            }
            (kept.len() > 1).then_some(kept)
        })
        .collect();
    if cancel.load(Ordering::Relaxed) {
        result.cancelled = true;
        return result;
    }

    progress.stage.store(3, Ordering::Relaxed);
    let groups = regroup(groups, |c| edge_hash(c).ok(), &unreadable);
    if cancel.load(Ordering::Relaxed) {
        result.cancelled = true;
        return result;
    }

    progress.stage.store(4, Ordering::Relaxed);
    let total: u64 = groups.iter().flatten().map(|c| c.size).sum();
    progress.total_bytes.store(total, Ordering::Relaxed);
    progress.done_bytes.store(0, Ordering::Relaxed);
    let groups = regroup(groups, |c| full_hash(c, cancel, progress).ok(), &unreadable);
    result.hashed_bytes = total;
    if cancel.load(Ordering::Relaxed) {
        result.cancelled = true;
        return result;
    }

    progress.stage.store(5, Ordering::Relaxed);
    let verified: Vec<(Vec<Candidate>, String)> = groups
        .into_par_iter()
        .filter_map(|g| {
            let hash = full_hash(&g[0], cancel, &DupProgress::default()).ok()?;
            let first = g[0].path.clone();
            let mut members = vec![g[0].clone()];
            for c in g.into_iter().skip(1) {
                match same_content(&first, &c.path, cancel) {
                    Ok(true) => members.push(c),
                    Ok(false) => {}
                    Err(_) => {
                        unreadable.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
            (members.len() > 1).then(|| (members, blake3::Hash::from(hash).to_hex().to_string()))
        })
        .collect();

    let mut groups: Vec<DupGroup> = verified
        .into_iter()
        .map(|(members, hash)| {
            let hl = members.iter().flat_map(|m| hardlinked.get(&m.id).cloned().unwrap_or_default()).collect();
            DupGroup { id: 0, size: members[0].size, hash, files: members.iter().map(|m| m.id).collect(), hardlinked: hl }
        })
        .collect();
    groups.sort_by(|a, b| b.reclaimable().cmp(&a.reclaimable()));
    for (i, g) in groups.iter_mut().enumerate() {
        g.id = i as u32;
    }
    result.reclaimable = groups.iter().map(|g| g.reclaimable()).sum();
    result.groups = groups;
    result.unreadable = unreadable.load(Ordering::Relaxed);
    result.cancelled = cancel.load(Ordering::Relaxed);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn cand(id: u32, p: PathBuf) -> Candidate {
        let size = fs::metadata(&p).unwrap().len();
        Candidate { id, path: p, size }
    }

    #[test]
    fn finds_true_duplicates_only() {
        let t = tempfile::tempdir().unwrap();
        let big: Vec<u8> = (0..100_000u32).map(|i| (i % 251) as u8).collect();
        let mut tweaked = big.clone();
        tweaked[50_000] ^= 1; // same size, same edges, different middle
        fs::write(t.path().join("a"), &big).unwrap();
        fs::write(t.path().join("b"), &big).unwrap();
        fs::write(t.path().join("c"), &tweaked).unwrap();
        fs::write(t.path().join("d"), b"tiny").unwrap();
        fs::write(t.path().join("e"), b"tiny").unwrap();
        fs::write(t.path().join("f"), b"tine").unwrap();

        let cands = ["a", "b", "c", "d", "e", "f"]
            .iter()
            .enumerate()
            .map(|(i, n)| cand(i as u32, t.path().join(n)))
            .collect();
        let r = find_duplicates(cands, &AtomicBool::new(false), &DupProgress::default());
        assert_eq!(r.groups.len(), 2);
        let mut sets: Vec<Vec<u32>> = r.groups.iter().map(|g| { let mut f = g.files.clone(); f.sort(); f }).collect();
        sets.sort();
        assert_eq!(sets, vec![vec![0, 1], vec![3, 4]]);
        assert_eq!(r.reclaimable, 100_000 + 4);
    }

    #[test]
    fn hard_links_are_not_duplicates() {
        let t = tempfile::tempdir().unwrap();
        fs::write(t.path().join("orig"), b"same content here").unwrap();
        fs::hard_link(t.path().join("orig"), t.path().join("link")).unwrap();
        let cands = vec![cand(0, t.path().join("orig")), cand(1, t.path().join("link"))];
        let r = find_duplicates(cands, &AtomicBool::new(false), &DupProgress::default());
        assert!(r.groups.is_empty());
    }
}
