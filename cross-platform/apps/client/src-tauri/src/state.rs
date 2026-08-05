use std::{path::PathBuf, sync::Arc};
use parking_lot::Mutex;
use crate::{auth::AuthSession, credentials::CredentialVault, database::Database, images::ImageStore, sync::CloudSession};

pub struct AppState {
    pub auth: Mutex<AuthSession>,
    pub database: Arc<Mutex<Database>>,
    pub images: ImageStore,
    pub cloud: Mutex<CloudSession>,
    pub vault: CredentialVault,
    pub http: reqwest::Client,
}

impl AppState {
    pub fn open(data_dir: PathBuf, resource_dir: PathBuf) -> anyhow::Result<Self> {
        let images = ImageStore::open(&data_dir, Some(&resource_dir.join("seed-uploads")))?;
        let mut database = Database::open(data_dir.join("branchly.sqlite3"))?;
        database.backfill_assets(&images)?;
        let vault = CredentialVault::new(&data_dir);
        let http = reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(30)).pool_max_idle_per_host(2).build()?;
        Ok(Self { auth: Mutex::new(AuthSession::default()), database: Arc::new(Mutex::new(database)), images,
            cloud: Mutex::new(CloudSession::default()), vault, http })
    }
}
