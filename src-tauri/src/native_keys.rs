//! OS-protected Nostr keys and private-key-dependent operations for Tauri builds.

use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use base64::Engine;
use rand::RngCore;
use secp256k1::{Keypair, Message, PublicKey, Secp256k1, SecretKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

const KEYRING_SERVICE: &str = "com.stegstr.stealth.nostr";
const MAX_CONTENT_LENGTH: usize = 64_000;
const MAX_TAGS: usize = 200;
const MAX_TAG_ELEMENTS: usize = 20;
const MAX_TAG_VALUE_LENGTH: usize = 2_048;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeIdentity {
    pub key_handle: String,
    pub public_key: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UnsignedEvent {
    pub created_at: u64,
    pub kind: u16,
    pub tags: Vec<Vec<String>>,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignedEvent {
    pub id: String,
    pub pubkey: String,
    pub created_at: u64,
    pub kind: u16,
    pub tags: Vec<Vec<String>>,
    pub content: String,
    pub sig: String,
}

trait SecretStore {
    fn get(&self, handle: &str) -> Result<Vec<u8>, String>;
    fn set(&self, handle: &str, secret: &[u8]) -> Result<(), String>;
}

#[derive(Clone, Copy)]
struct KeyringStore;

impl SecretStore for KeyringStore {
    fn get(&self, handle: &str) -> Result<Vec<u8>, String> {
        keyring::Entry::new(KEYRING_SERVICE, handle)
            .map_err(keyring_error)?
            .get_secret()
            .map_err(keyring_error)
    }

    fn set(&self, handle: &str, secret: &[u8]) -> Result<(), String> {
        keyring::Entry::new(KEYRING_SERVICE, handle)
            .map_err(keyring_error)?
            .set_secret(secret)
            .map_err(keyring_error)
    }
}

fn keyring_error(error: keyring::Error) -> String {
    // Platform diagnostics are useful; credential contents are never included by keyring errors.
    format!("protected credential storage error: {error}")
}

struct NativeKeyService<S: SecretStore> {
    store: S,
}

impl<S: SecretStore> NativeKeyService<S> {
    fn new(store: S) -> Self {
        Self { store }
    }

    fn create(&self) -> Result<NativeIdentity, String> {
        let secret = SecretKey::new(&mut rand::thread_rng());
        self.import_secret(&secret.secret_bytes(), None)
    }

    fn import_hex(
        &self,
        private_key_hex: &str,
        expected_public_key: Option<&str>,
    ) -> Result<NativeIdentity, String> {
        if private_key_hex.len() != 64
            || !private_key_hex.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("private key must be 64 hexadecimal characters".to_string());
        }
        let decoded = Zeroizing::new(
            hex::decode(private_key_hex).map_err(|_| "invalid private key encoding".to_string())?,
        );
        self.import_secret(&decoded, expected_public_key)
    }

    fn import_secret(
        &self,
        secret_bytes: &[u8],
        expected_public_key: Option<&str>,
    ) -> Result<NativeIdentity, String> {
        let secret = SecretKey::from_slice(secret_bytes)
            .map_err(|_| "invalid secp256k1 private key".to_string())?;
        let public_key = public_key_for_secret(&secret);
        if let Some(expected) = expected_public_key {
            if !expected.eq_ignore_ascii_case(&public_key) {
                return Err("private key does not match the expected public key".to_string());
            }
        }
        let key_handle = format!("nostr-{public_key}");
        match self.store.get(&key_handle) {
            Ok(existing) => {
                let existing = Zeroizing::new(existing);
                let existing_secret = SecretKey::from_slice(&existing)
                    .map_err(|_| "stored credential is invalid".to_string())?;
                if public_key_for_secret(&existing_secret) != public_key {
                    return Err(
                        "protected credential does not match the requested identity".to_string()
                    );
                }
            }
            Err(_) => self.store.set(&key_handle, &secret.secret_bytes())?,
        }
        Ok(NativeIdentity {
            key_handle,
            public_key,
        })
    }

    fn lookup(&self, key_handle: &str) -> Result<NativeIdentity, String> {
        validate_handle(key_handle)?;
        let secret = self.load_secret(key_handle)?;
        Ok(NativeIdentity {
            key_handle: key_handle.to_string(),
            public_key: public_key_for_secret(&secret),
        })
    }

    fn sign_event(&self, key_handle: &str, event: UnsignedEvent) -> Result<SignedEvent, String> {
        validate_event_template(&event)?;
        let secret = self.load_secret(key_handle)?;
        let pubkey = public_key_for_secret(&secret);
        let serialized = serde_json::to_string(&serde_json::json!([
            0,
            pubkey,
            event.created_at,
            event.kind,
            event.tags,
            event.content
        ]))
        .map_err(|_| "could not serialize Nostr event".to_string())?;
        let digest = Sha256::digest(serialized.as_bytes());
        let message = Message::from_digest_slice(&digest)
            .map_err(|_| "could not construct signing digest".to_string())?;
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &secret);
        let signature = secp.sign_schnorr_no_aux_rand(&message, &keypair);
        Ok(SignedEvent {
            id: hex::encode(digest),
            pubkey,
            created_at: event.created_at,
            kind: event.kind,
            tags: event.tags,
            content: event.content,
            sig: hex::encode(signature.serialize()),
        })
    }

    fn nip04_encrypt(
        &self,
        key_handle: &str,
        recipient_public_key: &str,
        plaintext: &str,
    ) -> Result<String, String> {
        if plaintext.len() > MAX_CONTENT_LENGTH {
            return Err("NIP-04 plaintext exceeds the size limit".to_string());
        }
        let secret = self.load_secret(key_handle)?;
        let shared = nip04_shared_secret(&secret, recipient_public_key)?;
        let mut iv = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut iv);
        let ciphertext = cbc::Encryptor::<aes::Aes256>::new((&shared).into(), (&iv).into())
            .encrypt_padded_vec_mut::<Pkcs7>(plaintext.as_bytes());
        Ok(format!(
            "{}?iv={}",
            base64::engine::general_purpose::STANDARD.encode(ciphertext),
            base64::engine::general_purpose::STANDARD.encode(iv)
        ))
    }

    fn nip04_decrypt(
        &self,
        key_handle: &str,
        sender_public_key: &str,
        payload: &str,
    ) -> Result<String, String> {
        if payload.len() > MAX_CONTENT_LENGTH * 2 {
            return Err("NIP-04 payload exceeds the size limit".to_string());
        }
        let (ciphertext, iv) = payload.split_once("?iv=").ok_or("invalid NIP-04 payload")?;
        let ciphertext = Zeroizing::new(
            base64::engine::general_purpose::STANDARD
                .decode(ciphertext)
                .map_err(|_| "invalid NIP-04 ciphertext".to_string())?,
        );
        let iv = base64::engine::general_purpose::STANDARD
            .decode(iv)
            .map_err(|_| "invalid NIP-04 IV".to_string())?;
        if iv.len() != 16 {
            return Err("invalid NIP-04 IV length".to_string());
        }
        let secret = self.load_secret(key_handle)?;
        let shared = nip04_shared_secret(&secret, sender_public_key)?;
        let plaintext = cbc::Decryptor::<aes::Aes256>::new((&shared).into(), iv.as_slice().into())
            .decrypt_padded_vec_mut::<Pkcs7>(&ciphertext)
            .map_err(|_| "NIP-04 decryption failed".to_string())?;
        String::from_utf8(plaintext).map_err(|_| "NIP-04 plaintext is not UTF-8".to_string())
    }

    fn export_hex(&self, key_handle: &str) -> Result<String, String> {
        let secret = self.load_secret(key_handle)?;
        Ok(hex::encode(secret.secret_bytes()))
    }

    fn load_secret(&self, key_handle: &str) -> Result<SecretKey, String> {
        validate_handle(key_handle)?;
        let bytes = Zeroizing::new(
            self.store
                .get(key_handle)
                .map_err(|_| "unknown or unavailable key handle".to_string())?,
        );
        SecretKey::from_slice(&bytes).map_err(|_| "stored credential is invalid".to_string())
    }
}

