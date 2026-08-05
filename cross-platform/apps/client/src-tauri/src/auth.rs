use std::time::{Duration, Instant};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

const PASSWORD: &str = "xrune1123459";
const MAX_ATTEMPTS: u8 = 8;

pub struct AuthSession {
    unlocked: bool,
    failed_attempts: u8,
    retry_after: Option<Instant>,
}

impl Default for AuthSession {
    fn default() -> Self {
        Self { unlocked: false, failed_attempts: 0, retry_after: None }
    }
}

impl AuthSession {
    pub fn is_unlocked(&self) -> bool { self.unlocked }

    pub fn unlock(&mut self, submitted: &str) -> Result<(), LoginError> {
        if let Some(retry_after) = self.retry_after {
            if retry_after > Instant::now() {
                return Err(LoginError::RateLimited(retry_after.duration_since(Instant::now()).as_secs() + 1));
            }
            self.failed_attempts = 0;
            self.retry_after = None;
        }
        let expected = Sha256::digest(PASSWORD.as_bytes());
        let supplied = Sha256::digest(submitted.as_bytes());
        if bool::from(expected.ct_eq(&supplied)) {
            self.unlocked = true;
            self.failed_attempts = 0;
            return Ok(());
        }
        self.failed_attempts += 1;
        if self.failed_attempts >= MAX_ATTEMPTS {
            self.retry_after = Some(Instant::now() + Duration::from_secs(60));
            return Err(LoginError::RateLimited(60));
        }
        Err(LoginError::Invalid(MAX_ATTEMPTS - self.failed_attempts))
    }

    pub fn lock(&mut self) { self.unlocked = false; }
}

pub enum LoginError { Invalid(u8), RateLimited(u64) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_expected_password_and_locks_again() {
        let mut session = AuthSession::default();
        assert!(session.unlock("xrune1123459").is_ok());
        assert!(session.is_unlocked());
        session.lock(); assert!(!session.is_unlocked());
    }

    #[test]
    fn rate_limits_repeated_failures() {
        let mut session = AuthSession::default();
        for _ in 0..7 { assert!(matches!(session.unlock("wrong"), Err(LoginError::Invalid(_)))); }
        assert!(matches!(session.unlock("wrong"), Err(LoginError::RateLimited(_))));
        assert!(matches!(session.unlock("xrune1123459"), Err(LoginError::RateLimited(_))));
    }
}
