mod auth;
mod commands;
mod credentials;
mod database;
mod images;
mod state;
mod sync;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show(); let _ = window.unminimize(); let _ = window.set_focus();
        }
    }));
    builder
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let resource_dir = app.path().resource_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            app.manage(AppState::open(data_dir, resource_dir)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::auth_status,
            commands::login,
            commands::logout,
            commands::load_map,
            commands::save_map,
            commands::save_status,
            commands::store_image_raw,
            commands::delete_image,
            commands::resolve_image_paths,
            commands::storage_health,
            commands::cloud_login,
            commands::cloud_register,
            commands::cloud_logout,
            commands::cloud_status,
            commands::sync_once,
            commands::list_conflicts,
            commands::resolve_conflict,
            commands::export_map,
            commands::list_snapshots,
            commands::restore_snapshot,
        ])
        .run(tauri::generate_context!())
        .expect("Branchly runtime failed");
}
