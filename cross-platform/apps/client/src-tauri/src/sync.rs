use branchly_core::{PushResult, RemoteDocument, SyncEnvelope, DEFAULT_DOCUMENT_ID};
use serde::{Deserialize, Serialize};
use crate::{database::SyncJob, state::AppState};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSession {
    pub endpoint: Option<String>,
    pub access_token: Option<String>,
    pub account: Option<String>,
    pub refresh_token: Option<String>,
    pub access_expires_at: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tokens { access_token: String, refresh_token: String, expires_in: i64 }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudStatus {
    pub configured: bool,
    pub account: Option<String>,
    pub endpoint: Option<String>,
    pub pending_operations: i64,
    pub unresolved_conflicts: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    pub state: &'static str,
    pub revision: Option<i64>,
    pub changed_local_document: bool,
}

pub async fn login(state: &AppState, endpoint: String, email: String, password: String) -> anyhow::Result<()> {
    authenticate(state, endpoint, email, password, "login").await
}

pub async fn register(state: &AppState, endpoint: String, email: String, password: String) -> anyhow::Result<()> {
    authenticate(state, endpoint, email, password, "register").await
}

async fn authenticate(state: &AppState, endpoint: String, email: String, password: String, action: &str) -> anyhow::Result<()> {
    let endpoint = normalize_endpoint(endpoint)?;
    let response = state.http.post(format!("{endpoint}/v1/auth/{action}"))
        .json(&serde_json::json!({ "email": email, "password": password })).send().await?;
    anyhow::ensure!(response.status().is_success(), "cloud authentication failed ({})", response.status());
    let tokens: Tokens = response.json().await?;
    let session = CloudSession { endpoint: Some(endpoint), access_token: Some(tokens.access_token), account: Some(email),
        refresh_token: Some(tokens.refresh_token), access_expires_at: Some(chrono::Utc::now().timestamp() + tokens.expires_in) };
    state.vault.save(&session)?;
    *state.cloud.lock() = session;
    Ok(())
}

pub async fn logout(state: &AppState) -> anyhow::Result<()> {
    let current = state.cloud.lock().clone();
    if let (Some(endpoint), Some(refresh_token)) = (current.endpoint, current.refresh_token) {
        let _ = state.http.post(format!("{endpoint}/v1/auth/logout"))
            .json(&serde_json::json!({ "refreshToken": refresh_token })).send().await;
    }
    *state.cloud.lock() = CloudSession::default(); state.vault.clear()
}

pub fn status(state: &AppState) -> anyhow::Result<CloudStatus> {
    let cloud = state.cloud.lock().clone();
    let database = state.database.lock();
    let local = database.status()?;
    Ok(CloudStatus { configured: cloud.access_token.is_some(), account: cloud.account, endpoint: cloud.endpoint,
        pending_operations: local.pending_sync_operations, unresolved_conflicts: database.unresolved_conflicts()? })
}

pub async fn run_once(state: &AppState) -> anyhow::Result<SyncOutcome> {
    ensure_fresh_access_token(state).await?;
    let cloud = state.cloud.lock().clone();
    let endpoint = cloud.endpoint.ok_or_else(|| anyhow::anyhow!("cloud is not configured"))?;
    let token = cloud.access_token.ok_or_else(|| anyhow::anyhow!("cloud is not authenticated"))?;
    let (job, device_id) = {
        let database = state.database.lock();
        (database.next_sync_job()?, database.device_id()?)
    };
    upload_pending_assets(state, &endpoint, &token).await?;
    if let Some(job) = job { return push(state, &endpoint, &token, &device_id, job).await; }
    let response = state.http.get(format!("{endpoint}/v1/documents/{DEFAULT_DOCUMENT_ID}"))
        .bearer_auth(&token).send().await?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        state.database.lock().queue_current_for_sync()?;
        return Ok(SyncOutcome { state: "queued", revision: None, changed_local_document: false });
    }
    if response.status() == reqwest::StatusCode::UNAUTHORIZED { invalidate_access_token(state); }
    anyhow::ensure!(response.status().is_success(), "cloud pull failed ({})", response.status());
    let remote: RemoteDocument = response.json().await?;
    validate_remote(&remote)?;
    download_missing_assets(state, &endpoint, &token, &remote).await?;
    let changed = state.database.lock().accept_remote_if_clean(&remote)?;
    Ok(SyncOutcome { state: if changed { "pulled" } else { "idle" }, revision: Some(remote.revision), changed_local_document: changed })
}

async fn ensure_fresh_access_token(state: &AppState) -> anyhow::Result<()> {
    let current = state.cloud.lock().clone();
    if current.access_expires_at.is_some_and(|expires| expires > chrono::Utc::now().timestamp() + 30) { return Ok(()); }
    let endpoint = current.endpoint.clone().ok_or_else(|| anyhow::anyhow!("cloud endpoint is missing"))?;
    let refresh_token = current.refresh_token.clone().ok_or_else(|| anyhow::anyhow!("cloud session has expired; sign in again"))?;
    let response = state.http.post(format!("{endpoint}/v1/auth/refresh"))
        .json(&serde_json::json!({ "refreshToken": refresh_token })).send().await?;
    anyhow::ensure!(response.status().is_success(), "cloud session refresh failed ({})", response.status());
    let tokens: Tokens = response.json().await?;
    let mut updated = current;
    updated.access_token = Some(tokens.access_token); updated.refresh_token = Some(tokens.refresh_token);
    updated.access_expires_at = Some(chrono::Utc::now().timestamp() + tokens.expires_in);
    state.vault.save(&updated)?; *state.cloud.lock() = updated; Ok(())
}

