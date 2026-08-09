# Real-world channel test kit

This kit contains twelve deterministic ROBUST-profile samples: six carrier
types at 32 and 128 bytes. Generate it with:

```sh
node benchmarks/real-world/generate-kit.mjs
cargo build --release --manifest-path src-tauri/Cargo.toml --bin stegstr-cli
```

Verify a downloaded image without printing its payload:

```sh
src-tauri/target/release/stegstr-cli verify-channel received.jpg \
  --manifest benchmarks/real-world/manifest.json
```

To verify and add or replace its machine-readable observation:

```sh
node benchmarks/real-world/verify-and-record.mjs received.jpg \
  --platform whatsapp --mode normal-image --test-id rw-normal-photo-32b
```

Always identify the test explicitly. This preserves a FAIL/NO PAYLOAD result
even when no payload can be recovered. Results are keyed by platform, mode, and
test ID, so rerunning that case replaces the older observation.

The payload bytes in `manifest.json` are synthetic test data, not secrets. The
verifier compares SHA-256 values and never displays those bytes. The suitability
rating is advisory and does not currently block encoding.

See `PROCEDURES.md` for the controlled 12-observation matrix per platform mode.
