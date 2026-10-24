# CLARITY

**Understand your storage. Decide what stays. Reclaim your space.**

CLARITY is a Windows desktop app (Tauri 2 + React + Rust) that scans drives
or folders locally, explains what takes up space, flags files worth a
second look with transparent rules, finds byte-identical duplicates, and
lets you clean up safely through the Recycle Bin.

Everything runs on the machine: no account, no network calls, no telemetry.

## Requirements

| Tool | Version |
| --- | --- |
| Windows | 10 1809+ / 11 (WebView2 is preinstalled on 11) |
| Rust | stable, `x86_64-pc-windows-msvc` (tested with 1.98) |
| MSVC build tools | VS 2022 Build Tools, workload *Desktop development with C++* + Windows 11 SDK |
| Node.js | 20+ (tested with 22) |
| pnpm | 10+ |

```
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.Windows11SDK.22621 --includeRecommended"
```

## Development

```
pnpm install
pnpm app:dev        # desktop app with hot reload (Vite on :6420 + Rust backend)
pnpm dev            # UI only, in a browser, with clearly labelled DEMO DATA
```

`pnpm dev` exists for UI work without the Rust toolchain. The browser build
detects that it is not running inside Tauri and swaps in `src/lib/demo.ts`,
a synthetic dataset. The title bar then shows a **DEMO DATA** badge. The
desktop app never uses demo data.

## Tests

```
pnpm test:rust      # scanner, safety checks, duplicates, queries, previews, DB (cargo test)
pnpm test           # frontend helpers (vitest)
pnpm typecheck
```

The Rust suite creates real files, hard links and NTFS junctions in temp
folders. Highlights:

- `scan::junction_loops_are_not_followed`: a junction pointing at its own ancestor does not loop
- `cleanup::refuses_when_parent_became_a_junction`: swapping a scanned folder for a junction after the scan blocks removal
- `cleanup::refuses_files_changed_since_scan`, `refuses_missing_and_retyped_items`, `refuses_roots_protected_and_unknown_ids`
- `cleanup::deletes_exactly_the_selected_file`: neighbours survive, index totals update
- `duplicates::finds_true_duplicates_only`: same size + same first/last 16 KiB but different middle is *not* a duplicate
- `duplicates::hard_links_are_not_duplicates`
- `protect::*`: Windows, Program Files, AppData, drive roots, `$Recycle.Bin`, `pagefile.sys`, known-folder roots

## Production build

```
pnpm app:build
```

Outputs:

- `src-tauri/target/release/clarity.exe`: portable executable
- `src-tauri/target/release/bundle/nsis/CLARITY_0.1.0_x64-setup.exe`: installer
- `src-tauri/target/release/bundle/msi/CLARITY_0.1.0_x64_en-US.msi`

The app runs without administrator rights. Folders Windows does not let a
normal user read are reported as unreadable instead of failing the scan.

## Releases & auto-updates

CLARITY updates itself from **Nexus ReleaseHub** (`aevar/clarity`, channel `stable`); details in [NEXUS.md](NEXUS.md).

```
pnpm release patch      # or minor / major / 1.2.3
```

The command:

1. bumps `package.json`, `tauri.conf.json`, `Cargo.toml` and `Cargo.lock`
2. commits and tags `vX.Y.Z`
3. pushes the commit and the tag

The tag starts `.github/workflows/release.yml` on a Windows runner. It runs the tests, builds the NSIS and MSI
installers, uploads them to Nexus (which signs them for the Tauri updater) and publishes the release. Installed
copies check about 5 s after start and every 6 h, download in the background, and show **Restart to update**
in the title bar. Settings → Updates has *Check now* and the auto-download toggle.

The workflow needs the repository secret `NEXUS_TOKEN`: a project-scoped Nexus token with `read, write, publish`.

## Architecture

