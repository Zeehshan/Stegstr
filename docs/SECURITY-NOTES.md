# Security notes

## Current private-key storage risk

Stegstr currently stores identity private keys as plaintext hexadecimal strings
inside browser `localStorage` (`stegstr_identities` and the legacy anonymous-key
entry). Any script executing in the application origin, a compromised webview,
or a user/process with access to the webview storage can read those keys.

The Nostr reliability work does not transmit or copy private keys into the
relay manager, event cache, outbox, logs, or relay messages. The outbox stores
already-signed public events only. Logger detail keys that look sensitive are
redacted, and payload byte dumps were removed.

Migrating keys to protected native storage is intentionally deferred to the
approved security phase. Until then, users should treat the desktop profile and
its local application data as sensitive and avoid importing high-value keys.
