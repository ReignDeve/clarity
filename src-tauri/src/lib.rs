//! CLARITY — understand your storage, decide what stays, reclaim your space.

pub mod cleanup;
pub mod commands;
pub mod db;
pub mod duplicates;
pub mod model;
pub mod paths;
pub mod platform;
pub mod preview;
pub mod protect;
pub mod query;
pub mod recommend;
pub mod scan;
pub mod timeline;
pub mod activity;
pub mod features;
pub mod media;
pub mod organize;
pub mod organizer;
pub mod relations;
pub mod shell;
pub mod watch;

use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    platform::quiet_error_mode();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .register_asynchronous_uri_scheme_protocol("thumb", features::thumb_protocol)
        .setup(|app| {
            // CLARITY_DATA_DIR isolates test runs from the user's real history.
            let data_dir = match std::env::var_os("CLARITY_DATA_DIR") {
                Some(d) => std::path::PathBuf::from(d),
                None => app.path().app_data_dir()?,
            };
            std::fs::create_dir_all(&data_dir)?;
            {
                let d = data_dir.clone();
                std::thread::spawn(move || features::prune_thumbs(&d));
            }
            app.manage::<commands::AppState>(Arc::new(commands::Shared::new(data_dir)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::get_drives,
            commands::get_settings,
            commands::save_settings,
            commands::start_scan,
            commands::cancel_scan,
            commands::load_cached_scan,
            commands::get_overview,
            commands::query_files,
            commands::list_dir,
            commands::get_tree,
            commands::get_recommendations,
            commands::file_detail,
            commands::dir_detail,
            commands::start_duplicates,
            commands::cancel_duplicates,
            commands::get_duplicates,
            commands::preview_source,
            commands::preview_text,
            commands::preview_archive,
            commands::open_file,
            commands::reveal,
            commands::review_cleanup,
            commands::execute_cleanup,
            commands::get_history,
            commands::get_scan_issues,
            commands::timeline_roots,
            commands::timeline_series,
            commands::timeline_compare,
            commands::locate_path,
            features::file_relations,
            features::plan_move,
            features::execute_move,
            features::media_query,
            features::media_meta,
            features::media_index_start,
            features::file_activity,
            features::watch_list,
            features::watch_add,
            features::watch_update,
            features::watch_pause,
            features::watch_remove,
            features::watch_mark_seen,
            features::organize_analyze,
            features::organize_conflicts,
            features::organize_apply,
            features::organize_cancel,
            features::organize_runs,
            features::organize_undo,
        ])
        .run(tauri::generate_context!())
        .expect("error while running CLARITY");
}