```
src-tauri/src/
  model.rs       ScanIndex: BFS-ordered dirs/files, contiguous children, paths rebuilt from parent chain
  scan.rs        parallel level-synchronous scanner (rayon), progress, cancellation, exclusions
  platform.rs    Win32: drives, free space, file identity (hard links), on-disk size, last-access policy
  paths.rs       case-insensitive path normalisation + containment checks
  protect.rs     locations that can never be removed
  recommend.rs   transparent review rules ("large & unchanged", old installers, build output, …)
  duplicates.rs  size → hard-link collapse → edge hash → BLAKE3 → byte-by-byte verify
  cleanup.rs     validation immediately before removal + Recycle Bin / permanent delete
  preview.rs     text (encoding sniffing) and ZIP/TAR listings without extraction
  query.rs       overview, filtered/sorted file queries, folder listings, treemap
  db.rs          SQLite: settings, scan history, cleanup history
  commands.rs    Tauri command surface + shared state, background jobs, events

src/
  lib/api.ts     typed backend interface (Tauri or demo)
  store/app.ts   zustand app state (view, selection, inspector, scan status)
  components/    sidebar, title bar, inspector, virtualised file list, overlays, scan flow
  previews/      PDF (pdf.js), image (zoom/pan), video, audio, text (highlight.js), archive
  views/         overview, analysis (treemap), lists, duplicates, suggestions, explorer, history, settings
```

### Data flow

1. `start_scan` runs the scanner on a background thread and emits
   `scan-progress` about 8 times per second (counts, bytes, current folder,
   elapsed). It does not report a percentage, because the total is unknown
   until the scan finishes.
2. The finished `ScanIndex` lives in memory. It is also serialised
   (bincode) to `%APPDATA%\studio.enquso.clarity\scan-cache.bin` so the
   next launch can show it immediately, marked "from last session".
3. The UI never sends paths for actions. It sends `{kind, id}` references
   into the index. The backend rebuilds the path and validates it.

### Safety model (cleanup)

Every item is checked when the review dialog opens and again right before
it is removed:

- The item must be in the current index, so it lies inside a folder the user chose to scan. Scan roots themselves cannot be removed.
- It must not be in a protected location: `%SystemRoot%`, Program Files, ProgramData, `AppData`, Recovery/Boot/EFI, `$Recycle.Bin`, System Volume Information, WindowsApps. Drive roots, the user profile and known folders (Desktop, Documents, Downloads, …) are protected as folders, though their contents can be removed. Files carrying the SYSTEM attribute are also protected.
- The item must still exist, have the same type and (for files) the same size and modification time as at scan time.
- `canonicalize(path)` must equal the scanned path. This catches a parent folder that was replaced by a junction or symlink after the scan.
- Recycle Bin mode only runs on fixed local drives. On removable and network drives, Windows would silently delete permanently.
- Permanent deletion needs a separate confirmation in the UI, and the backend command refuses it without an explicit confirmation token.
- After each operation CLARITY verifies the item is actually gone. Only verified removals count, and "space freed" for Recycle Bin moves is reported as 0 until the bin is emptied.

### Honest timestamps

Windows often does not update last-access times (see
`NtfsDisableLastAccessUpdate`), and when it does, antivirus software and
indexers also touch them. CLARITY therefore:

- reads the policy from the registry and tells the user what it means
- bases all suggestions on **modification** dates only
- labels access times "approximate" or "not reliable on this PC"
- shows "Observed usage: unknown", because CLARITY does not monitor file opens

### Symlinks, junctions, hard links, cloud files

- Name-surrogate reparse points (symlinks, junctions, mount points) are never followed. They are counted and reported. This prevents loops and double counting.
- OneDrive placeholders (`RECALL_ON_DATA_ACCESS` / `OFFLINE`) are traversed but never read: no hashing, no previews, so nothing is downloaded. Their size is shown as cloud-only and not counted as recoverable.
- Hard links are collapsed during duplicate detection, and the cleanup review warns that space is only freed once every link is gone.
- For items inside the OneDrive folder, the cleanup review warns that removal syncs to the cloud.

## Storage Timeline

*Storage Analysis → Timeline.* After every scan, `timeline.rs` saves a
snapshot to the same SQLite database. A snapshot never copies the full
scan. Per scanned location it stores:

| Table | Content | Kept |
| --- | --- | --- |
| `snapshot_roots` | total bytes/files, drive used/total at scan time | forever |
| `snapshot_categories` | bytes and files per file type | forever |
| `snapshot_dirs` | folders ≥ 16 MB, max. 5 levels deep, max. 4,000 | newest 120 snapshots |
| `snapshot_files` | files ≥ 10 MB (size, mtime, type), max. 50,000 | newest 24 snapshots |
| `paths` | every path once, referenced by id | while referenced |

