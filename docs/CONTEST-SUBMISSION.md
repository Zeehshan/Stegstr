# Stegstr contest technical summary

## What changed

The candidate adds a versioned robust-v2 steganography format, retained legacy
decoders, deterministic compatibility vectors, release benchmarks, real-channel
recording tools, a persistent multi-relay Nostr manager, offline publication,
and OS-protected native Nostr keys. Final validation also connected the existing
Rust robust-v2 engine to the desktop embed/detect path without changing the
algorithm or CLI behavior.

## Robust-v2 architecture

Robust-v2 normalizes the carrier to a deterministic 8×8 grid, embeds a repeated
pilot and versioned header, uses differential DCT coefficient-pair QIM, compresses
the framed payload, and applies Reed-Solomon erasure/error protection plus CRC
integrity checks. Decoding tries bounded synchronization candidates and returns
payload bytes only after frame and integrity validation.

## Measured robustness

The comparable transformation rows below are exact payload matches among
successfully encoded cases.

| Transformation | Rust dot | TypeScript dot | TypeScript QIM | robust-v2 |
|---|---:|---:|---:|---:|
| JPEG Q80 | 3/3 | 3/3 | 3/3 | 3/3 |
| JPEG Q70 | 3/3 | 3/3 | 3/3 | 3/3 |
| Resize 90% | 0/3 | 0/3 | 0/3 | 3/3 |
| Resize 75% | 0/3 | 0/3 | 0/3 | 3/3 |
| Resize 50% | 0/3 | 0/3 | 0/3 | 2/3 |
| Resize 75% + JPEG80 | 0/3 | 0/3 | 0/3 | 3/3 |
| Resize 50% + JPEG75 | 0/3 | 0/3 | 0/3 | 2/3 |

The two robust-v2 failures are the same 32-byte texture-free low-detail carrier.
The final full matrix contains 99 rows: 85 encodes fit carrier capacity and 83
decode to exact payloads. All 28 encodable identity rows and all 27 JPEG rows
pass. Capacity rejections are not decode corruption.

## Real platform evidence

WhatsApp normal-image mode has four confirmed exact returned-file results:
bright and low-detail photographs at 32 and 128 bytes. Four normal/detailed rows
are excluded because they recovered the wrong test ID and are consistent with a
returned file being reused during recording. Dark/screenshot, document mode,
Telegram, and Instagram remain untested. This candidate does not claim guaranteed
support for WhatsApp, Telegram, or Instagram.

## Release performance

Release bridge wall-clock time after warm-up, five repeats, 128-byte payload:

| Carrier | Encode | Decode |
|---|---:|---:|
| 1280×720 normal photo | 59.3 ms | 29.9 ms |
| 1920×1080 detailed photo | 116.7 ms | 45.5 ms |
| 2048×2048 gradient | 201.9 ms | 85.0 ms |

Process startup is included. No performance tuning was performed during final
validation.

## Nostr reliability and public-relay evidence

The relay manager tracks per-relay lifecycle state, validates incoming events,
deduplicates by event ID, restores subscriptions, uses capped backoff, and keeps
a persistent offline outbox. A 20.41-minute public soak used a disposable
in-memory identity and two harmless events. Damus and nos.lol accepted and
returned the event; relay.nostr.band was unavailable/non-101 during the run.
The shared receive path delivered one copy and the offline event flushed after
manager restart.

## Security

Desktop keys are stored through the Rust `keyring` backend using macOS Keychain,
Windows Credential Manager, or Linux Secret Service. Frontend metadata uses an
opaque handle; event signing and NIP-04 private-key operations run in Rust.
Legacy localStorage migration verifies the public key before deleting plaintext
and is idempotent. Explicit identity removal deletes only its validated native
credential and leaves metadata intact if cleanup fails. Secret export remains an
explicit user action. Tauri uses a restrictive CSP and default dialog/opener
capabilities rather than an allow-all permission set.

## Platform/build status

- macOS arm64: release binary, `.app`, and unsigned DMG built; packaged process
  launch verified.
- Windows: GitHub Actions has a native `windows-latest` Tauri build job. A local
  cross-check compiled `windows-native-keyring-store` but could not complete
  `secp256k1-sys` without the MSVC SDK/linker; Windows runtime is not verified.
- Linux: CI is configured for Ubuntu 22.04. Runtime needs Secret Service; current
  candidate runtime is not verified on Linux.

## Backward compatibility

Rust DWT, Rust dot, TypeScript dot, TypeScript QIM, and robust-v2 golden vectors
remain tested. Robust-v2 has a separate magic/version and does not replace or
remove legacy formats. Desktop detection tries robust-v2 before legacy decoders.

## Known limitations

- Unsigned/unnotarized macOS package requires Gatekeeper override.
- Physical macOS sleep/wake and interactive legacy migration are manual gates.
- Four confirmed WhatsApp files are insufficient for a general platform claim.
- Telegram/Instagram have no returned-file measurements.
- The smooth low-detail carrier does not survive the two 50% downsample cases.
- Browser private-key storage remains weaker than native storage.

## Reproduction commands

```sh
npm test
npx tsc --noEmit
npm run build
cd src-tauri && cargo test --all-targets
node benchmarks/run.mjs --algorithms robust-v2 --release --report-stem final-contest-robust-v2-results
npm run benchmark:final-performance
npm run tauri build -- --bundles app
npm run tauri build -- --bundles dmg
```

See `docs/CONTEST-TESTING.md` for installation, manual platform procedures,
sleep/wake diagnostics, and disposable migration verification.
