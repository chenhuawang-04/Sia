use std::{fs, path::{Path, PathBuf}};
use argon2::Argon2;
use chacha20poly1305::{aead::{Aead, KeyInit}, XChaCha20Poly1305, XNonce};
use parking_lot::Mutex;
use rand::{rngs::OsRng, RngCore};
use serde::{de::DeserializeOwned, Serialize};
use zeroize::Zeroize;

pub struct CredentialVault {
    file: PathBuf,
    salt_file: PathBuf,
    key: Mutex<Option<[u8; 32]>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct Secret { token: String }

    #[test]
    fn encrypted_vault_round_trip_and_wrong_password_rejection() {
        let directory = tempfile::tempdir().unwrap();
        let vault = CredentialVault::new(directory.path());
        vault.unlock("xrune1123459").unwrap();
        vault.save(&Secret { token: "refresh-secret".into() }).unwrap();
        assert_eq!(vault.load::<Secret>().unwrap().unwrap(), Secret { token: "refresh-secret".into() });
        let bytes = fs::read(directory.path().join("cloud-credentials.vault")).unwrap();
        assert!(!bytes.windows("refresh-secret".len()).any(|window| window == b"refresh-secret"));
        vault.lock(); vault.unlock("definitely-wrong").unwrap();
        assert!(vault.load::<Secret>().is_err());
    }
}

impl CredentialVault {
    pub fn new(data_dir: &Path) -> Self {
        Self { file: data_dir.join("cloud-credentials.vault"), salt_file: data_dir.join("cloud-credentials.salt"), key: Mutex::new(None) }
    }

    pub fn unlock(&self, password: &str) -> anyhow::Result<()> {
        let salt = if self.salt_file.exists() && fs::metadata(&self.salt_file)?.len() == 16 { fs::read(&self.salt_file)? } else {
            if self.salt_file.exists() {
                let corrupt = self.salt_file.with_extension(format!("salt.corrupt-{}", chrono::Utc::now().timestamp()));
                fs::rename(&self.salt_file, corrupt)?;
            }
            let mut value = [0u8; 16]; OsRng.fill_bytes(&mut value);
            let temporary = self.salt_file.with_extension("salt.tmp");
            if temporary.exists() { fs::remove_file(&temporary)?; }
            fs::write(&temporary, value)?; fs::rename(temporary, &self.salt_file)?; value.to_vec()
        };
        anyhow::ensure!(salt.len() == 16, "credential salt is damaged");
        let mut key = [0u8; 32];
        Argon2::default().hash_password_into(password.as_bytes(), &salt, &mut key)
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        *self.key.lock() = Some(key); key.zeroize(); Ok(())
    }

    pub fn lock(&self) {
        let mut guard = self.key.lock();
        if let Some(mut key) = guard.take() { key.zeroize(); }
    }

    pub fn save<T: Serialize>(&self, value: &T) -> anyhow::Result<()> {
        let guard = self.key.lock();
        let key = guard.as_ref().ok_or_else(|| anyhow::anyhow!("credential vault is locked"))?;
        let cipher = XChaCha20Poly1305::new(key.into());
        let mut nonce = [0u8; 24]; OsRng.fill_bytes(&mut nonce);
        let ciphertext = cipher.encrypt(XNonce::from_slice(&nonce), serde_json::to_vec(value)?.as_ref())
            .map_err(|_| anyhow::anyhow!("credential encryption failed"))?;
        let mut output = Vec::with_capacity(nonce.len() + ciphertext.len()); output.extend(nonce); output.extend(ciphertext);
        let temporary = self.file.with_extension("vault.tmp");
        let previous = self.file.with_extension("vault.previous");
        fs::write(&temporary, output)?;
        if previous.exists() { fs::remove_file(&previous)?; }
        if self.file.exists() { fs::rename(&self.file, &previous)?; }
        fs::rename(temporary, &self.file)?; Ok(())
    }

    pub fn load<T: DeserializeOwned>(&self) -> anyhow::Result<Option<T>> {
        let guard = self.key.lock();
        let key = guard.as_ref().ok_or_else(|| anyhow::anyhow!("credential vault is locked"))?;
        let cipher = XChaCha20Poly1305::new(key.into());
        let previous = self.file.with_extension("vault.previous");
        for candidate in [&self.file, &previous] {
            if !candidate.exists() { continue; }
            let input = fs::read(candidate)?;
            if input.len() <= 24 { continue; }
            if let Ok(plaintext) = cipher.decrypt(XNonce::from_slice(&input[..24]), &input[24..]) {
                return Ok(Some(serde_json::from_slice(&plaintext)?));
            }
        }
        if !self.file.exists() && !previous.exists() { Ok(None) }
        else { anyhow::bail!("credential vault authentication failed") }
    }

    pub fn clear(&self) -> anyhow::Result<()> {
        let previous = self.file.with_extension("vault.previous");
        for file in [&self.file, &previous] {
            if file.exists() { fs::remove_file(file)?; }
        }
        Ok(())
    }
}

impl Drop for CredentialVault {
    fn drop(&mut self) {
        if let Some(mut key) = self.key.get_mut().take() { key.zeroize(); }
    }
}
