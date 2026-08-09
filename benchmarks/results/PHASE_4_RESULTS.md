# Robust-v2 validation and tuning report

## Real-world kit and claim status

`benchmarks/real-world/manifest.json` contains 12 deterministic ROBUST tests:
normal, detailed, low-detail, dark, and bright photographs plus a screenshot,
each with 32-byte and 128-byte payloads. All 12 generated originals pass the
hash-based channel verifier.

WhatsApp, Telegram, and Instagram measurements are **pending**. No returned
platform files were available, so `real-world-platform-results.json/.csv`
contain no observations. This intentionally makes no platform support claim.
The exact image/file modes and 12-case matrices are in `PROCEDURES.md`.

## Local social-target matrix

The release-mode local matrix contains 168 observations across the six kit
carriers and both payload sizes.

| Transformation | Exact matches |
|---|---:|
| Identity | 12/12 |
| JPEG 95, 90, 85, 80, 75, 70, 60, 50 | 12/12 at every quality |
| Resize 90% | 12/12 |
| Resize 75% | 12/12 |
| Resize 50% | 12/12 |
| Resize 75% + JPEG 80 | 12/12 |
| Resize 50% + JPEG 75 | 12/12 |

## Frozen benchmark after tuning

| Family | Before | After |
|---|---:|---:|
| Identity (encodable rows) | 28/28 | 28/28 |
| JPEG recompression | 27/27 | 27/27 |
| Resize | 8/9 | 8/9 |
| Max dimension | 9/9 | 9/9 |
| Conversion | 3/3 | 3/3 |
| Metadata strip | 3/3 | 3/3 |
| Combined | 5/6 | 5/6 |

The same low-detail 32-byte carrier still fails at 50% resize and at 50% +
JPEG75. The required 75% + JPEG80 case remains 3/3.

## Visual quality

No visual-strength tuning candidate was retained. Payload-only scale 0.75 and a
texture-adaptive 0.75→0.55 candidate preserved the frozen corpus matrix, but
both failed the independent 75%+JPEG80 Rust integration carrier. The stronger
0.80 production setting therefore remains unchanged; pilot/header strength and
FEC are also unchanged.

| Payload | Checked-in historical PSNR / SSIM | Re-measured production PSNR / SSIM |
|---:|---:|---:|
| 32 B | 30.38 / 0.87135 | 30.13 / 0.86594 |
| 128 B | 29.07 / 0.84282 | 28.62 / 0.83168 |
| 512 B | 26.26 / 0.77062 | 25.55 / 0.74938 |
| 1 KiB | 24.24 / 0.70937 | 23.42 / 0.68244 |

The historical numbers could not be reproduced from the checked-in 0.80
implementation. Because every quality-improving candidate failed the required
independent robustness test, reporting the lower fresh control is safer than
shipping a regression. The requested 128-byte target is not met. On the
distinct real-world kit, whose smooth content lowers PSNR, the final averages
are 28.02/0.96037 (32 B) and 26.49/0.94517 (128 B).

## Low-detail diagnosis and suitability

At the exact failing 50% case, pilot confidence is 1.000 and the header parses.
Only 4 of 10 payload shards pass CRC, while 6 are required. The source has mean
8x8 luminance standard deviation 0.058, zero textured blocks, and a 0/100
`Unsuitable` advisory score. The failure is payload coefficient instability in
a texture-free carrier after downsampling, not synchronization loss or weak
pilot energy. Raising global strength would penalize every carrier, so the
encoder does not do that. Suitability remains advisory—encoding is not rejected
without real-platform calibration.

## Performance

Wall-clock bridge measurements use a warm-up and three measured repeats.

| Carrier | Debug encode / decode | Release encode / decode |
|---|---:|---:|
| 1280×720 normal photo | 2033 / 940 ms | 58.6 / 29.8 ms |
| 1920×1080 detailed photo | 3721 / 1614 ms | 115.0 / 43.9 ms |

The decoder now tries the default ROBUST normalization first. That removes a
full STANDARD resize/DCT pass from the common path without changing the format
or recovery thresholds. Release 1080p totals about 159 ms in this test and is
practical for desktop use.

## Recommendation

Do **not** proceed to Nostr work yet if real-platform survival is a release
gate. The deterministic kit and verifier are ready, and local JPEG/75% results
are strong, but WhatsApp, Telegram, and Instagram still have zero measured
observations. Run at least the documented 12 cases per intended platform mode,
then decide from the returned-file evidence. No Nostr work is included here.
