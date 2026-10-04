---
name: stegstr
summary: Embed and decode hidden messages in images, robust to WhatsApp/Telegram/Instagram-style recompression. Steganographic Nostr client for hiding data in images—works offline, no registration.
description: Decode and embed Stegstr payloads in images. Use when the user needs to extract hidden Nostr data from a Stegstr image, encode a payload into a cover image (PNG or, with --mode robust-v2, JPEG that survives recompression), or work with steganographic social networking (Nostr-in-images). Supports CLI (stegstr-cli decode, detect, embed, post) for scripts and AI agents.
license: MIT
tags: steganography, nostr, images, crypto, integration, file-management, automation, cli
install:
  requirements: |
    - Rust (latest stable) - https://rustup.rs
    - Git
  steps: |
    1. git clone https://github.com/brunkstr/Stegstr.git
    2. cd Stegstr/src-tauri && cargo build --release --bin stegstr-cli
    3. Binary: target/release/stegstr-cli (Windows: stegstr-cli.exe)
permissions:
  - filesystem
metadata:
  homepage: https://stegstr.com
  for-agents: https://www.stegstr.com/wiki/for-agents.html
  repo: https://github.com/brunkstr/Stegstr
---

# Stegstr

Stegstr hides Nostr messages and arbitrary payloads inside images using steganography. Users embed their feed (posts, DMs, JSON) into images and share them; recipients use Detect to load the hidden content. No registration, works offline. Use `--mode robust-v2` when the image will be re-uploaded or forwarded through a platform that recompresses media.

## When to use this skill

- User wants to **decode** (extract) hidden data from a PNG that contains Stegstr data.
- User wants to **embed** a payload into a cover PNG (e.g. Nostr bundle, JSON, text).
- User mentions steganography, Nostr-in-images, Stegstr, hiding data in images, or secret messages in photos.
- User needs programmatic access for automation, scripts, or AI agents.

## CLI (headless)

Build the CLI from the Stegstr repo:

```bash
git clone https://github.com/brunkstr/Stegstr.git
cd Stegstr/src-tauri
cargo build --release --bin stegstr-cli
```

Binary: `target/release/stegstr-cli` (or `stegstr-cli.exe` on Windows).

### Decode (extract payload)

```bash
stegstr-cli decode image.png
```

Writes raw payload to stdout. Valid UTF-8 JSON is printed as text; otherwise `base64:<data>`. Exit 0 on success.

### Detect (decode + decrypt app bundle)

```bash
stegstr-cli detect image.png
```

Decodes and decrypts; prints Nostr bundle JSON `{ "version": 1, "events": [...] }`.

### Embed (hide payload in image)

```bash
stegstr-cli embed cover.png -o out.jpg --payload "text or JSON" --mode robust-v2 --encrypt
stegstr-cli embed cover.png -o out.jpg --payload @bundle.json --mode robust-v2 --encrypt
stegstr-cli embed cover.png -o out.png --payload @bundle.json --encrypt
```

Use `--mode robust-v2` whenever the image will be sent through a platform that recompresses or
resizes media (WhatsApp, Telegram, Instagram, and similar) — it is designed to survive that kind
of processing and is the default assumed by the rest of this skill. Without `--mode`, embed falls
back to the legacy lossless format, which only survives byte-for-byte transfers (email attachment,
direct file copy) and is corrupted by any recompression. Use `--payload @file` to load from file.
Use `--encrypt` so any Stegstr user can detect (works with both `--mode legacy` and `--mode
robust-v2`, and produces the same encrypted format the desktop app uses, so files are
interchangeable). Use `--payload-base64 <base64>` for binary payloads.

### Post (create kind 1 note bundle)

```bash
stegstr-cli post "Your message here" --output bundle.json
stegstr-cli post "Message" --privkey-hex <64-char-hex> --output bundle.json
```

Creates a Nostr bundle; use `stegstr-cli embed` to hide it in an image.

## Example workflow

```bash
# Create a post bundle
stegstr-cli post "Hello from OpenClaw" --output bundle.json

# Embed into a cover image, robust to recompression, encrypted for any Stegstr user
stegstr-cli embed cover.png -o stego.jpg --payload @bundle.json --mode robust-v2 --encrypt

# Recipient detects and extracts
stegstr-cli detect stego.jpg
```

## Image format

Two embed modes, chosen with `--mode`:

- `robust-v2` (recommended): frequency-domain embedding designed to survive JPEG
  recompression and resizing. Outputs JPEG. Use this for anything that will pass through a
  messaging app or social platform before the recipient decodes it.
- `legacy` (default when `--mode` is omitted): lossless PNG embedding. Only survives an exact
  byte-for-byte file transfer — any recompression, resize, or format conversion corrupts it.

`stegstr-cli decode` and `stegstr-cli detect` try `robust-v2` first, then fall back to `legacy`
automatically, so recipients never need to know which mode a given image used.

## Payload format

- **Legacy container:** `STEGSTR` magic (7 bytes ASCII) + 4-byte big-endian length + payload bytes.
- **Robust-v2 container:** versioned header (magic `SGV2`) with Reed-Solomon error correction;
  see `docs/robust_v2_format.md` in the repo for the full binary layout.
- **Payload:** UTF-8 JSON or raw bytes (desktop app encrypts; CLI can embed raw or `--encrypt`)

Decrypted bundle: `{ "version": 1, "events": [ ... Nostr events ... ] }`. Schema: [bundle.schema.json](https://raw.githubusercontent.com/brunkstr/Stegstr/main/schema/bundle.schema.json).

## Links

- **agents.txt:** https://www.stegstr.com/agents.txt
- **For agents:** https://www.stegstr.com/wiki/for-agents.html
- **CLI docs:** https://www.stegstr.com/wiki/cli.html
- **Downloads:** https://github.com/brunkstr/Stegstr/releases/latest
