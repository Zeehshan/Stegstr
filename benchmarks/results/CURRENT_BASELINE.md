# Current steganography baseline

Generated from commit `ad2e10e988eb4c34b8fa15be879a2219c7f54e3d` on 2026-08-09
(Asia/Karachi) with `npm run benchmark:stego`. This report measures the current
implementations; no robust-v2 changes are included. The authoritative rows are
`current-baseline.json` and `current-baseline.csv` (396 observations).

## Overall exact-match results

The denominator is executed observations. Six 4000x3000 TypeScript QIM identity
cases were recorded with `executed=false` by the documented memory safety guard.

| Algorithm | Encode success | Exact payload match | Identity exact match |
|---|---:|---:|---:|
| Rust DWT | 99/99 (100.0%) | 4/99 (4.0%) | 4/42 (9.5%) |
| Rust dot | 86/99 (86.9%) | 69/99 (69.7%) | 29/42 (69.0%) |
| TypeScript dot | 86/99 (86.9%) | 69/99 (69.7%) | 29/42 (69.0%) |
| TypeScript QIM | 84/93 (90.3%) | 62/93 (66.7%) | 22/36 (61.1%) |

Encode failures in dot/QIM rows are mostly expected capacity limits. Rust DWT's
low exact-match rate is not a capacity issue: the current multi-tile path often
returns corrupt bytes after accepting magic and length without integrity data.

## JPEG recompression

Each quality has three representative observations (32, 512, and 1024 bytes on
the selected carriers).

| Algorithm | Q95 | Q90 | Q85 | Q80 | Q75 | Q70 | Q60 | Q50 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Rust DWT | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 |
| Rust dot | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| TypeScript dot | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| TypeScript QIM | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |

PNG-to-JPEG quality 80 and JPEG-to-JPEG quality 80 have the same split: Rust
DWT 0/3; each dot implementation 3/3; TypeScript QIM 3/3.

## Resize

| Algorithm | 90% | 75% | 50% | max 2048 | max 1600 | max 1280 |
|---|---:|---:|---:|---:|---:|---:|
| Rust DWT | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 |
| Rust dot | 0/3 | 0/3 | 0/3 | 3/3 | 2/3 | 2/3 |
| TypeScript dot | 0/3 | 0/3 | 0/3 | 3/3 | 2/3 | 2/3 |
| TypeScript QIM | 0/3 | 0/3 | 0/3 | 3/3 | 2/3 | 2/3 |

Some max-dimension operations are no-ops for already-small carriers. Every
actual percentage resize failed for every current algorithm.

## Combined resize and recompression

| Algorithm | resize 75% → JPEG 80 | resize 50% → JPEG 75 |
|---|---:|---:|
| Rust DWT | 0/3 | 0/3 |
| Rust dot | 0/3 | 0/3 |
| TypeScript dot | 0/3 | 0/3 |
| TypeScript QIM | 0/3 | 0/3 |

## Identity visual quality

Metrics are averaged over successfully encoded identity rows. PSNR/average/max
use RGB samples. SSIM is global luminance SSIM.

| Algorithm | PSNR dB | SSIM | Average difference | Average max difference |
|---|---:|---:|---:|---:|
| Rust DWT | 28.52 | 0.72138 | 18.564 | 116.5 |
| Rust dot | 26.00 | 0.72308 | 2.635 | 246.3 |
| TypeScript dot | 26.01 | 0.72305 | 2.573 | 246.3 |
| TypeScript QIM | 32.39 | 0.87952 | 5.841 | 51.1 |

The dot average is low because most pixels are untouched, but its maximum
difference is near the full 8-bit range: the method deliberately creates black
and white micro-dots. Rust DWT's unexpectedly poor average distortion is
consistent with the recorded tile x-offset defect.

## Baseline conclusion

- None of the current implementations survives an actual resize in this matrix.
- DWT LSB embedding is destroyed by JPEG and has correctness problems even at
  identity on multi-tile carriers.
- Dot survives JPEG very well here but has conspicuous local pixel excursions,
  limited capacity, incompatible Rust/TypeScript repetition layouts, and no
  resize synchronization.
- QIM has the best measured visual quality and JPEG survival, but loses all
  payloads after resize, sometimes fails its own JPEG round-trip for certain
  carrier/payload combinations, underestimates multi-chunk RS overhead in its
  capacity helper, and has a high-resolution memory-scaling problem.

The robust-v2 design should therefore retain frequency-domain/JPEG resilience
as a starting point while adding geometric synchronization, resize-tolerant
redundancy, explicit integrity/authentication, correct capacity accounting, and
a streaming/block-index representation. It should not build on coefficient LSB
or fixed absolute dot-grid positions.