The long-range chart never loses points. Folder and file detail ages out,
and the UI says so when a comparison reaches past it.

What the comparison shows:

- totals per location and the drive's own used space
- changes by file type
- the folders that grew or shrank. A parent whose change is ≥ 75 % explained by one subfolder is left out, so the list points to where things happened.
- large files added, removed or changed
- highlights ("Downloads grew by 5.2 GB"), all computed from those numbers

Every folder, file and highlight is clickable. It resolves the path against
the current scan (`locate_path`) and opens it in the File Explorer and
Inspector. Items that no longer exist say so.

Edge cases:

- **Cancelled scans** are stored as totals-only points (hollow in the chart) and never used for comparisons.
- **Disconnected drives** keep their history. Their chip shows an unplugged icon, and gaps between scans are drawn dashed instead of being interpolated.
- **History from before the timeline existed:** single-location rows from the old scan history are imported once as totals-only points. Opening the cached scan from the last session creates its full snapshot.
- **Changed scan settings** (exclusions, system folders) and large jumps in unreadable items produce a warning on the comparison.

Testing without touching real history:

```
$env:CLARITY_DATA_DIR = "<temp folder>"            # separate database and cache
$env:WEBVIEW2_USER_DATA_FOLDER = "<temp folder>"   # separate WebView2 profile
```

## Media Explorer

*Sidebar → Media.* A gallery of every image, video and audio file in the
scan, with grid and list views, virtualised for tens of thousands of items.

- **Thumbnails** come from the Windows shell (`IShellItemImageFactory`), the same source Explorer uses. They work for every format Windows has a codec for (HEIC, RAW, video frames) without bundling codecs. They are served through the `thumb://` protocol, cached as JPEG in `<data>\thumbs` (pruned to ~300 MB), and never downloaded for cloud-only files (`SIIGBF_INCACHEONLY`).
- **Metadata** (resolution, duration, frame rate, bitrate, date taken, camera, title/artist/album) is read via the Windows property system (`IShellItem2`). A background job fills it for all media and caches it in SQLite (`media_meta`, keyed by path + size + mtime). Sorting and filtering by resolution or duration become complete when the job finishes, and the UI shows its progress.
- **Group related** folds subtitles, sidecars, RAW/JPEG pairs, posters and edited versions under their main file. It is computed in one O(n) pass per folder (`media::build_groups`).

## File relationships

*Inspector → Related files.* `relations.rs` detects relationships from
names, extensions, folder structure, sizes and verified duplicate groups.
It reads no file contents and uses no AI. Each relationship has a confidence
level:

| Confidence | Examples |
| --- | --- |
| confident | video ↔ `name.en.srt`, RAW ↔ JPEG of the same shot, `.xmp`/`.aae` sidecars, lyrics/cue sheets, verified identical copies |
| likely | `Report.docx` ↔ `Report.pdf`, `design.psd` ↔ `design.png`, `IMG_1` ↔ `IMG_1-edited` / `(1)` / `_v2` / an *Edited* folder, same name + size elsewhere |
| possible | project files (`.prproj`, `.aep`, `.blend`, …) ↔ media in their folder or in `assets/footage/renders` subfolders |

Possible matches stay collapsed until requested. **Move with related files**
(`organize.rs`) works like this:

- Preview each source → destination pair before anything happens.
- Never overwrite an existing file, and never move into a protected location.
- Re-validate each item right before its move, like cleanup does.
- Across drives: copy, verify the size, then remove the original.
- Each move is recorded in Cleanup History.

## Activity heatmap

*Storage Analysis → Activity.* A calendar of how many files (or how much
data) were created or modified per day, in local time. It can be filtered
by location and file type. Clicking a day lists its files.

- Squares show file timestamps. Outlined days are events CLARITY observed itself (scans, cleanups), so the two are never mixed up.
- Placeholder dates (1980, future) are counted as "undated" and not drawn.
- From a Timeline comparison, *File activity in this period* opens the heatmap focused on that range.

