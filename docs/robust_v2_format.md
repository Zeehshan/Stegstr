# Robust-v2 experimental format

Robust-v2 is a new Rust-only experimental format. It does not replace any
legacy decoder and intentionally uses a different magic value and embedding
layout.

## Data pipeline

```
caller serialization
→ zlib-compress plaintext
→ split into equal data shards
→ Reed–Solomon parity shards
→ CRC32 each encoded shard packet
→ bit repetition/interleaving
→ differential-QIM embedding
```

The CLI currently rejects `--mode robust-v2 --encrypt`. This is deliberate:
the existing CLI encrypts before calling an embedder, which would cause the v2
compressor to compress ciphertext. Encryption will be enabled only through a
compression-before-existing-AES-GCM path. No new cipher or key scheme is
introduced by robust-v2.

Decode reverses the pipeline. A decoded payload is returned only after header
CRC validation, per-shard CRC validation, Reed–Solomon reconstruction, bounded
decompression, exact original-length validation, and SHA-256 payload validation.

## Header

All integers are unsigned big-endian. The fixed header is 74 bytes.

| Offset | Size | Field |
|---:|---:|---|
| 0 | 4 | Magic `SGV2` |
| 4 | 1 | Version (`2`) |
| 5 | 1 | Profile: 0 standard, 1 robust, 2 maximum |
| 6 | 2 | Flags; bit 0 means zlib-compressed |
| 8 | 2 | Header length (`74`) |
| 10 | 2 | Canonical width |
| 12 | 2 | Canonical height |
| 14 | 1 | Data-shard count |
| 15 | 1 | Parity-shard count |
| 16 | 2 | Bytes per shard |
| 18 | 4 | Compressed content length |
| 22 | 4 | Original plaintext length |
| 26 | 4 | Serialized FEC packet bytes |
| 30 | 8 | Frame ID: first 8 bytes of payload SHA-256 |
| 38 | 32 | Full plaintext SHA-256 |
| 70 | 4 | CRC32 of bytes 0–69 |

Parsing is bounded to a 65,535-byte original payload, 8,192 pixels per
dimension, 24 million input pixels, and profile-defined shard counts. Unknown
flags, dimensions, lengths, versions, or profiles are rejected.

## Shards and FEC

Compressed bytes are divided evenly across the configured data shards and
zero-padded only in the final data shard. Reed–Solomon erasure coding over
GF(2^8) generates parity shards. Every data or parity shard is serialized as:

```
CRC32 (4 bytes) | fixed-size shard bytes
```

A packet failing CRC is treated as an erasure. Reconstruction succeeds only
when at least the configured number of shards remains. The final SHA-256 makes
silent corrupted-payload success impossible.

| Profile | Data | Parity | Header repeat | Payload repeat | Canonical long edge |
|---|---:|---:|---:|---:|---:|
| Standard | 8 | 3 | 5 | 1 | 1280 |
| Robust | 6 | 4 | 7 | 3 | 1024 |
| Maximum | 4 | 4 | 9 | 5 | 1024 |

Robust is the tuning target and CLI default. The implementation never silently
downgrades a profile to make a payload fit.

## Canonical normalization

1. Decode the image and apply its EXIF orientation.
2. Remove alpha by converting to RGB8.
3. Compute a profile-specific canonical long edge while preserving the received
   aspect ratio; round both dimensions down to 8-pixel multiples.
4. Resize with Lanczos3.
5. Derive luminance as `0.299R + 0.587G + 0.114B`.

Embedding modifies the canonical luminance image, resizes only the signed
modification field back to the original dimensions, and applies that field to
the original RGB image. This preserves original high-frequency detail and
dimensions. Output is JPEG quality 95.

## Synchronization and bootstrap

A deterministic 64-bit xorshift pilot is repeated five times. The complete
header follows with profile-specific stronger repetition. Both are distributed
through the same deterministic affine permutation as payload symbols.

Decode first tries the expected canonical grid for each known profile. If none
validates, it searches a bounded set of canonical long-edge adjustments (-8,
0, +8 pixels) and source phase offsets `(0,0)`, `(1,0)`, `(0,1)`, `(1,1)`.
There are at most 36 pilot candidates. A candidate must score at least 0.68,
then recover a CRC-valid header whose profile and dimensions match the
candidate. This is a bounded scored search, not an unbounded resize sweep.

## Differential-QIM embedding

Each 8x8 luminance block supplies six disjoint low-frequency AC coefficient
pairs. DC is never modified. A bit is represented by enforcing a positive or
negative minimum difference between its pair. Pair locations are dispersed by
an index-only affine permutation whose stride is coprime with the slot count;
the implementation does not allocate a coefficient-position object per slot.

Strength is bounded by profile and block variance. Textured blocks approach the
profile maximum; smooth blocks use the profile base. Pilot/header symbols use
full strength. Payload symbols use 80% strength to reduce distortion while
retaining repeated/FEC protection.

## Capacity

The capacity API reports:

- canonical dimensions and raw coefficient-pair bits;
- pilot/synchronization overhead;
- repeated header overhead;
- payload repetition;
- data and parity shard counts;
- FEC packet byte capacity;
- conservative usable plaintext capacity.

The FEC calculation uses the actual shard size and includes four CRC bytes for
every data and parity shard. A 32-byte reserve covers zlib expansion so the
reported plaintext capacity is conservative. Encoding still checks the exact
compressed frame and rejects it before DCT processing if it does not fit.
