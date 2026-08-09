# Native private-key storage

## Previous flow

Identity creation/import produced a raw hexadecimal private key in `App.tsx`.
`IdentityEntry.privKeyHex` was serialized to `stegstr_identities` (and older
installs also used `stegstr_anon_key`). React selected a key and passed it to
JavaScript Nostr signing, NIP-04 DM encryption/decryption, recipient-envelope
encryption/decryption, local-to-Nostr re-signing, and identity export.

## Desktop flow

Tauri identity creation and import now call Rust commands in `native_keys.rs`.
Rust stores 32-byte Nostr secrets under service
`com.stegstr.stealth.nostr` through the maintained `keyring` crate:

- macOS: Keychain Services
- Windows: Windows Credential Manager
- Linux: Secret Service

Frontend identity metadata contains `id`, `publicKey`, `keyHandle`, label, type,
category, and optional UI metadata. Event templates and NIP-04 inputs cross the
Tauri command boundary, while the private key remains in the backend. Rust
returns only signed public events or encrypted/decrypted operation results.

Secret export remains available for backup, but it is a separate explicit user
action. Routine startup, relay synchronization, signing, encryption, and
decryption never request an exported key.

## Migration transaction

For each legacy identity, startup derives the expected public key and invokes a
one-time native import. Rust derives the public key again, rejects a mismatch,
and uses a deterministic opaque handle. Re-running an import validates the
existing credential, making the operation idempotent.

Only after all identities import successfully does the frontend write handle-
only metadata and remove the legacy anonymous-key entry. Any failure leaves the
original localStorage values unchanged and surfaces a retry-on-restart error.

## Web behavior

The browser build retains the existing localStorage key behavior and uses the
same JavaScript signing/NIP-04 implementation. This is an explicit weaker-
security fallback, not protected storage.

## CSP

The desktop CSP permits same-origin scripts only, current inline styles, the
Stegstr relay-configuration and media-upload HTTPS endpoints, arbitrary HTTPS
media, and `ws:`/`wss:` connections required for user-configurable Nostr
relays. It denies plugins/objects, forms, embedding ancestors, and base-URL
rewrites. `unsafe-eval`, wildcard script sources, and wildcard connect sources
are not enabled.