## Watchlist

*Storage Analysis → Watchlist.* A location can be added from the Watchlist
tab or with the eye button in a folder's Inspector. Each entry can have:

- a size limit
- a growth threshold in GB and/or percent
- a Windows notification (`tauri-plugin-notification`), off by default

How alerts work:

- After every complete scan that covers a watched location, its size is recorded (`watch_history`) and the rules are checked.
- A limit alert fires once per period over the limit, including when the location was already over it when added.
- Locations not covered by the scan (other drive, disconnected) are skipped rather than reported as 0.
- A watched folder that disappears raises one "missing" alert.
- History is backfilled from the Storage Timeline when an entry is added.
- Unread alerts show on the Overview and as a badge on Storage Analysis.

## Smart Folder Organizer

The Organizer opens from the **Organize** button in the File Explorer, in a
folder's Inspector, or in the Downloads view. A start screen also offers
Downloads, Desktop and Documents directly. It works on any folder, with or
without a scan.

`organizer.rs` reads the folder live and only considers the **loose files
directly inside it**. Existing subfolders are left as they are, though files
may be placed into them.

Skipped files:

- hidden and system files
- links
- unfinished downloads (`.crdownload`, `.part`, …)

Modes:

| Mode | Structure |
| --- | --- |
| Smart | By type. Subfolders such as PDFs, Spreadsheets, Screenshots, Photos and Screen recordings appear only when the type has ≥ 2 × the minimum and the subfolder reaches the minimum. Groups of ≥ 80 files that span several years get year folders. |
| By type | Documents, Images, Videos, Audio, Archives, Installers, Shortcuts, … |
| By date | `2025/03 March`. Small months fold into their year. Files with placeholder dates go to `Undated`. |
| Custom | Ordered rules (extension, name contains, type, unchanged for N days, larger than N MB) → `Folder/Sub`. Unmatched files stay or are sorted smartly. |

General rules for all modes:

- Folders with fewer files than the minimum (default 3) are not created. Those files go to `Other` if there are enough of them, otherwise they stay where they are.
- Related files (same name, subtitles, sidecars, edited versions, document ↔ PDF) always move with their main file.

**Preview.** Each folder shows its files and a *new*/*existing* badge. You can:

- include or exclude single files or whole folders
- rename a folder
- send a file to another folder, a new one, or "stay in place"

Conflicts are re-checked on the backend after every edit. Existing files and
duplicate target names are flagged, and each conflict can be left alone or
kept as `name (2).ext`.

**Applying.** Nothing moves until you confirm, in the UI and in the backend
(`confirmed`). For each file, right before its move:

- size and mtime must still match the preview, otherwise the file is skipped
- folders are created as needed (links and files in the way are refused)
- the move uses `MoveFileExW` without `REPLACE_EXISTING`, so it can never overwrite (`std::fs::rename` would)
- the target must stay inside the chosen folder

Locked files and permission errors are reported per file. Progress is
streamed, cancellation stops after the current file, and every item is
written to SQLite (`organize_runs/items/dirs`) as it happens.

**Undo** (from the completion summary or Cleanup History) moves each file
back only if:

- it is still where CLARITY put it
- it is unchanged (size and mtime)
- its original name is free and its original folder exists

Anything else stays in place and is listed with the reason. Folders the run
created are removed only if they are empty again (`remove_dir`), so no user
data is ever deleted.

## Keyboard

| Keys | Action |
| --- | --- |
| Ctrl 1–8, Ctrl , | switch views |
| ↑ ↓ PgUp PgDn Home End | move in lists (the inspector follows) |
| Space | select / deselect |
| Enter / double-click | Quick Look |
| I | toggle inspector |
| Ctrl F | search |
| Delete | review selection |
| ? | shortcut help |

## Status

Phase 1 (MVP) and most of Phase 2 are implemented: scanning, overview,
old/large file views, inspector with PDF/image/video/audio/text/archive
previews, Recycle Bin cleanup with history, settings and exclusions,
duplicates, treemap, scan cache.

Open (Phase 3): localisation (UI strings are English only), user-defined
rules, scheduled rescans, an "empty Recycle Bin" helper, and code signing for
the installer.
