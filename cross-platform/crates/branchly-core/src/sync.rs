use serde::{Deserialize, Serialize};
use crate::Document;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncEnvelope {
    pub operation_id: String,
    pub document_id: String,
    pub device_id: String,
    pub base_revision: i64,
    pub document: Document,
    #[serde(default)]
    pub asset_hashes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDocument {
    pub document_id: String,
    pub revision: i64,
    pub document: Document,
    #[serde(default)]
    pub asset_hashes: Vec<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum PushResult {
    Applied { revision: i64, updated_at: String },
    AlreadyApplied { revision: i64, updated_at: String },
    Conflict { remote: RemoteDocument },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conflict_wire_format_is_explicitly_tagged() {
        let value = serde_json::to_value(PushResult::Applied { revision: 7, updated_at: "2026-08-05T00:00:00Z".into() }).unwrap();
        assert_eq!(value["status"], "applied");
        assert_eq!(value["revision"], 7);
    }
}