fn validate_handle(handle: &str) -> Result<(), String> {
    if handle.len() != 70
        || !handle.starts_with("nostr-")
        || !handle[6..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("invalid key handle".to_string());
    }
    Ok(())
}

fn validate_event_template(event: &UnsignedEvent) -> Result<(), String> {
    if event.content.len() > MAX_CONTENT_LENGTH {
        return Err("event content exceeds the size limit".to_string());
    }
    if event.tags.len() > MAX_TAGS {
        return Err("event has too many tags".to_string());
    }
    for tag in &event.tags {
        if tag.len() > MAX_TAG_ELEMENTS
            || tag.iter().any(|value| value.len() > MAX_TAG_VALUE_LENGTH)
        {
            return Err("event tag exceeds the size limit".to_string());
        }
    }
    Ok(())
}

fn public_key_for_secret(secret: &SecretKey) -> String {
    let secp = Secp256k1::new();
    let keypair = Keypair::from_secret_key(&secp, secret);
    let (public_key, _) = keypair.x_only_public_key();
    hex::encode(public_key.serialize())
}

fn nip04_shared_secret(secret: &SecretKey, other_public_key: &str) -> Result<[u8; 32], String> {
    if other_public_key.len() != 64
        || !other_public_key
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("invalid peer public key".to_string());
    }
    let mut compressed = [0u8; 33];
    compressed[0] = 0x02;
    hex::decode_to_slice(other_public_key, &mut compressed[1..])
        .map_err(|_| "invalid peer public key".to_string())?;
    let public_key =
        PublicKey::from_slice(&compressed).map_err(|_| "invalid peer public key".to_string())?;
    let point = secp256k1::ecdh::shared_secret_point(&public_key, secret);
    let mut shared = [0u8; 32];
    shared.copy_from_slice(&point[..32]);
    Ok(shared)
}

