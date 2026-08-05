use axum::{body::Bytes, extract::{Path, State}, http::{header, HeaderMap, HeaderValue, StatusCode}, response::IntoResponse, Json};
use branchly_core::{validate_document, PushResult, RemoteDocument, SyncEnvelope};
use chrono::{DateTime, Utc};
use object_store::path::Path as ObjectPath;
use sha2::{Digest, Sha256};
use uuid::Uuid;
use crate::{auth::authenticated_user, error::ApiError, AppState};

pub async fn live() -> &'static str { "ok" }
pub async fn ready(State(state): State<AppState>) -> Result<&'static str, ApiError> {
    sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&state.pool).await?; Ok("ready")
}

pub async fn get_document(Path(id): Path<String>, headers: HeaderMap, State(state): State<AppState>) -> Result<Json<RemoteDocument>, ApiError> {
    let user = authenticated_user(&headers, &state).await?;
    let row: Option<(i64, serde_json::Value, serde_json::Value, DateTime<Utc>)> = sqlx::query_as(
        "SELECT revision,body,asset_hashes,updated_at FROM documents WHERE user_id=$1 AND id=$2")
        .bind(user).bind(&id).fetch_optional(&state.pool).await?;
    let Some((revision, body, assets, updated_at)) = row else { return Err(ApiError(StatusCode::NOT_FOUND, "document not found".into())); };
    let document = serde_json::from_value(body).map_err(ApiError::internal)?;
    Ok(Json(RemoteDocument { document_id: id, revision, document,
        asset_hashes: serde_json::from_value(assets).unwrap_or_default(), updated_at: updated_at.to_rfc3339() }))
}

pub async fn put_document(Path(id): Path<String>, headers: HeaderMap, State(state): State<AppState>, Json(input): Json<SyncEnvelope>) -> Result<Json<PushResult>, ApiError> {
    let user = authenticated_user(&headers, &state).await?;
    if input.document_id != id { return Err(ApiError::bad_request("document id mismatch")); }
    validate_document(&input.document).map_err(|error| ApiError::bad_request(error.to_string()))?;
    if !all_document_images_have_hashes(&input.document) {
        return Err(ApiError::bad_request("cloud documents require hashes for every image"));
    }
    let mut referenced_hashes = collect_document_hashes(&input.document);
    let mut declared_hashes = input.asset_hashes.clone();
    referenced_hashes.sort(); referenced_hashes.dedup(); declared_hashes.sort(); declared_hashes.dedup();
    if referenced_hashes != declared_hashes { return Err(ApiError::bad_request("asset manifest does not match document")); }
    for hash in &declared_hashes {
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM assets WHERE user_id=$1 AND sha256=$2)")
            .bind(user).bind(hash).fetch_one(&state.pool).await?;
        if !exists { return Err(ApiError::bad_request("document references an asset that has not been uploaded")); }
    }
    let operation_id = Uuid::parse_str(&input.operation_id).map_err(|_| ApiError::bad_request("invalid operation id"))?;
    Uuid::parse_str(&input.device_id).map_err(|_| ApiError::bad_request("invalid device id"))?;
    let mut transaction = state.pool.begin().await?;
    if let Some(revision) = sqlx::query_scalar::<_, i64>("SELECT resulting_revision FROM applied_operations WHERE user_id=$1 AND operation_id=$2")
        .bind(user).bind(operation_id).fetch_optional(&mut *transaction).await? {
        let updated_at = sqlx::query_scalar::<_, DateTime<Utc>>("SELECT updated_at FROM documents WHERE user_id=$1 AND id=$2")
            .bind(user).bind(&id).fetch_one(&mut *transaction).await?;
        return Ok(Json(PushResult::AlreadyApplied { revision, updated_at: updated_at.to_rfc3339() }));
    }
    let current: Option<(i64, serde_json::Value, serde_json::Value, DateTime<Utc>)> = sqlx::query_as(
        "SELECT revision,body,asset_hashes,updated_at FROM documents WHERE user_id=$1 AND id=$2 FOR UPDATE")
        .bind(user).bind(&id).fetch_optional(&mut *transaction).await?;
    let current_revision = current.as_ref().map(|row| row.0).unwrap_or(0);
    if current_revision != input.base_revision {
        let Some((revision, body, assets, updated_at)) = current else {
            return Err(ApiError::bad_request("base revision does not exist"));
        };
        let remote = RemoteDocument { document_id: id, revision,
            document: serde_json::from_value(body).map_err(ApiError::internal)?,
            asset_hashes: serde_json::from_value(assets).unwrap_or_default(), updated_at: updated_at.to_rfc3339() };
        return Ok(Json(PushResult::Conflict { remote }));
    }
    let revision = current_revision + 1; let now = Utc::now();
    sqlx::query("INSERT INTO documents(user_id,id,revision,body,asset_hashes,updated_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,id) DO UPDATE SET revision=excluded.revision,body=excluded.body,asset_hashes=excluded.asset_hashes,updated_at=excluded.updated_at")
        .bind(user).bind(&id).bind(revision).bind(serde_json::to_value(&input.document).map_err(ApiError::internal)?)
        .bind(serde_json::to_value(&input.asset_hashes).map_err(ApiError::internal)?).bind(now).execute(&mut *transaction).await?;
    sqlx::query("INSERT INTO applied_operations(user_id,operation_id,document_id,resulting_revision) VALUES($1,$2,$3,$4)")
        .bind(user).bind(operation_id).bind(&id).bind(revision).execute(&mut *transaction).await?;
    transaction.commit().await?;
    Ok(Json(PushResult::Applied { revision, updated_at: now.to_rfc3339() }))
}

