use std::sync::Arc;
use object_store::{aws::AmazonS3Builder, local::LocalFileSystem, ObjectStore};

pub fn from_environment() -> anyhow::Result<Arc<dyn ObjectStore>> {
    if std::env::var("OBJECT_STORE").unwrap_or_else(|_| "local".into()) == "s3" {
        let store = AmazonS3Builder::new()
            .with_bucket_name(std::env::var("AWS_BUCKET")?)
            .with_region(std::env::var("AWS_REGION")?)
            .with_access_key_id(std::env::var("AWS_ACCESS_KEY_ID")?)
            .with_secret_access_key(std::env::var("AWS_SECRET_ACCESS_KEY")?)
            .with_endpoint(std::env::var("AWS_ENDPOINT")?)
            .with_allow_http(false).build()?;
        Ok(Arc::new(store))
    } else {
        let path = std::env::var("OBJECT_STORE_PATH").unwrap_or_else(|_| "./data/objects".into());
        std::fs::create_dir_all(&path)?;
        Ok(Arc::new(LocalFileSystem::new_with_prefix(path)?))
    }
}