#[tauri::command]
pub fn native_key_create() -> Result<NativeIdentity, String> {
    NativeKeyService::new(KeyringStore).create()
}

#[tauri::command]
pub fn native_key_import(
    private_key_hex: String,
    expected_public_key: Option<String>,
) -> Result<NativeIdentity, String> {
    let private_key_hex = Zeroizing::new(private_key_hex);
    NativeKeyService::new(KeyringStore).import_hex(&private_key_hex, expected_public_key.as_deref())
}

#[tauri::command]
pub fn native_key_lookup(key_handle: String) -> Result<NativeIdentity, String> {
    NativeKeyService::new(KeyringStore).lookup(&key_handle)
}

#[tauri::command]
pub fn native_sign_event(key_handle: String, event: UnsignedEvent) -> Result<SignedEvent, String> {
    NativeKeyService::new(KeyringStore).sign_event(&key_handle, event)
}

#[tauri::command]
pub fn native_nip04_encrypt(
    key_handle: String,
    recipient_public_key: String,
    plaintext: String,
) -> Result<String, String> {
    let plaintext = Zeroizing::new(plaintext);
    NativeKeyService::new(KeyringStore).nip04_encrypt(
        &key_handle,
        &recipient_public_key,
        &plaintext,
    )
}

#[tauri::command]
pub fn native_nip04_decrypt(
    key_handle: String,
    sender_public_key: String,
    payload: String,
) -> Result<String, String> {
    NativeKeyService::new(KeyringStore).nip04_decrypt(&key_handle, &sender_public_key, &payload)
}

