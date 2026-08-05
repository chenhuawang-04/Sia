use std::collections::HashMap;
use branchly_core::Document;
use serde::{Deserialize, Serialize};
use tauri::{ipc::{InvokeBody, Request}, AppHandle, Manager, State};
use crate::{auth::LoginError, database::{SaveReceipt, SaveStatus, StorageHealth}, state::AppState};

fn require_auth(state: &AppState) -> Result<(), String> {
    if state.auth.lock().is_unlocked() { Ok(()) } else { Err("AUTHENTICATION_REQUIRED".into()) }
}

#[tauri::command]
pub fn auth_status(state: State<'_, AppState>) -> bool { state.auth.lock().is_unlocked() }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResult { ok: bool, remaining: Option<u8>, retry_after_seconds: Option<u64> }

#[tauri::command]
pub fn login(password: String, state: State<'_, AppState>) -> LoginResult {
    let result = state.auth.lock().unlock(&password);
    match result {
        Ok(()) => {
            if state.vault.unlock(&password).is_ok() {
                if let Ok(Some(session)) = state.vault.load::<crate::sync::CloudSession>() { *state.cloud.lock() = session; }
            }
            LoginResult { ok: true, remaining: None, retry_after_seconds: None }
        },
        Err(LoginError::Invalid(remaining)) => LoginResult { ok: false, remaining: Some(remaining), retry_after_seconds: None },
        Err(LoginError::RateLimited(seconds)) => LoginResult { ok: false, remaining: Some(0), retry_after_seconds: Some(seconds) },
    }
}

#[tauri::command]
pub fn logout(state: State<'_, AppState>) {
    state.auth.lock().lock(); state.vault.lock(); *state.cloud.lock() = crate::sync::CloudSession::default();
}

#[tauri::command]
pub async fn load_map(state: State<'_, AppState>) -> Result<Document, String> {
    require_auth(&state)?; let database = state.database.clone();
    tauri::async_runtime::spawn_blocking(move || database.lock().load()).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn save_map(document: Document, state: State<'_, AppState>) -> Result<SaveReceipt, String> {
    require_auth(&state)?; let database = state.database.clone();
    tauri::async_runtime::spawn_blocking(move || database.lock().save(document)).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn save_status(state: State<'_, AppState>) -> Result<SaveStatus, String> {
    require_auth(&state)?; let database = state.database.clone();
    tauri::async_runtime::spawn_blocking(move || database.lock().status()).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

#[derive(Deserialize)]
struct ImageUploadHeader { name: String, mime: String }

#[tauri::command]
pub fn store_image_raw(request: Request<'_>, state: State<'_, AppState>) -> Result<branchly_core::ImageMetadata, String> {
    require_auth(&state)?;
    let InvokeBody::Raw(payload) = request.body() else { return Err("binary image payload required".into()); };
    if payload.len() < 4 { return Err("image payload header is missing".into()); }
    let header_length = u32::from_be_bytes(payload[..4].try_into().map_err(|_| "invalid image header")?) as usize;
    if header_length == 0 || header_length > 1024 || payload.len() < 4 + header_length { return Err("invalid image header length".into()); }
    let header: ImageUploadHeader = serde_json::from_slice(&payload[4..4 + header_length]).map_err(|error| error.to_string())?;
    let image = state.images.store(&header.name, &header.mime, &payload[4 + header_length..]).map_err(|error| error.to_string())?;
    state.database.lock().register_asset(&image).map_err(|error| error.to_string())?;
    Ok(image)
}

#[tauri::command]
pub fn delete_image(file: String, state: State<'_, AppState>) -> Result<(), String> {
    require_auth(&state)?;
    state.images.delete(&file).map_err(|e| e.to_string())?;
    state.database.lock().mark_asset_deleted(&file).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn resolve_image_paths(files: Vec<String>, state: State<'_, AppState>) -> Result<HashMap<String, String>, String> {
    require_auth(&state)?;
    let resolved = state.images.resolve_many(&files).map_err(|e| e.to_string())?;
    state.database.lock().mark_assets_restored(resolved.keys()).map_err(|e| e.to_string())?;
    Ok(resolved)
}

#[tauri::command]
pub async fn storage_health(state: State<'_, AppState>) -> Result<StorageHealth, String> {
    require_auth(&state)?; let database = state.database.clone();
    tauri::async_runtime::spawn_blocking(move || database.lock().health()).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn cloud_login(endpoint: String, email: String, password: String, state: State<'_, AppState>) -> Result<(), String> {
    require_auth(&state)?;
    crate::sync::login(&state, endpoint, email, password).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cloud_register(endpoint: String, email: String, password: String, state: State<'_, AppState>) -> Result<(), String> {
    require_auth(&state)?;
    crate::sync::register(&state, endpoint, email, password).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cloud_logout(state: State<'_, AppState>) -> Result<(), String> {
    require_auth(&state)?; crate::sync::logout(&state).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cloud_status(state: State<'_, AppState>) -> Result<crate::sync::CloudStatus, String> {
    require_auth(&state)?; crate::sync::status(&state).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_once(state: State<'_, AppState>) -> Result<crate::sync::SyncOutcome, String> {
    require_auth(&state)?; crate::sync::run_once(&state).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_conflicts(state: State<'_, AppState>) -> Result<Vec<crate::database::ConflictSummary>, String> {
    require_auth(&state)?; let database = state.database.clone();
    tauri::async_runtime::spawn_blocking(move || database.lock().conflicts()).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn resolve_conflict(id: String, use_remote: bool, state: State<'_, AppState>) -> Result<bool, String> {
    require_auth(&state)?; let database = state.database.clone();
    tauri::async_runtime::spawn_blocking(move || database.lock().resolve_conflict(&id, use_remote)).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

#[tauri::command]
pub fn export_map(document: Document, state: State<'_, AppState>, app: AppHandle) -> Result<String, String> {
    require_auth(&state)?;
    branchly_core::validate_document(&document).map_err(|error| error.to_string())?;
    let directory = app.path().document_dir().or_else(|_| app.path().app_data_dir()).map_err(|error| error.to_string())?.join("Branchly");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let title: String = document.title.chars().map(|character| if "<>:\"/\\|?*".contains(character) { '_' } else { character })
        .take(60).collect();
    let file = directory.join(format!("{}-{}-{}.json", if title.trim().is_empty() { "mindmap" } else { &title },
        chrono::Local::now().format("%Y%m%d-%H%M%S"), &uuid::Uuid::new_v4().to_string()[..6]));
    let temporary = file.with_extension("json.tmp");
    std::fs::write(&temporary, format!("{}\n", serde_json::to_string_pretty(&document).map_err(|error| error.to_string())?))
        .map_err(|error| error.to_string())?;
    std::fs::rename(temporary, &file).map_err(|error| error.to_string())?;
    Ok(file.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn list_snapshots(state: State<'_, AppState>) -> Result<Vec<crate::database::SnapshotSummary>, String> {
    require_auth(&state)?; let database = state.database.clone();
    tauri::async_runtime::spawn_blocking(move || database.lock().snapshots()).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn restore_snapshot(id: String, state: State<'_, AppState>) -> Result<(), String> {
    require_auth(&state)?; let database = state.database.clone();
    tauri::async_runtime::spawn_blocking(move || database.lock().restore_snapshot(&id)).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}
