# Robust-v2 Phase 3/4 results

Command:

```sh
node benchmarks/run.mjs --algorithms robust-v2
```

The frozen v1 files `current-baseline.json` and `current-baseline.csv` were not
changed. Robust-v2 produced 99 new observations in `robust-v2-results.json` and
`robust-v2-results.csv`.

## Frozen QIM comparison

Cells show exact payload matches over executed rows. Identity includes capacity
failures; robust-v2 is 28/28 for successfully encoded identity cases.

| Transformation | Old TypeScript QIM | Robust-v2 |
|---|---:|---:|
| Identity | 22/36 (61.1%) | 28/42 (66.7%) |
| JPEG 95 | 3/3 | 3/3 |
| JPEG 90 | 3/3 | 3/3 |
| JPEG 80 | 3/3 | 3/3 |
| JPEG 70 | 3/3 | 3/3 |
| JPEG 60 | 3/3 | 3/3 |
| JPEG 50 | 3/3 | 3/3 |
| Resize 90% | 0/3 | 3/3 |
| Resize 75% | 0/3 | 3/3 |
| Resize 50% | 0/3 | 2/3 |
| Max 2048 | 3/3 | 3/3 |
| Max 1600 | 2/3 | 3/3 |
| Max 1280 | 2/3 | 3/3 |
| PNG → JPEG 80 | 3/3 | 3/3 |
| JPEG → JPEG 80 | 3/3 | 3/3 |
| Resize 75% → JPEG 80 | 0/3 | 3/3 |
| Resize 50% → JPEG 75 | 0/3 | 2/3 |

The two transform failures were both the 32-byte low-detail carrier at 50%
resize, with and without JPEG 75. No decoder returned corrupted bytes.

## Results by payload size

The 32, 512, and 1024-byte rows include the transformation matrix assigned by
the frozen suite. The 128-byte rows are identity coverage.

| Payload | Exact matches | Notes |
|---:|---:|---|
| 32 B | 24/26 (92.3%) | Two 50% low-detail failures |
| 128 B | 7/7 (100%) | Identity |
| 512 B | 26/26 (100%) | Full assigned transformations |
| 1 KiB | 26/26 (100%) | Full assigned transformations |
| 5 KiB | 0/7 encoded | Correctly rejected by ROBUST capacity |
| 10 KiB | 0/7 encoded | Correctly rejected by ROBUST capacity |

ROBUST conservative usable capacity ranges from about 1,210 bytes at 16:9 to
2,290 bytes at 1:1 in the frozen corpus. STANDARD provides higher capacity;
MAXIMUM trades additional capacity for redundancy.

## Identity visual quality by payload

| Payload | PSNR | SSIM | Avg RGB difference | Avg maximum difference |
|---:|---:|---:|---:|---:|
| 32 B | 30.38 dB | 0.87135 | 5.385 | 69.3 |
| 128 B | 29.07 dB | 0.84282 | 6.641 | 78.1 |
| 512 B | 26.26 dB | 0.77062 | 9.777 | 86.7 |
| 1 KiB | 24.24 dB | 0.70937 | 12.473 | 97.0 |

The 32-byte target meets the approximate 30 dB / 0.85 goal. Larger ROBUST
payloads buy very strong resize/JPEG survival at a visible metric cost and need
further payload-density/strength tuning before client claims.

## Performance

Average identity times in the unoptimized debug benchmark:

| Carrier | Encode | Decode | Total |
|---|---:|---:|---:|
| 1280x720 normal photo | 2.20 s | 1.00 s | 3.20 s |
| 1920x1080 detailed photo | 3.66 s | 2.93 s | 6.59 s |
| 640x480 carriers | ~1.49 s | ~1.55 s | ~3.04 s |
| 2048x2048 gradient | 7.06 s | 5.36 s | 12.41 s |
| 4000x3000 bright carrier | 16.64 s | 11.96 s | 28.60 s |

These include image decode/resize and run in the Cargo debug profile. The core
uses index-based slot mapping and caches at most one 64-value DCT block per
visited block; it does not allocate millions of coefficient-position objects.

## Status

Robust-v2 materially improves the simulation target and is suitable for a
controlled real-device WhatsApp experiment with 32–128 byte payloads. It is not
ready for a broad support claim: visual quality falls below target at 512 bytes
and 1 KiB, the low-detail 50% case remains unreliable, real platform geometry
may include cropping/color changes not represented here, and encryption is
intentionally disabled until compression-before-encryption is integrated.
