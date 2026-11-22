use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use crate::{commands::NativeError, origin::CanonicalOrigin};

#[cfg(target_vendor = "apple")]
const SERVICE: &str = "run.hundredfold.shell.gateway";

#[derive(Clone, Deserialize, Serialize)]
pub struct GatewayCredential {
    pub cookie_header: String,
    pub device_id: String,
}

pub trait CredentialStore: Send + Sync {
    fn get(&self, origin: &CanonicalOrigin) -> Result<Option<GatewayCredential>, NativeError>;
    fn put(
        &self,
        origin: &CanonicalOrigin,
        credential: &GatewayCredential,
    ) -> Result<(), NativeError>;
    fn delete(&self, origin: &CanonicalOrigin) -> Result<bool, NativeError>;
}

pub type SharedCredentialStore = Arc<dyn CredentialStore>;

#[cfg(target_vendor = "apple")]
pub struct OsCredentialStore;

fn account(origin: &CanonicalOrigin) -> String {
    format!("{:x}", Sha256::digest(origin.as_str().as_bytes()))
}

#[cfg(target_vendor = "apple")]
fn entry(origin: &CanonicalOrigin) -> Result<keyring::Entry, NativeError> {
    keyring::Entry::new(SERVICE, &account(origin)).map_err(|_| NativeError::credential_store())
}

#[cfg(target_vendor = "apple")]
impl CredentialStore for OsCredentialStore {
    fn get(&self, origin: &CanonicalOrigin) -> Result<Option<GatewayCredential>, NativeError> {
        match entry(origin)?.get_password() {
            Ok(secret) => serde_json::from_str(&secret)
                .map(Some)
                .map_err(|_| NativeError::credential_store()),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(NativeError::credential_store()),
        }
    }

    fn put(
        &self,
        origin: &CanonicalOrigin,
        credential: &GatewayCredential,
    ) -> Result<(), NativeError> {
        let secret =
            serde_json::to_string(credential).map_err(|_| NativeError::credential_store())?;
        entry(origin)?
            .set_password(&secret)
            .map_err(|_| NativeError::credential_store())
    }

    fn delete(&self, origin: &CanonicalOrigin) -> Result<bool, NativeError> {
        match entry(origin)?.delete_credential() {
            Ok(()) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(_) => Err(NativeError::credential_store()),
        }
    }
}

/// Credentials held in memory for the life of the process.
///
/// Used where there is no OS-backed store: the keyring build enables the Apple
/// backend only, so on Android its default is a mock whose entries do not
/// persist, and a pairing would be unusable the moment it was made. This store
/// is **not** secure storage and is not persisted: the user pairs again after
/// the app process ends.
#[derive(Default)]
pub struct SessionCredentialStore(Mutex<HashMap<String, GatewayCredential>>);

impl CredentialStore for SessionCredentialStore {
    fn get(&self, origin: &CanonicalOrigin) -> Result<Option<GatewayCredential>, NativeError> {
        Ok(self
            .0
            .lock()
            .map_err(|_| NativeError::credential_store())?
            .get(&account(origin))
            .cloned())
    }

    fn put(
        &self,
        origin: &CanonicalOrigin,
        credential: &GatewayCredential,
    ) -> Result<(), NativeError> {
        self.0
            .lock()
            .map_err(|_| NativeError::credential_store())?
            .insert(account(origin), credential.clone());
        Ok(())
    }

    fn delete(&self, origin: &CanonicalOrigin) -> Result<bool, NativeError> {
        Ok(self
            .0
            .lock()
            .map_err(|_| NativeError::credential_store())?
            .remove(&account(origin))
            .is_some())
    }
}

/// The credential store for this platform: Keychain on Apple platforms, the
/// process-lifetime store elsewhere.
pub fn platform_store() -> SharedCredentialStore {
    #[cfg(target_vendor = "apple")]
    {
        Arc::new(OsCredentialStore)
    }
    #[cfg(not(target_vendor = "apple"))]
    {
        Arc::new(SessionCredentialStore::default())
    }
}

#[cfg(test)]
pub mod test_store {
    pub type MemoryCredentialStore = super::SessionCredentialStore;
}

#[cfg(test)]
mod tests {
    use super::{account, test_store::MemoryCredentialStore, CredentialStore, GatewayCredential};
    use crate::origin::CanonicalOrigin;

    #[test]
    fn the_keyring_account_is_derived_from_the_exact_origin_and_port() {
        let a = CanonicalOrigin::parse("http://127.0.0.1:7779").unwrap();
        let b = CanonicalOrigin::parse("http://127.0.0.1:7780").unwrap();
        let https = CanonicalOrigin::parse("https://gateway.example:7779").unwrap();
        assert_ne!(account(&a), account(&b));
        assert_ne!(account(&a), account(&https));
        assert_eq!(
            account(&a),
            account(&CanonicalOrigin::parse("http://127.0.0.1:7779").unwrap())
        );
    }

    #[test]
    fn credentials_are_isolated_by_exact_origin_and_port() {
        let store = MemoryCredentialStore::default();
        let a = CanonicalOrigin::parse("http://127.0.0.1:7779").unwrap();
        let b = CanonicalOrigin::parse("http://127.0.0.1:7780").unwrap();
        store
            .put(
                &a,
                &GatewayCredential {
                    cookie_header: "auth=secret-a".into(),
                    device_id: "device-a".into(),
                },
            )
            .unwrap();
        assert!(store.get(&b).unwrap().is_none());
        assert_eq!(store.get(&a).unwrap().unwrap().device_id, "device-a");
        assert!(!store.delete(&b).unwrap());
        assert!(store.delete(&a).unwrap());
        assert!(store.get(&a).unwrap().is_none());
    }
}
