# Security notes

## Browser private-key storage risk

The web build stores identity private keys as plaintext hexadecimal strings in
browser `localStorage`. Browsers do not provide an OS credential-store boundary
that Stegstr can use portably. Any script executing in the application origin or
a user/process with access to browser storage can read those browser keys.

The Nostr reliability work does not transmit or copy private keys into the
relay manager, event cache, outbox, logs, or relay messages. The outbox stores
already-signed public events only. Logger detail keys that look sensitive are
redacted, and payload byte dumps were removed.

Desktop/Tauri builds use opaque handles in frontend identity metadata and keep
the corresponding secrets in the OS credential store. Signing and NIP-04
operations execute in Rust. A secret crosses into JavaScript only after the user
explicitly selects the identity backup/export action.

Legacy desktop plaintext identities are imported once, verified against their
public key, and removed from localStorage only after every import succeeds. A
failed migration preserves the original data for a later retry.
