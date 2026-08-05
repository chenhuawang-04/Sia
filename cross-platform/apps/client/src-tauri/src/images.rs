use std::{collections::HashMap, fs, path::{Path, PathBuf}};
use branchly_core::ImageMetadata;
use chrono::Utc;
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Clone)]
pub struct ImageStore { uploads: PathBuf, trash: PathBuf }

impl ImageStore {
    pub fn open(data_dir: &Path, seed_dir: Option<&Path>) -> anyhow::Result<Self> {
        let uploads = data_dir.join("uploads");
        let trash = data_dir.join("image-trash");
        fs::create_dir_all(&uploads)?; fs::create_dir_all(&trash)?;
        let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(7 * 24 * 60 * 60);
        for entry in fs::read_dir(&trash)? {
            let entry = entry?;
            if entry.file_type()?.is_file() && entry.metadata()?.modified().is_ok_and(|modified| modified < cutoff) {
                fs::remove_file(entry.path())?;
            }
        }
        if let Some(seed_dir) = seed_dir {
            if seed_dir.is_dir() {
                for entry in fs::read_dir(seed_dir)? {
                    let entry = entry?;
                    if entry.file_type()?.is_file() {
                        let destination = uploads.join(entry.file_name());
                        if !destination.exists() { fs::copy(entry.path(), destination)?; }
                    }
                }
            }
        }
        Ok(Self { uploads, trash })
    }

    pub fn store(&self, original_name: &str, mime: &str, bytes: &[u8]) -> anyhow::Result<ImageMetadata> {
        if bytes.is_empty() || bytes.len() > 12_000_000 { anyhow::bail!("image size is invalid"); }
        let extension = extension_for(mime).ok_or_else(|| anyhow::anyhow!("unsupported image format"))?;
        if !valid_signature(mime, bytes) { anyhow::bail!("image signature does not match MIME type"); }
        let file = format!("{}.{}", Uuid::new_v4(), extension);
        let temporary = self.uploads.join(format!(".{file}.tmp"));
        let destination = self.uploads.join(&file);
        fs::write(&temporary, bytes)?;
        fs::rename(&temporary, &destination)?;
        let sha256 = hex::encode(Sha256::digest(bytes));
        Ok(ImageMetadata { id: Uuid::new_v4().to_string(), file: file.clone(),
            name: original_name.chars().take(180).collect(), mime: mime.into(), size: bytes.len() as u64,
            sha256: Some(sha256), url: format!("/uploads/{file}"), created_at: Some(Utc::now().to_rfc3339()) })
    }

    pub fn delete(&self, file: &str) -> anyhow::Result<()> {
        validate_file_name(file)?;
        let source = self.uploads.join(file);
        if source.exists() { fs::rename(source, self.trash.join(file))?; }
        Ok(())
    }

    pub fn resolve_many(&self, files: &[String]) -> anyhow::Result<HashMap<String, String>> {
        let mut result = HashMap::new();
        for file in files {
            validate_file_name(file)?;
            let live = self.uploads.join(file);
            if !live.exists() {
                let deleted = self.trash.join(file);
                if deleted.exists() { fs::rename(&deleted, &live)?; }
            }
            if live.exists() { result.insert(file.clone(), live.to_string_lossy().into_owned()); }
        }
        Ok(result)
    }

    pub fn hash_file(&self, file: &str) -> anyhow::Result<Option<(String, u64)>> {
        validate_file_name(file)?;
        let path = self.uploads.join(file);
        if !path.exists() { return Ok(None); }
        let bytes = fs::read(path)?;
        Ok(Some((hex::encode(Sha256::digest(&bytes)), bytes.len() as u64)))
    }

    pub fn read(&self, file: &str) -> anyhow::Result<Vec<u8>> {
        validate_file_name(file)?; Ok(fs::read(self.uploads.join(file))?)
    }

    pub fn store_synced(&self, file: &str, mime: &str, expected_hash: &str, bytes: &[u8]) -> anyhow::Result<()> {
        validate_file_name(file)?;
        if !valid_signature(mime, bytes) { anyhow::bail!("downloaded image signature is invalid"); }
        let actual = hex::encode(Sha256::digest(bytes));
        if actual != expected_hash { anyhow::bail!("downloaded image hash mismatch"); }
        let temporary = self.uploads.join(format!(".{file}.sync-tmp"));
        fs::write(&temporary, bytes)?;
        let destination = self.uploads.join(file);
        if destination.exists() { fs::rename(&destination, self.trash.join(format!("replaced-{}-{file}", Utc::now().timestamp())))?; }
        fs::rename(temporary, destination)?;
        Ok(())
    }
}

fn extension_for(mime: &str) -> Option<&'static str> {
    match mime { "image/jpeg" => Some("jpg"), "image/png" => Some("png"), "image/webp" => Some("webp"),
        "image/gif" => Some("gif"), "image/avif" => Some("avif"), _ => None }
}

fn valid_signature(mime: &str, data: &[u8]) -> bool {
    match mime {
        "image/jpeg" => data.starts_with(&[0xff, 0xd8, 0xff]),
        "image/png" => data.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]),
        "image/gif" => data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a"),
        "image/webp" => data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP",
        "image/avif" => data.len() >= 12 && &data[4..8] == b"ftyp" && data[8..].windows(4).any(|v| v == b"avif"),
        _ => false,
    }
}

fn validate_file_name(file: &str) -> anyhow::Result<()> {
    if file.is_empty() || file.starts_with('.') || file.contains('/') || file.contains('\\') {
        anyhow::bail!("invalid image file name");
    }
    Ok(())
}

#[allow(dead_code)]
fn digest(data: &[u8]) -> String { hex::encode(Sha256::digest(data)) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_mime_spoofing() {
        let directory = tempfile::tempdir().unwrap();
        let store = ImageStore::open(directory.path(), None).unwrap();
        assert!(store.store("fake.png", "image/png", b"not a png").is_err());
    }

    #[test]
    fn stores_and_resolves_a_valid_png_atomically() {
        let directory = tempfile::tempdir().unwrap();
        let store = ImageStore::open(directory.path(), None).unwrap();
        let png = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
        let image = store.store("tiny.png", "image/png", &png).unwrap();
        assert_eq!(image.size, png.len() as u64);
        assert_eq!(image.sha256.as_ref().unwrap().len(), 64);
        assert!(store.resolve_many(&[image.file]).unwrap().len() == 1);
    }
}
