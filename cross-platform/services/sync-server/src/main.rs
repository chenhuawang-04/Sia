mod auth;
mod error;
mod routes;
mod storage;

use std::{collections::HashMap, net::SocketAddr, sync::Arc, time::{Duration, Instant}};
use axum::{extract::DefaultBodyLimit, routing::{get, post}, Router};
use sqlx::postgres::PgPoolOptions;
use tower_http::{catch_panic::CatchPanicLayer, compression::CompressionLayer, request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer}, trace::TraceLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Clone)]
pub struct AppState {
    pool: sqlx::PgPool,
    jwt_secret: Arc<[u8]>,
    objects: Arc<dyn object_store::ObjectStore>,
    login_attempts: Arc<parking_lot::Mutex<HashMap<String, (u8, Instant)>>>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "branchly_sync_server=info,tower_http=info".into()))
        .with(tracing_subscriber::fmt::layer().json()).init();
    let database_url = std::env::var("DATABASE_URL")?;
    let secret = std::env::var("JWT_SECRET")?;
    anyhow::ensure!(secret.len() >= 32, "JWT_SECRET must contain at least 32 bytes");
    let pool = PgPoolOptions::new().max_connections(20).min_connections(2)
        .acquire_timeout(Duration::from_secs(5)).connect(&database_url).await?;
    sqlx::migrate!().run(&pool).await?;
    let state = AppState { pool, jwt_secret: Arc::from(secret.into_bytes()), objects: storage::from_environment()?,
        login_attempts: Arc::new(parking_lot::Mutex::new(HashMap::new())) };
    tokio::spawn(maintenance(state.pool.clone()));
    let app = Router::new()
        .route("/health/live", get(routes::live))
        .route("/health/ready", get(routes::ready))
        .route("/v1/auth/register", post(auth::register))
        .route("/v1/auth/login", post(auth::login))
        .route("/v1/auth/refresh", post(auth::refresh))
        .route("/v1/auth/logout", post(auth::logout))
        .route("/v1/documents/{id}", get(routes::get_document).put(routes::put_document))
        .route("/v1/assets/{sha256}", get(routes::get_asset).put(routes::put_asset))
        .layer(DefaultBodyLimit::max(13_000_000))
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .layer(PropagateRequestIdLayer::x_request_id())
        .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))
        .layer(CatchPanicLayer::new())
        .with_state(state);
    let address: SocketAddr = std::env::var("BRANCHLY_BIND").unwrap_or_else(|_| "0.0.0.0:8080".into()).parse()?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    tracing::info!(%address, "Branchly sync server listening");
    axum::serve(listener, app).with_graceful_shutdown(shutdown()).await?;
    Ok(())
}

async fn maintenance(pool: sqlx::PgPool) {
    let mut interval = tokio::time::interval(Duration::from_secs(60 * 60));
    loop {
        interval.tick().await;
        if let Err(error) = sqlx::query("DELETE FROM refresh_tokens WHERE expires_at<now() OR (revoked_at IS NOT NULL AND revoked_at<now()-interval '7 days')")
            .execute(&pool).await { tracing::warn!(%error, "refresh token cleanup failed"); }
        if let Err(error) = sqlx::query("DELETE FROM applied_operations WHERE applied_at<now()-interval '90 days'")
            .execute(&pool).await { tracing::warn!(%error, "operation cleanup failed"); }
    }
}

async fn shutdown() {
    let ctrl_c = async { tokio::signal::ctrl_c().await.expect("failed to install Ctrl+C handler") };
    #[cfg(unix)]
    let terminate = async { tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal handler").recv().await; };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = terminate => {} }
}
