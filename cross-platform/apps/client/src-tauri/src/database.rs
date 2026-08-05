use std::{fs, path::PathBuf, time::{Duration, Instant}};
use branchly_core::{validate_document, Document, ImageMetadata, RemoteDocument, DEFAULT_DOCUMENT_ID};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use uuid::Uuid;
use crate::images::ImageStore;

const INITIAL_DOCUMENT: &str = include_str!("../../../../../data/mindmap.json");

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveReceipt {
    pub queued: bool,
    pub local_revision: i64,
    pub persisted_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveStatus {
    pub pending: bool,
    pub last_persisted_at: Option<String>,
    pub interval_ms: u32,
    pub local_revision: i64,
    pub pending_sync_operations: i64,
}

pub struct Database { connection: Connection, path: PathBuf, last_physical_backup: Option<Instant> }

pub struct SyncJob {
    pub operation_id: String,
    pub document_id: String,
    pub base_revision: i64,
    pub document: Document,
}

pub struct PendingAsset { pub sha256: String, pub file_name: String, pub mime: String }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSummary {
    pub id: String,
    pub remote_revision: i64,
    pub local_title: String,
    pub remote_title: String,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotSummary { pub id: String, pub local_revision: i64, pub title: String, pub created_at: String }

impl Database {
    pub fn open(path: PathBuf) -> anyhow::Result<Self> {
        let connect = |file: &PathBuf| -> anyhow::Result<Connection> {
            let connection = Connection::open(file)?;
            connection.pragma_update(None, "journal_mode", "WAL")?;
            connection.pragma_update(None, "synchronous", "FULL")?;
            connection.pragma_update(None, "foreign_keys", "ON")?;
            connection.busy_timeout(Duration::from_secs(5))?;
            connection.execute_batch(include_str!("../migrations/001_initial.sql"))?;
            let health: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
            anyhow::ensure!(health == "ok", "SQLite quick_check failed: {health}");
            Ok(connection)
        };
        let connection = match connect(&path) {
            Ok(connection) => connection,
            Err(primary_error) => {
                let corrupt = path.with_extension(format!("corrupt-{}", Utc::now().format("%Y%m%d%H%M%S")));
                if path.exists() { fs::rename(&path, &corrupt)?; }
                let backup = path.with_extension("sqlite3.bak");
                let previous = path.with_extension("sqlite3.bak.previous");
                for suffix in ["sqlite3-wal", "sqlite3-shm"] {
                    let sidecar = path.with_extension(suffix); if sidecar.exists() { fs::remove_file(sidecar)?; }
                }
                let mut recovered = None;
                for candidate in [&backup, &previous] {
                    if !candidate.exists() { continue; }
                    fs::copy(candidate, &path)?;
                    if let Ok(connection) = connect(&path) { recovered = Some(connection); break; }
                    if path.exists() { fs::remove_file(&path)?; }
                    for suffix in ["sqlite3-wal", "sqlite3-shm"] {
                        let sidecar = path.with_extension(suffix); if sidecar.exists() { fs::remove_file(sidecar)?; }
                    }
                }
                match recovered {
                    Some(connection) => connection,
                    None => connect(&path).map_err(|recovery_error| anyhow::anyhow!("primary database failed ({primary_error}); recovery failed ({recovery_error})"))?,
                }
            }
        };
        let database = Self { connection, path, last_physical_backup: None };
        database.seed_if_empty()?;
        Ok(database)
    }

    fn seed_if_empty(&self) -> anyhow::Result<()> {
        let exists: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM documents WHERE id = ?1)", [DEFAULT_DOCUMENT_ID], |row| row.get(0))?;
        if exists { return Ok(()); }
        let document: Document = serde_json::from_str(INITIAL_DOCUMENT)?;
        validate_document(&document)?;
        let now = Utc::now().to_rfc3339();
        self.connection.execute(
            "INSERT INTO documents(id, body, local_revision, remote_revision, updated_at, persisted_at) VALUES (?1, ?2, 1, 0, ?3, ?3)",
            params![DEFAULT_DOCUMENT_ID, serde_json::to_string(&document)?, now])?;
        Ok(())
    }

    pub fn backfill_assets(&mut self, images: &ImageStore) -> anyhow::Result<()> {
        let mut document = self.load()?;
        let mut changed = false;
        let mut metadata = Vec::new();
        fn visit(node: &mut branchly_core::Node, store: &ImageStore, changed: &mut bool,
            metadata: &mut Vec<ImageMetadata>) -> anyhow::Result<()> {
            for image in &mut node.images {
                if let Some((hash, size)) = store.hash_file(&image.file)? {
                    if image.sha256.as_deref() != Some(&hash) { image.sha256 = Some(hash); *changed = true; }
                    if image.size != size { image.size = size; *changed = true; }
                    metadata.push(image.clone());
                }
            }
            for child in &mut node.children { visit(child, store, changed, metadata)?; }
            Ok(())
        }
        visit(&mut document.root, images, &mut changed, &mut metadata)?;
        let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for image in metadata {
            if let Some(hash) = image.sha256 {
                transaction.execute("INSERT INTO assets(id,file_name,original_name,mime,byte_size,sha256,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(file_name) DO UPDATE SET sha256=excluded.sha256,byte_size=excluded.byte_size",
                    params![image.id, image.file, image.name, image.mime, image.size as i64, hash,
                        image.created_at.unwrap_or_else(|| Utc::now().to_rfc3339())])?;
            }
        }
        if changed {
            transaction.execute("UPDATE documents SET body=?2 WHERE id=?1",
                params![DEFAULT_DOCUMENT_ID, serde_json::to_string(&document)?])?;
        }
        transaction.commit()?; Ok(())
    }

    pub fn load(&self) -> anyhow::Result<Document> {
        let body: String = self.connection.query_row(
            "SELECT body FROM documents WHERE id = ?1", [DEFAULT_DOCUMENT_ID], |row| row.get(0))?;
        let document = serde_json::from_str(&body)?;
        validate_document(&document)?;
        Ok(document)
    }

    pub fn save(&mut self, mut document: Document) -> anyhow::Result<SaveReceipt> {
        validate_document(&document)?;
        let now = Utc::now().to_rfc3339();
        document.updated_at = Some(now.clone());
        let body = serde_json::to_string(&document)?;
        let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (current_revision, previous_body): (i64, String) = transaction.query_row(
            "SELECT local_revision,body FROM documents WHERE id = ?1", [DEFAULT_DOCUMENT_ID],
            |row| Ok((row.get(0)?, row.get(1)?)))?;
        let next_revision = current_revision + 1;
        transaction.execute(
            "UPDATE documents SET body=?2, local_revision=?3, updated_at=?4, persisted_at=?4 WHERE id=?1",
            params![DEFAULT_DOCUMENT_ID, body, next_revision, now])?;
        transaction.execute(
            "INSERT INTO snapshots(id, document_id, local_revision, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![Uuid::new_v4().to_string(), DEFAULT_DOCUMENT_ID, current_revision, previous_body, now])?;
        transaction.execute("DELETE FROM outbox WHERE document_id=?1 AND kind='put-document'", [DEFAULT_DOCUMENT_ID])?;
        transaction.execute(
            "INSERT INTO outbox(operation_id, document_id, kind, local_revision, payload, created_at, next_attempt_at) VALUES (?1, ?2, 'put-document', ?3, ?4, ?5, ?5)",
            params![Uuid::new_v4().to_string(), DEFAULT_DOCUMENT_ID, next_revision, body, now])?;
        transaction.execute(
            "DELETE FROM snapshots WHERE id IN (SELECT id FROM snapshots WHERE document_id=?1 ORDER BY local_revision DESC LIMIT -1 OFFSET 30)",
            [DEFAULT_DOCUMENT_ID])?;
        transaction.commit()?;
        self.connection.execute_batch("PRAGMA wal_checkpoint(PASSIVE)")?;
        self.backup_if_due()?;
        Ok(SaveReceipt { queued: true, local_revision: next_revision, persisted_at: now })
    }

    fn backup_if_due(&mut self) -> anyhow::Result<()> {
        if self.last_physical_backup.is_some_and(|last| last.elapsed() < Duration::from_secs(5)) { return Ok(()); }
        self.connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
        let backup = self.path.with_extension("sqlite3.bak");
        let previous = self.path.with_extension("sqlite3.bak.previous");
        let temporary = self.path.with_extension("sqlite3.bak.tmp");
        fs::copy(&self.path, &temporary)?;
        if previous.exists() { fs::remove_file(&previous)?; }
        if backup.exists() { fs::rename(&backup, &previous)?; }
        fs::rename(temporary, backup)?;
        self.last_physical_backup = Some(Instant::now()); Ok(())
    }

    pub fn status(&self) -> anyhow::Result<SaveStatus> {
        let (revision, persisted_at): (i64, Option<String>) = self.connection.query_row(
            "SELECT local_revision, persisted_at FROM documents WHERE id=?1", [DEFAULT_DOCUMENT_ID],
            |row| Ok((row.get(0)?, row.get(1)?)))?;
        let pending: i64 = self.connection.query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))?;
        Ok(SaveStatus { pending: false, last_persisted_at: persisted_at, interval_ms: 5000,
            local_revision: revision, pending_sync_operations: pending })
    }

    pub fn health(&self) -> anyhow::Result<StorageHealth> {
        let quick_check: String = self.connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
        let schema_version: i64 = self.connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        let last_snapshot: Option<String> = self.connection.query_row(
            "SELECT created_at FROM snapshots ORDER BY created_at DESC LIMIT 1", [], |row| row.get(0)).optional()?;
        Ok(StorageHealth { ok: quick_check == "ok", quick_check, schema_version,
            database_path: self.path.to_string_lossy().into_owned(), last_snapshot })
    }

    pub fn device_id(&self) -> anyhow::Result<String> {
        if let Some(value) = self.connection.query_row(
            "SELECT value FROM settings WHERE key='device_id'", [], |row| row.get(0)).optional()? { return Ok(value); }
        let value = Uuid::new_v4().to_string();
        self.connection.execute("INSERT INTO settings(key,value) VALUES('device_id',?1)", [&value])?;
        Ok(value)
    }

    pub fn next_sync_job(&self) -> anyhow::Result<Option<SyncJob>> {
        let row: Option<(String, String, i64, String)> = self.connection.query_row(
            "SELECT o.operation_id,o.document_id,d.remote_revision,o.payload FROM outbox o JOIN documents d ON d.id=o.document_id WHERE o.kind='put-document' AND o.next_attempt_at<=?1 ORDER BY o.sequence LIMIT 1",
            [Utc::now().to_rfc3339()], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).optional()?;
        row.map(|(operation_id, document_id, base_revision, payload)| Ok(SyncJob {
            operation_id, document_id, base_revision, document: serde_json::from_str(&payload)?
        })).transpose()
    }

    pub fn queue_current_for_sync(&self) -> anyhow::Result<()> {
        let (local_revision, body): (i64, String) = self.connection.query_row(
            "SELECT local_revision,body FROM documents WHERE id=?1", [DEFAULT_DOCUMENT_ID], |row| Ok((row.get(0)?, row.get(1)?)))?;
        let exists: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM outbox WHERE document_id=?1 AND kind='put-document')", [DEFAULT_DOCUMENT_ID], |row| row.get(0))?;
        if !exists {
            let now = Utc::now().to_rfc3339();
            self.connection.execute("INSERT INTO outbox(operation_id,document_id,kind,local_revision,payload,created_at,next_attempt_at) VALUES(?1,?2,'put-document',?3,?4,?5,?5)",
                params![Uuid::new_v4().to_string(), DEFAULT_DOCUMENT_ID, local_revision, body, now])?;
        }
        Ok(())
    }

    pub fn pending_assets(&self) -> anyhow::Result<Vec<PendingAsset>> {
        let mut statement = self.connection.prepare("SELECT sha256,file_name,mime FROM assets WHERE deleted_at IS NULL AND remote_state='pending' ORDER BY created_at LIMIT 20")?;
        let rows = statement.query_map([], |row| Ok(PendingAsset { sha256: row.get(0)?, file_name: row.get(1)?, mime: row.get(2)? }))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn mark_asset_synced(&self, hash: &str) -> anyhow::Result<()> {
        self.connection.execute("UPDATE assets SET remote_state='synced' WHERE sha256=?1", [hash])?; Ok(())
    }

    pub fn register_asset(&self, image: &ImageMetadata) -> anyhow::Result<()> {
        let hash = image.sha256.as_ref().ok_or_else(|| anyhow::anyhow!("image hash missing"))?;
        self.connection.execute("INSERT INTO assets(id,file_name,original_name,mime,byte_size,sha256,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(file_name) DO UPDATE SET original_name=excluded.original_name,mime=excluded.mime,byte_size=excluded.byte_size,sha256=excluded.sha256,deleted_at=NULL,remote_state='pending'",
            params![image.id, image.file, image.name, image.mime, image.size as i64, hash,
                image.created_at.clone().unwrap_or_else(|| Utc::now().to_rfc3339())])?; Ok(())
    }

    pub fn mark_asset_deleted(&self, file: &str) -> anyhow::Result<()> {
        self.connection.execute("UPDATE assets SET deleted_at=?2,remote_state='pending-delete' WHERE file_name=?1",
            params![file, Utc::now().to_rfc3339()])?; Ok(())
    }

    pub fn mark_assets_restored<'a>(&self, files: impl IntoIterator<Item = &'a String>) -> anyhow::Result<()> {
        for file in files {
            self.connection.execute("UPDATE assets SET deleted_at=NULL,remote_state='pending' WHERE file_name=?1 AND deleted_at IS NOT NULL", [file])?;
        }
        Ok(())
    }

    pub fn complete_sync(&mut self, operation_id: &str, remote_revision: i64) -> anyhow::Result<()> {
        let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute("UPDATE documents SET remote_revision=?2 WHERE id=?1", params![DEFAULT_DOCUMENT_ID, remote_revision])?;
        transaction.execute("DELETE FROM outbox WHERE operation_id=?1", [operation_id])?;
        transaction.commit()?; Ok(())
    }

    pub fn postpone_sync(&self, operation_id: &str, error: &str) -> anyhow::Result<()> {
        let attempts: i64 = self.connection.query_row("SELECT attempts FROM outbox WHERE operation_id=?1", [operation_id], |row| row.get(0))?;
        let delay = retry_delay(attempts);
        let next = (Utc::now() + chrono::Duration::seconds(delay)).to_rfc3339();
        self.connection.execute("UPDATE outbox SET attempts=attempts+1,next_attempt_at=?2,last_error=?3 WHERE operation_id=?1",
            params![operation_id, next, error.chars().take(500).collect::<String>()])?;
        Ok(())
    }

    pub fn accept_remote_if_clean(&mut self, remote: &RemoteDocument) -> anyhow::Result<bool> {
        let pending: i64 = self.connection.query_row("SELECT COUNT(*) FROM outbox WHERE document_id=?1", [DEFAULT_DOCUMENT_ID], |row| row.get(0))?;
        if pending > 0 { return Ok(false); }
        validate_document(&remote.document)?;
        let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (local_revision, local_body, current_remote): (i64, String, i64) = transaction.query_row(
            "SELECT local_revision,body,remote_revision FROM documents WHERE id=?1", [DEFAULT_DOCUMENT_ID],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        if remote.revision <= current_remote { return Ok(false); }
        let now = Utc::now().to_rfc3339();
        transaction.execute("INSERT INTO snapshots(id,document_id,local_revision,body,created_at) VALUES(?1,?2,?3,?4,?5)",
            params![Uuid::new_v4().to_string(), DEFAULT_DOCUMENT_ID, local_revision, local_body, now])?;
        transaction.execute("UPDATE documents SET body=?2,local_revision=?3,remote_revision=?4,updated_at=?5,persisted_at=?5 WHERE id=?1",
            params![DEFAULT_DOCUMENT_ID, serde_json::to_string(&remote.document)?, local_revision + 1, remote.revision, now])?;
        transaction.commit()?; self.backup_if_due()?; Ok(true)
    }

    pub fn preserve_conflict_and_rebase(&mut self, operation_id: &str, remote: &RemoteDocument) -> anyhow::Result<()> {
        validate_document(&remote.document)?;
        let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (local_revision, local_body): (i64, String) = transaction.query_row(
            "SELECT local_revision,body FROM documents WHERE id=?1", [DEFAULT_DOCUMENT_ID], |row| Ok((row.get(0)?, row.get(1)?)))?;
        let now = Utc::now().to_rfc3339();
        transaction.execute("INSERT INTO conflicts(id,document_id,remote_revision,local_body,remote_body,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
            params![Uuid::new_v4().to_string(), DEFAULT_DOCUMENT_ID, remote.revision, local_body,
                serde_json::to_string(&remote.document)?, now])?;
        transaction.execute("UPDATE documents SET remote_revision=?2 WHERE id=?1", params![DEFAULT_DOCUMENT_ID, remote.revision])?;
        transaction.execute("DELETE FROM outbox WHERE operation_id=?1", [operation_id])?;
        transaction.execute("INSERT INTO outbox(operation_id,document_id,kind,local_revision,payload,created_at,next_attempt_at) VALUES(?1,?2,'put-document',?3,?4,?5,?5)",
            params![Uuid::new_v4().to_string(), DEFAULT_DOCUMENT_ID, local_revision, local_body, now])?;
        transaction.commit()?; Ok(())
    }

    pub fn unresolved_conflicts(&self) -> anyhow::Result<i64> {
        Ok(self.connection.query_row("SELECT COUNT(*) FROM conflicts WHERE resolved_at IS NULL", [], |row| row.get(0))?)
    }

    pub fn conflicts(&self) -> anyhow::Result<Vec<ConflictSummary>> {
        let mut statement = self.connection.prepare("SELECT id,remote_revision,local_body,remote_body,created_at FROM conflicts WHERE resolved_at IS NULL ORDER BY created_at DESC")?;
        let rows = statement.query_map([], |row| {
            let local: String = row.get(2)?; let remote: String = row.get(3)?;
            let local_title = serde_json::from_str::<Document>(&local).map(|value| value.title).unwrap_or_else(|_| "本机版本".into());
            let remote_title = serde_json::from_str::<Document>(&remote).map(|value| value.title).unwrap_or_else(|_| "云端版本".into());
            Ok(ConflictSummary { id: row.get(0)?, remote_revision: row.get(1)?, local_title, remote_title, created_at: row.get(4)? })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn resolve_conflict(&mut self, id: &str, use_remote: bool) -> anyhow::Result<bool> {
        let row: Option<(i64, String)> = self.connection.query_row(
            "SELECT remote_revision,remote_body FROM conflicts WHERE id=?1 AND resolved_at IS NULL", [id],
            |row| Ok((row.get(0)?, row.get(1)?))).optional()?;
        let Some((remote_revision, remote_body)) = row else { anyhow::bail!("conflict not found"); };
        let now = Utc::now().to_rfc3339();
        let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if use_remote {
            let remote: Document = serde_json::from_str(&remote_body)?; validate_document(&remote)?;
            let (local_revision, current): (i64, String) = transaction.query_row(
                "SELECT local_revision,body FROM documents WHERE id=?1", [DEFAULT_DOCUMENT_ID], |row| Ok((row.get(0)?, row.get(1)?)))?;
            transaction.execute("INSERT INTO snapshots(id,document_id,local_revision,body,created_at) VALUES(?1,?2,?3,?4,?5)",
                params![Uuid::new_v4().to_string(), DEFAULT_DOCUMENT_ID, local_revision, current, now])?;
            transaction.execute("UPDATE documents SET body=?2,local_revision=?3,remote_revision=?4,updated_at=?5,persisted_at=?5 WHERE id=?1",
                params![DEFAULT_DOCUMENT_ID, remote_body, local_revision + 1, remote_revision, now])?;
            transaction.execute("DELETE FROM outbox WHERE document_id=?1 AND kind='put-document'", [DEFAULT_DOCUMENT_ID])?;
        }
        transaction.execute("UPDATE conflicts SET resolved_at=?2 WHERE id=?1", params![id, now])?;
        transaction.commit()?;
        if use_remote { self.backup_if_due()?; }
        Ok(use_remote)
    }

    pub fn snapshots(&self) -> anyhow::Result<Vec<SnapshotSummary>> {
        let mut statement = self.connection.prepare("SELECT id,local_revision,body,created_at FROM snapshots WHERE document_id=?1 ORDER BY local_revision DESC LIMIT 30")?;
        let rows = statement.query_map([DEFAULT_DOCUMENT_ID], |row| {
            let body: String = row.get(2)?;
            let title = serde_json::from_str::<Document>(&body).map(|value| value.title).unwrap_or_else(|_| "恢复点".into());
            Ok(SnapshotSummary { id: row.get(0)?, local_revision: row.get(1)?, title, created_at: row.get(3)? })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn restore_snapshot(&mut self, id: &str) -> anyhow::Result<()> {
        let body: String = self.connection.query_row("SELECT body FROM snapshots WHERE id=?1 AND document_id=?2",
            params![id, DEFAULT_DOCUMENT_ID], |row| row.get(0))?;
        let document: Document = serde_json::from_str(&body)?; validate_document(&document)?;
        let now = Utc::now().to_rfc3339();
        let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (revision, current): (i64, String) = transaction.query_row("SELECT local_revision,body FROM documents WHERE id=?1",
            [DEFAULT_DOCUMENT_ID], |row| Ok((row.get(0)?, row.get(1)?)))?;
        transaction.execute("INSERT INTO snapshots(id,document_id,local_revision,body,created_at) VALUES(?1,?2,?3,?4,?5)",
            params![Uuid::new_v4().to_string(), DEFAULT_DOCUMENT_ID, revision, current, now])?;
        transaction.execute("UPDATE documents SET body=?2,local_revision=?3,updated_at=?4,persisted_at=?4 WHERE id=?1",
            params![DEFAULT_DOCUMENT_ID, body, revision + 1, now])?;
        transaction.execute("DELETE FROM outbox WHERE document_id=?1 AND kind='put-document'", [DEFAULT_DOCUMENT_ID])?;
        transaction.execute("INSERT INTO outbox(operation_id,document_id,kind,local_revision,payload,created_at,next_attempt_at) VALUES(?1,?2,'put-document',?3,?4,?5,?5)",
            params![Uuid::new_v4().to_string(), DEFAULT_DOCUMENT_ID, revision + 1, body, now])?;
        transaction.commit()?; self.backup_if_due()?; Ok(())
    }
}

fn retry_delay(attempts: i64) -> i64 { 2_i64.pow(((attempts + 1) as u32).min(8)).min(300) }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageHealth {
    pub ok: bool,
    pub quick_check: String,
    pub schema_version: i64,
    pub database_path: String,
    pub last_snapshot: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_transactionally_and_restores_a_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let mut database = Database::open(directory.path().join("branchly.sqlite3")).unwrap();
        let original = database.load().unwrap();
        let mut changed = original.clone(); changed.title = "修改后的标题".into();
        database.save(changed).unwrap();
        assert_eq!(database.load().unwrap().title, "修改后的标题");
        let snapshots = database.snapshots().unwrap();
        assert!(!snapshots.is_empty());
        database.restore_snapshot(&snapshots[0].id).unwrap();
        assert_eq!(database.load().unwrap().title, original.title);
        assert!(database.health().unwrap().ok);
    }

    #[test]
    fn recovers_a_corrupt_primary_database_from_physical_backup() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("branchly.sqlite3");
        {
            let mut database = Database::open(path.clone()).unwrap();
            let mut document = database.load().unwrap(); document.title = "备份中的标题".into();
            database.save(document).unwrap();
        }
        assert!(path.with_extension("sqlite3.bak").exists());
        fs::write(&path, b"intentionally corrupt sqlite data").unwrap();
        let recovered = Database::open(path).unwrap();
        assert_eq!(recovered.load().unwrap().title, "备份中的标题");
        assert!(recovered.health().unwrap().ok);
    }

    #[test]
    fn preserves_both_versions_on_sync_conflict() {
        let directory = tempfile::tempdir().unwrap();
        let mut database = Database::open(directory.path().join("branchly.sqlite3")).unwrap();
        let mut local = database.load().unwrap(); local.title = "本机编辑".into(); database.save(local).unwrap();
        let operation = database.next_sync_job().unwrap().unwrap();
        let mut remote_document = database.load().unwrap(); remote_document.title = "云端编辑".into();
        let remote = RemoteDocument { document_id: DEFAULT_DOCUMENT_ID.into(), revision: 9, document: remote_document,
            asset_hashes: vec![], updated_at: Utc::now().to_rfc3339() };
        database.preserve_conflict_and_rebase(&operation.operation_id, &remote).unwrap();
        let conflicts = database.conflicts().unwrap(); assert_eq!(conflicts.len(), 1);
        assert_eq!(database.next_sync_job().unwrap().unwrap().base_revision, 9);
        database.resolve_conflict(&conflicts[0].id, true).unwrap();
        assert_eq!(database.load().unwrap().title, "云端编辑");
    }

    #[test]
    fn retry_delay_is_bounded_exponential_backoff() {
        assert_eq!(retry_delay(0), 2); assert_eq!(retry_delay(1), 4);
        assert_eq!(retry_delay(8), 256); assert_eq!(retry_delay(100), 256);
    }
}
