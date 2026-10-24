//! Daily file activity from file timestamps (for the calendar heatmap).
//!
//! These are dates the files *report* (created / modified), not activity
//! CLARITY witnessed. Observed events (scans, cleanups) are supplied
//! separately by the caller and kept apart in the result.

use crate::model::{flags, plausible_time, Category, ScanIndex};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ActivityQuery {
    /// "created" | "modified"
    pub field: String,
    pub under_dir: Option<u32>,
    pub categories: Vec<String>,
    /// Inclusive local-day range (days since 1970-01-01 in local time).
    pub from_day: i64,
    pub to_day: i64,
    /// Minutes east of UTC (e.g. 120 for CEST).
    pub tz_offset_min: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Day {
    pub day: i64,
    pub files: u32,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Observed {
    pub day: i64,
    pub at: i64,
    /// "scan" | "cleanup"
    pub kind: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub days: Vec<Day>,
    pub total_files: u64,
    pub total_bytes: u64,
    /// Files whose date is missing or a placeholder (1980, future…).
    pub undated: u64,
    /// First and last day with any dated file (for the year picker).
    pub first_day: Option<i64>,
    pub last_day: Option<i64>,
    pub observed: Vec<Observed>,
}

pub fn local_day(ts: i64, tz_offset_min: i64) -> i64 {
    (ts + tz_offset_min * 60).div_euclid(86_400)
}

pub fn compute(index: &ScanIndex, q: &ActivityQuery, now: i64) -> Activity {
    let cats: Vec<Category> = q.categories.iter().filter_map(|c| Category::parse(c)).collect();
    let under = q.under_dir.map(|d| index.subtree_mask(d));
    let mut days: BTreeMap<i64, (u32, u64)> = BTreeMap::new();
    let (mut total_files, mut total_bytes, mut undated) = (0u64, 0u64, 0u64);
    let (mut first, mut last) = (i64::MAX, i64::MIN);
    for f in &index.files {
        if f.flags & flags::REMOVED != 0 || (!cats.is_empty() && !cats.contains(&f.cat)) {
            continue;
        }
        if under.as_ref().is_some_and(|m| !m[f.dir as usize]) {
            continue;
        }
        let ts = if q.field == "created" { f.created } else { f.modified };
        if !plausible_time(ts, now) {
            undated += 1;
            continue;
        }
        let day = local_day(ts, q.tz_offset_min);
        first = first.min(day);
        last = last.max(day);
        if day < q.from_day || day > q.to_day {
            continue;
        }
        let e = days.entry(day).or_default();
        e.0 += 1;
        e.1 += f.size;
        total_files += 1;
        total_bytes += f.size;
    }
    Activity {
        days: days.into_iter().map(|(day, (files, bytes))| Day { day, files, bytes }).collect(),
        total_files,
        total_bytes,
        undated,
        first_day: (first != i64::MAX).then_some(first),
        last_day: (last != i64::MIN).then_some(last),
        observed: vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_days() {
        // 2026-01-01 00:30 in UTC+2 is still 2025-12-31 22:30 UTC.
        let ts = 1_767_220_200; // 2025-12-31T22:30:00Z
        assert_eq!(local_day(ts, 0), 20_453);
        assert_eq!(local_day(ts, 120), 20_454);
        assert_eq!(local_day(ts, -300), 20_453);
    }
}