/// Explicit export only. The frontend must invoke this solely from the identity backup action.
#[tauri::command]
pub fn native_key_export(key_handle: String) -> Result<String, String> {
    NativeKeyService::new(KeyringStore).export_hex(&key_handle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };

    #[derive(Clone, Default)]
    struct MemoryStore(Arc<Mutex<HashMap<String, Vec<u8>>>>);

    impl SecretStore for MemoryStore {
        fn get(&self, handle: &str) -> Result<Vec<u8>, String> {
            self.0
                .lock()
                .unwrap()
                .get(handle)
                .cloned()
                .ok_or("missing".into())
        }
        fn set(&self, handle: &str, secret: &[u8]) -> Result<(), String> {
            self.0
                .lock()
                .unwrap()
                .insert(handle.into(), secret.to_vec());
            Ok(())
        }
    }

    fn fixed_secret(value: u8) -> String {
        let mut bytes = [0u8; 32];
        bytes[31] = value;
        hex::encode(bytes)
    }

    #[test]
    fn creates_and_looks_up_without_returning_a_secret() {
        let service = NativeKeyService::new(MemoryStore::default());
        let identity = service.create().unwrap();
        assert_eq!(service.lookup(&identity.key_handle).unwrap(), identity);
        assert!(!serde_json::to_string(&identity)
            .unwrap()
            .contains("private"));
    }

    #[test]
    fn imports_idempotently_and_rejects_public_key_mismatch() {
        let service = NativeKeyService::new(MemoryStore::default());
        let first = service.import_hex(&fixed_secret(2), None).unwrap();
        let second = service
            .import_hex(&fixed_secret(2), Some(&first.public_key))
            .unwrap();
        assert_eq!(first, second);
        assert!(service
            .import_hex(&fixed_secret(3), Some(&first.public_key))
            .unwrap_err()
            .contains("does not match"));
    }

    #[test]
    fn unknown_handle_fails_closed() {
        let service = NativeKeyService::new(MemoryStore::default());
        let handle = format!("nostr-{}", "0".repeat(64));
        assert_eq!(
            service.lookup(&handle).unwrap_err(),
            "unknown or unavailable key handle"
        );
    }

    #[test]
    fn signs_a_valid_nostr_event_and_survives_service_restart() {
        let store = MemoryStore::default();
        let first = NativeKeyService::new(store.clone());
        let identity = first.import_hex(&fixed_secret(4), None).unwrap();
        drop(first);
        let restarted = NativeKeyService::new(store);
        let event = restarted
            .sign_event(
                &identity.key_handle,
                UnsignedEvent {
                    created_at: 123,
                    kind: 1,
                    tags: vec![],
                    content: "test".into(),
                },
            )
            .unwrap();
        let serialized = serde_json::to_string(&serde_json::json!([
            0,
            event.pubkey,
            event.created_at,
            event.kind,
            event.tags,
            event.content
        ]))
        .unwrap();
        assert_eq!(event.id, hex::encode(Sha256::digest(serialized.as_bytes())));
        let message = Message::from_digest_slice(&hex::decode(&event.id).unwrap()).unwrap();
        let signature =
            secp256k1::schnorr::Signature::from_slice(&hex::decode(&event.sig).unwrap()).unwrap();
        let public_key =
            secp256k1::XOnlyPublicKey::from_slice(&hex::decode(&event.pubkey).unwrap()).unwrap();
        assert!(Secp256k1::new()
            .verify_schnorr(&signature, &message, &public_key)
            .is_ok());
    }

    #[test]
    fn nip04_round_trip_keeps_secrets_in_backend() {
        let service = NativeKeyService::new(MemoryStore::default());
        let alice = service.import_hex(&fixed_secret(5), None).unwrap();
        let bob = service.import_hex(&fixed_secret(6), None).unwrap();
        let payload = service
            .nip04_encrypt(&alice.key_handle, &bob.public_key, "hello")
            .unwrap();
        assert_eq!(
            service
                .nip04_decrypt(&bob.key_handle, &alice.public_key, &payload)
                .unwrap(),
            "hello"
        );
    }

    #[test]
    #[ignore = "touches the real OS credential store"]
    fn os_keyring_smoke() {
        let service = NativeKeyService::new(KeyringStore);
        let identity = service.create().unwrap();
        assert_eq!(service.lookup(&identity.key_handle).unwrap(), identity);
        let signed = service
            .sign_event(
                &identity.key_handle,
                UnsignedEvent {
                    created_at: 1,
                    kind: 1,
                    tags: vec![],
                    content: "disposable Keychain smoke test".into(),
                },
            )
            .unwrap();
        assert_eq!(signed.pubkey, identity.public_key);
        #[cfg(target_os = "macos")]
        {
            let status = std::process::Command::new("security")
                .args([
                    "find-generic-password",
                    "-s",
                    KEYRING_SERVICE,
                    "-a",
                    &identity.key_handle,
                ])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap();
            assert!(
                status.success(),
                "credential metadata was not found in macOS Keychain"
            );
        }
        keyring::Entry::new(KEYRING_SERVICE, &identity.key_handle)
            .unwrap()
            .delete_credential()
            .unwrap();
    }
}
