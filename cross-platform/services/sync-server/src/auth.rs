use argon2::{password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString}, Argon2};
use axum::{extract::State, http::HeaderMap, Json};
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use crate::{error::ApiError, AppState};

const LOGIN_WINDOW: std::time::Duration = std::time::Duration::from_secs(60);
const MAX_LOGIN_ATTEMPTS: u8 = 8;

#[derive(Deserialize)]
pub struct Credentials { email: String, password: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshRequest { refresh_token: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tokens { access_token: String, refresh_token: String, expires_in: i64 }
#[derive(Serialize, Deserialize)]
struct Claims { sub: Uuid, exp: usize, iat: usize, token_version: i32 }

pub async fn register(State(state): State<AppState>, Json(input): Json<Credentials>) -> Result<Json<Tokens>, ApiError> {
    validate_credentials(&input)?;
    let email = input.email.trim().to_lowercase();
    let salt = SaltString::generate(&mut OsRng);
    let hash = Argon2::default().hash_password(input.password.as_bytes(), &salt)
        .map_err(ApiError::internal)?.to_string();
    let user_id = Uuid::new_v4();
    let result = sqlx::query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)")
        .bind(user_id).bind(email).bind(hash).execute(&state.pool).await;
    if let Err(sqlx::Error::Database(error)) = &result {
        if error.is_unique_violation() { return Err(ApiError(axum::http::StatusCode::CONFLICT, "account already exists".into())); }
    }
    result?;
    issue_tokens(&state, user_id, 0).await.map(Json)
}

pub async fn login(State(state): State<AppState>, Json(input): Json<Credentials>) -> Result<Json<Tokens>, ApiError> {
    validate_credentials(&input)?;
    let email = input.email.trim().to_lowercase();
    {
        let mut attempts = state.login_attempts.lock();
        attempts.retain(|_, (_, started)| started.elapsed() < std::time::Duration::from_secs(600));
        if attempts.get(&email).is_some_and(|(count, started)| *count >= MAX_LOGIN_ATTEMPTS && started.elapsed() < LOGIN_WINDOW) {
            return Err(ApiError(axum::http::StatusCode::TOO_MANY_REQUESTS, "too many login attempts".into()));
        }
    }
    let row: Option<(Uuid, String, i32)> = sqlx::query_as("SELECT id,password_hash,token_version FROM users WHERE email=$1")
        .bind(&email).fetch_optional(&state.pool).await?;
    let Some((user_id, password_hash, token_version)) = row else {
        let salt = SaltString::encode_b64(b"branchly-dummy-salt").map_err(ApiError::internal)?;
        let _ = Argon2::default().hash_password(input.password.as_bytes(), &salt);
        record_failure(&state, email); return Err(ApiError::unauthorized());
    };
    let parsed = PasswordHash::new(&password_hash).map_err(ApiError::internal)?;
    if Argon2::default().verify_password(input.password.as_bytes(), &parsed).is_err() {
        record_failure(&state, email); return Err(ApiError::unauthorized());
    }
    state.login_attempts.lock().remove(&email);
    issue_tokens(&state, user_id, token_version).await.map(Json)
}

pub async fn refresh(State(state): State<AppState>, Json(input): Json<RefreshRequest>) -> Result<Json<Tokens>, ApiError> {
    let digest = hex::encode(Sha256::digest(input.refresh_token.as_bytes()));
    let mut transaction = state.pool.begin().await?;
    let user_id: Option<Uuid> = sqlx::query_scalar("UPDATE refresh_tokens SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now() RETURNING user_id")
        .bind(digest).fetch_optional(&mut *transaction).await?;
    let Some(user_id) = user_id else { return Err(ApiError::unauthorized()); };
    let version: i32 = sqlx::query_scalar("SELECT token_version FROM users WHERE id=$1")
        .bind(user_id).fetch_one(&mut *transaction).await?;
    transaction.commit().await?;
    issue_tokens(&state, user_id, version).await.map(Json)
}

pub async fn logout(State(state): State<AppState>, Json(input): Json<RefreshRequest>) -> Result<axum::http::StatusCode, ApiError> {
    let digest = hex::encode(Sha256::digest(input.refresh_token.as_bytes()));
    sqlx::query("UPDATE refresh_tokens SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL")
        .bind(digest).execute(&state.pool).await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

pub async fn authenticated_user(headers: &HeaderMap, state: &AppState) -> Result<Uuid, ApiError> {
    let header = headers.get(axum::http::header::AUTHORIZATION).and_then(|v| v.to_str().ok()).ok_or_else(ApiError::unauthorized)?;
    let token = header.strip_prefix("Bearer ").ok_or_else(ApiError::unauthorized)?;
    let claims = decode::<Claims>(token, &DecodingKey::from_secret(&state.jwt_secret), &Validation::default())
        .map_err(|_| ApiError::unauthorized())?.claims;
    let current_version: Option<i32> = sqlx::query_scalar("SELECT token_version FROM users WHERE id=$1")
        .bind(claims.sub).fetch_optional(&state.pool).await?;
    if current_version != Some(claims.token_version) { return Err(ApiError::unauthorized()); }
    Ok(claims.sub)
}

async fn issue_tokens(state: &AppState, user_id: Uuid, token_version: i32) -> Result<Tokens, ApiError> {
    let now = Utc::now(); let expires = now + Duration::minutes(15);
    let claims = Claims { sub: user_id, iat: now.timestamp() as usize, exp: expires.timestamp() as usize, token_version };
    let access_token = encode(&Header::default(), &claims, &EncodingKey::from_secret(&state.jwt_secret)).map_err(ApiError::internal)?;
    let mut bytes = [0u8; 32]; rand::thread_rng().fill_bytes(&mut bytes);
    let refresh_token = hex::encode(bytes); let digest = hex::encode(Sha256::digest(refresh_token.as_bytes()));
    sqlx::query("INSERT INTO refresh_tokens(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4)")
        .bind(Uuid::new_v4()).bind(user_id).bind(digest).bind(now + Duration::days(30)).execute(&state.pool).await?;
    Ok(Tokens { access_token, refresh_token, expires_in: 900 })
}

fn validate_credentials(input: &Credentials) -> Result<(), ApiError> {
    if !input.email.contains('@') || input.email.len() > 254 { return Err(ApiError::bad_request("invalid email")); }
    if input.password.len() < 10 || input.password.len() > 200 { return Err(ApiError::bad_request("password must contain 10 to 200 characters")); }
    Ok(())
}

fn record_failure(state: &AppState, key: String) {
    let mut attempts = state.login_attempts.lock();
    let entry = attempts.entry(key).or_insert((0, std::time::Instant::now()));
    if entry.1.elapsed() >= LOGIN_WINDOW { *entry = (1, std::time::Instant::now()); }
    else { entry.0 = entry.0.saturating_add(1); }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_cloud_credentials_before_database_work() {
        assert!(validate_credentials(&Credentials { email: "not-an-email".into(), password: "long-enough-password".into() }).is_err());
        assert!(validate_credentials(&Credentials { email: "user@example.com".into(), password: "short".into() }).is_err());
        assert!(validate_credentials(&Credentials { email: "user@example.com".into(), password: "a secure cloud password".into() }).is_ok());
    }
}