pub async fn put_asset(Path(sha256): Path<String>, headers: HeaderMap, State(state): State<AppState>, body: Bytes) -> Result<StatusCode, ApiError> {
    let user = authenticated_user(&headers, &state).await?;
    if body.is_empty() || body.len() > 12_000_000 { return Err(ApiError::bad_request("invalid asset size")); }
    let actual = hex::encode(Sha256::digest(&body));
    if actual != sha256 || sha256.len() != 64 { return Err(ApiError::bad_request("asset hash mismatch")); }
    let mime = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("application/octet-stream");
    if !valid_image_signature(mime, &body) { return Err(ApiError::bad_request("image signature does not match content type")); }
    let byte_size = body.len() as i64;
    let key = format!("{user}/{sha256}");
    state.objects.put(&ObjectPath::from(key.clone()), body.into()).await.map_err(ApiError::internal)?;
    sqlx::query("INSERT INTO assets(user_id,sha256,mime,byte_size,object_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,sha256) DO NOTHING")
        .bind(user).bind(&sha256).bind(mime).bind(byte_size).bind(key).execute(&state.pool).await?;
    Ok(StatusCode::CREATED)
}

fn valid_image_signature(mime: &str, bytes: &[u8]) -> bool {
    match mime {
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/png" => bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        "image/avif" => bytes.len() >= 12 && &bytes[4..8] == b"ftyp" && bytes[8..].windows(4).any(|value| value == b"avif"),
        _ => false,
    }
}

fn collect_document_hashes(document: &branchly_core::Document) -> Vec<String> {
    let mut hashes = Vec::new();
    fn visit(node: &branchly_core::Node, hashes: &mut Vec<String>) {
        hashes.extend(node.images.iter().filter_map(|image| image.sha256.clone()));
        for child in &node.children { visit(child, hashes); }
    }
    visit(&document.root, &mut hashes); hashes
}

fn all_document_images_have_hashes(document: &branchly_core::Document) -> bool {
    fn visit(node: &branchly_core::Node) -> bool {
        node.images.iter().all(|image| image.sha256.is_some()) && node.children.iter().all(visit)
    }
    visit(&document.root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_supported_image_signatures() {
        assert!(valid_image_signature("image/png", &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]));
        assert!(valid_image_signature("image/gif", b"GIF89a"));
        assert!(!valid_image_signature("image/png", b"GIF89a"));
        assert!(!valid_image_signature("image/svg+xml", b"<svg/>"));
    }
}

pub async fn get_asset(Path(sha256): Path<String>, headers: HeaderMap, State(state): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    let user = authenticated_user(&headers, &state).await?;
    let row: Option<(String, String)> = sqlx::query_as("SELECT object_key,mime FROM assets WHERE user_id=$1 AND sha256=$2")
        .bind(user).bind(&sha256).fetch_optional(&state.pool).await?;
    let Some((key, mime)) = row else { return Err(ApiError(StatusCode::NOT_FOUND, "asset not found".into())); };
    let bytes = state.objects.get(&ObjectPath::from(key)).await.map_err(ApiError::internal)?.bytes().await.map_err(ApiError::internal)?;
    let mut response_headers = HeaderMap::new();
    response_headers.insert(header::CONTENT_TYPE, HeaderValue::from_str(&mime).map_err(ApiError::internal)?);
    response_headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=31536000, immutable"));
    Ok((response_headers, bytes))
}
