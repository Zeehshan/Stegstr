# Current steganography formats (Phase 1 baseline)

This document freezes the formats present on `contest/robust-stegstr` before a
robust-v2 design is attempted. It is descriptive, not a proposal. The current
implementations are not mutually interchangeable even when their outer payload
headers look similar.

## Shared logical envelope

Rust DWT, Rust dot, and TypeScript dot wrap the caller payload as:

```
offset  size  value
0       7     ASCII "STEGSTR" (53 54 45 47 53 54 52)
7       4     unsigned payload byte length, big-endian
11      N     payload bytes
```

Rust dot and TypeScript dot add a two-byte unsigned big-endian length in front
of this envelope. That value is the envelope length. TypeScript QIM also adds a
two-byte codeword length, but the following bytes are Reed-Solomon encoded and
therefore are not dot-compatible.

The canonical golden payload is 16 bytes:
`00 01 02 03 10 20 40 80 fe ff 53 54 45 47 00 7f`.
Its shared envelope is:

```
53 54 45 47 53 54 52 00 00 00 10
00 01 02 03 10 20 40 80 fe ff 53 54 45 47 00 7f
```

The dot preamble is `00 1b`, because the envelope is 27 bytes.

## Rust DWT

- Implementation: `src-tauri/src/stego.rs`.
- Carrier normalization: decoded with EXIF orientation applied, converted to
  RGBA, and cropped down to even dimensions.
- Output: RGBA PNG.
- Spatial unit: 2x2 Haar block, processed independently in R, G, then B.
- Bit order: MSB first within each byte.
- Embedding: one bit replaces the integer LSB of each LH coefficient. The
  inverse transform writes pixels back with integer arithmetic and clamping.
- Redundancy: the complete envelope is embedded independently in every
  256x256 tile that can hold it. If no tile can hold it, one copy is embedded
  across the complete image.
- Detection: complete-image scan first, then overlapping 256x256 tiles at a
  128-pixel step. The decoder scans the recovered coefficient bitstream for the
  magic rather than requiring bit offset zero.
- Integrity: magic and declared length only; no checksum or FEC.

The current tiled encoder reads each source tile row from x=0 rather than x=tx,
while writing it back at x=tx. This is recorded as a production defect and is
not changed in the baseline branch.

## Rust dot

- Implementation: `src-tauri/src/stego_dot.rs`.
- Carrier normalization: EXIF orientation applied, RGB8.
- Output: RGB PNG.
- Grid: 2x2 cells beginning at `(2,2)`, with a six-pixel step on both axes.
- Symbol: two payload bits select one of four offsets in the cell. All four
  pixels are set white, then the selected pixel is set black.
- Position order: deterministic modular spread with starting index 0 and a
  step beginning at 131, increased by two until coprime with cell count.
- Redundancy: each symbol is written to three **adjacent positions** in the
  spread-order stream (`symbol_index * 3 + repeat_index`).
- Detection: groups adjacent triples and majority-votes. A legacy seeded
  Fisher-Yates position order is attempted only if spread-order decoding fails.
- Integrity: magic and declared length only; no checksum despite the local
  variable name `codeword_len`.

## TypeScript dot

- Implementation: `src/stego-dot.ts`.
- Carrier/output representation: RGBA pixel buffer; web wrappers encode PNG.
- Grid, symbols, bit order, envelope, and modular spread are the same concepts
  as Rust dot.
- Redundancy layout is different: copy `r` of symbol `s` is written at
  `s + r * symbol_count`. Detection, however, derives its stride from the full
  carrier cell count (`floor(cell_count / 3)`), not from the encoded symbol
  count. The decoder commonly succeeds only through its repeat=1 fallback.
- Integrity: magic and declared length only; no checksum or FEC.

### Rust dot / TypeScript dot incompatibility

The formats are not cross-decodable in the general case. Rust uses adjacent
triples; TypeScript uses three separated runs. Their production decoders make
the same incompatible grouping assumptions as their encoders (plus different
legacy fallbacks). The baseline records this rather than changing either side.

## TypeScript QIM

- Implementation: `src/stego-qim.ts`, with DCT helpers in `src/dct.ts` and
  Reed-Solomon in `src/reed-solomon.ts`.
- Carrier decode/output: browser canvas decode, then JPEG output (default
  quality 75).
- Payload preprocessing: DEFLATE by default.
- Inner envelope: `STEGSTR`, four-byte big-endian compressed length, compressed
  bytes.
- FEC: Reed-Solomon over GF(256), primitive polynomial 0x11d, 128 parity
  symbols by default. Long messages are chunked by the codec implementation.
- Outer framing: two-byte big-endian Reed-Solomon codeword length.
- Bit order: MSB first; each bit repeated five consecutive times.
- Domain: luminance derived from decoded RGB; 8x8 floating-point DCT; JPEG
  quantization table for quality 75; 24 selected AC coefficients per block.
- Stream order: AC-major (one AC position across all blocks, then the next).
- QIM: delta 14, reconstruction offsets at plus/minus delta/4.
- Detection: QIM margin, majority vote, optional low-confidence RS erasures,
  magic/length validation, then inflate.
- Integrity: RS error correction plus DEFLATE validation; no explicit payload
  checksum or authenticated envelope at this layer.

### QIM incompatibilities

TypeScript QIM is incompatible with both dot formats and Rust DWT. It is also
not byte-for-byte compatible with `channel_simulator/dct_variants.py`: the
TypeScript implementation uses AC-major coefficient order and default DEFLATE,
while the Python variant uses a different stream/preprocessing path. Browser
JPEG encoders can also differ by platform, so golden compatibility is asserted
by successful decode and logical framing, not by requiring identical JPEG file
bytes from every browser engine.

## Golden artifacts

`benchmarks/golden/manifest.json` identifies deterministic carriers and encoded
artifacts for each implementation. Tests decode the committed artifact with the
current production decoder and compare the exact payload. The manifest also
stores hashes so an intentional format change must explicitly regenerate the
vectors. (The full-image artifacts use the manifest's deterministic 32-byte
payload; the 16-byte sequence above is the compact framing example.) Cross-
format expectations are `incompatible`, not forced success.
