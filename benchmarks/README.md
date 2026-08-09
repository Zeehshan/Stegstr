# Current-algorithm robustness benchmark

This suite measures the existing Rust DWT, Rust dot, TypeScript dot, and
TypeScript QIM implementations. It does not contain an alternative embedding
algorithm.

Run the reviewed baseline matrix:

```sh
npm run benchmark:stego
```

Optional filters are accepted:

```sh
node benchmarks/run.mjs --algorithms rust-dwt,typescript-qim --quick
```

Run the robust-v2 matrix without changing the frozen baseline files:

```sh
node benchmarks/run.mjs --algorithms robust-v2
```

This writes `robust-v2-results.json` and `robust-v2-results.csv`.

The default matrix includes every carrier and payload at identity, plus the
complete transformation matrix for representative 32-byte, 512-byte, and
1-KiB scenarios. All requested payload sizes, including 5 KiB and 10 KiB, are
still tested against every carrier at identity. `--quick` runs identity plus one representative JPEG and
resize case, and exists only for infrastructure checks.

Tracked reports are written to:

- `benchmarks/results/current-baseline.json`
- `benchmarks/results/current-baseline.csv`

Scratch carriers and transformed outputs live under ignored `benchmarks/work/`.
The JSON includes the environment, matrix definition, individual observations,
and aggregate summaries. CSV contains one flat row per observation.

## Carriers

Two real photographs are committed and resized with cover-cropping for their
assigned matrix dimensions. The remaining deterministic carriers are generated
by the suite.

- `photo_normal.jpg`: Yinan Chen, “People walking into a misty forest”, public
  domain dedication. Source: <https://commons.wikimedia.org/wiki/File:Gfp-wisconsin-madison-people-walking-into-misty-forest.jpg>
- `photo_high_detail.jpg`: Hannes Röst, “Fronalpstock, Switzerland”, CC BY-SA
  3.0. Source: <https://commons.wikimedia.org/wiki/File:Fronalpstock_big.jpg>

The high-detail benchmark is a resized/cropped derivative and remains under CC
BY-SA 3.0. See the source page for attribution and license text.

## Transform definitions

- JPEG qualities 95, 90, 85, 80, 75, 70, 60, and 50 re-encode the stego image.
- Resize 90%, 75%, and 50% uses Lanczos3.
- Max-dimension 2048, 1600, and 1280 only scales down when needed.
- PNG-to-JPEG emits JPEG quality 80. If an algorithm already emitted JPEG, the
  row is retained and explicitly records JPEG re-encoding.
- JPEG-to-JPEG first normalizes to JPEG quality 92, then recompresses at 80.
- Metadata stripping uses a format-preserving decode/encode with no metadata.
  This is lossless for PNG and a recompression for JPEG.
- Combined rows apply transforms left-to-right as named.

Visual metrics compare the processed stego image with the same transform
applied to the unmodified carrier. PSNR, average difference, and maximum
difference use RGB samples. SSIM is a global luminance SSIM (not windowed MS-
SSIM), included as a low-dependency baseline indicator.

## Coverage and safety

The 4000x3000 carrier is part of the identity matrix. The current TypeScript QIM
implementation materializes millions of coefficient-position objects at that
size. The runner executes QIM normally up to 2048x2048 and records larger cases
as safety-guarded, with `executed=false`, to keep the benchmark host from being
terminated by out-of-memory pressure. This guard is benchmark infrastructure;
it does not alter the production implementation.