async fn push(state: &AppState, endpoint: &str, token: &str, device_id: &str, job: SyncJob) -> anyhow::Result<SyncOutcome> {
    let asset_hashes = collect_asset_hashes(&job.document);
    let envelope = SyncEnvelope { operation_id: job.operation_id.clone(), document_id: job.document_id.clone(),
        device_id: device_id.into(), base_revision: job.base_revision, document: job.document, asset_hashes };
    let result = state.http.put(format!("{endpoint}/v1/documents/{}", job.document_id))
        .bearer_auth(token).json(&envelope).send().await;
    let response = match result {
        Ok(response) => response,
        Err(error) => {
            state.database.lock().postpone_sync(&job.operation_id, &error.to_string())?;
            return Err(error.into());
        }
    };
    if !response.status().is_success() {
        if response.status() == reqwest::StatusCode::UNAUTHORIZED { invalidate_access_token(state); }
        let message = format!("cloud push failed ({})", response.status());
        state.database.lock().postpone_sync(&job.operation_id, &message)?;
        anyhow::bail!(message);
    }
    match response.json::<PushResult>().await? {
        PushResult::Applied { revision, .. } | PushResult::AlreadyApplied { revision, .. } => {
            state.database.lock().complete_sync(&job.operation_id, revision)?;
            Ok(SyncOutcome { state: "pushed", revision: Some(revision), changed_local_document: false })
        }
        PushResult::Conflict { remote } => {
            validate_remote(&remote)?;
            download_missing_assets(state, endpoint, token, &remote).await?;
            let revision = remote.revision;
            state.database.lock().preserve_conflict_and_rebase(&job.operation_id, &remote)?;
            Ok(SyncOutcome { state: "conflict-preserved", revision: Some(revision), changed_local_document: false })
        }
    }
}

async fn upload_pending_assets(state: &AppState, endpoint: &str, token: &str) -> anyhow::Result<()> {
    let assets = state.database.lock().pending_assets()?;
    let client = &state.http;
    for asset in assets {
        let bytes = state.images.read(&asset.file_name)?;
        let response = client.put(format!("{endpoint}/v1/assets/{}", asset.sha256))
            .bearer_auth(token).header(reqwest::header::CONTENT_TYPE, &asset.mime).body(bytes).send().await?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED { invalidate_access_token(state); }
        anyhow::ensure!(response.status().is_success(), "asset upload failed ({})", response.status());
        state.database.lock().mark_asset_synced(&asset.sha256)?;
    }
    Ok(())
}

async fn download_missing_assets(state: &AppState, endpoint: &str, token: &str, remote: &RemoteDocument) -> anyhow::Result<()> {
    let mut images = Vec::new();
    fn visit(node: &branchly_core::Node, output: &mut Vec<branchly_core::ImageMetadata>) {
        output.extend(node.images.iter().cloned());
        for child in &node.children { visit(child, output); }
    }
    visit(&remote.document.root, &mut images);
    let client = &state.http;
    for image in images {
        let Some(hash) = image.sha256.as_deref() else { continue; };
        if state.images.hash_file(&image.file)?.is_some_and(|(local, _)| local == hash) { continue; }
        let response = client.get(format!("{endpoint}/v1/assets/{hash}")).bearer_auth(token).send().await?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED { invalidate_access_token(state); }
        anyhow::ensure!(response.status().is_success(), "asset download failed ({})", response.status());
        let bytes = response.bytes().await?;
        state.images.store_synced(&image.file, &image.mime, hash, &bytes)?;
        state.database.lock().register_asset(&image)?;
        state.database.lock().mark_asset_synced(hash)?;
    }
    Ok(())
}

fn collect_asset_hashes(document: &branchly_core::Document) -> Vec<String> {
    let mut hashes = Vec::new();
    fn visit(node: &branchly_core::Node, hashes: &mut Vec<String>) {
        hashes.extend(node.images.iter().filter_map(|image| image.sha256.clone()));
        for child in &node.children { visit(child, hashes); }
    }
    visit(&document.root, &mut hashes);
    hashes.sort(); hashes.dedup(); hashes
}

fn validate_remote(remote: &RemoteDocument) -> anyhow::Result<()> {
    branchly_core::validate_document(&remote.document)?;
    let referenced = collect_asset_hashes(&remote.document);
    let mut declared = remote.asset_hashes.clone(); declared.sort(); declared.dedup();
    anyhow::ensure!(referenced == declared, "remote asset manifest does not match document");
    fn all_hashed(node: &branchly_core::Node) -> bool {
        node.images.iter().all(|image| image.sha256.is_some()) && node.children.iter().all(all_hashed)
    }
    anyhow::ensure!(all_hashed(&remote.document.root), "remote image hash is missing");
    Ok(())
}

fn invalidate_access_token(state: &AppState) {
    state.cloud.lock().access_expires_at = Some(0);
}

fn normalize_endpoint(value: String) -> anyhow::Result<String> {
    let parsed = reqwest::Url::parse(value.trim())?;
    let local_development = parsed.scheme() == "http" && parsed.port().is_some()
        && matches!(parsed.host_str(), Some("127.0.0.1" | "localhost"));
    anyhow::ensure!(parsed.scheme() == "https" || local_development, "cloud endpoint must use HTTPS");
    anyhow::ensure!(parsed.username().is_empty() && parsed.password().is_none(), "cloud endpoint cannot contain credentials");
    anyhow::ensure!(parsed.query().is_none() && parsed.fragment().is_none(), "cloud endpoint cannot contain a query or fragment");
    Ok(parsed.as_str().trim_end_matches('/').to_string())
}
