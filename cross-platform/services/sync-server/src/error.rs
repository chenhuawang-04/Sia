use axum::{http::StatusCode, response::{IntoResponse, Response}, Json};
use serde_json::json;

pub struct ApiError(pub StatusCode, pub String);

impl ApiError {
    pub fn bad_request(message: impl Into<String>) -> Self { Self(StatusCode::BAD_REQUEST, message.into()) }
    pub fn unauthorized() -> Self { Self(StatusCode::UNAUTHORIZED, "authentication required".into()) }
    pub fn internal(error: impl std::fmt::Display) -> Self {
        tracing::error!(error=%error, "request failed"); Self(StatusCode::INTERNAL_SERVER_ERROR, "internal server error".into())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response { (self.0, Json(json!({ "error": self.1 }))).into_response() }
}

impl From<sqlx::Error> for ApiError { fn from(value: sqlx::Error) -> Self { Self::internal(value) } }
