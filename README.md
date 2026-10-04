# Stegstr

**Steganographic social networking.** Hide messages in images and share them anywhere—local-first, with optional Nostr sync.

Stegstr gives you two ways to use it:

- **UI app** — Desktop and mobile app. Create posts, embed them in images, and detect content from images with a graphical interface.
- **CLI module** — Command-line tool for scripts and automation. Decode, detect, embed, and create Nostr-style posts from the terminal.

Both use the same steganographic format. Data is stored and processed **locally**; Stegstr is **not exclusively Nostr**. You can use it fully offline (embed/detect in images and share via any channel). When you want to sync over the network, Stegstr can act as a Nostr client and use relays.

## Quick start

### Graphical app (UI)

Download the latest release for your platform:

- [macOS](https://github.com/brunkstr/Stegstr/releases/latest/download/Stegstr-macOS.dmg) · [Windows](https://github.com/brunkstr/Stegstr/releases/latest/download/Stegstr-Windows.exe) · [Linux](https://github.com/brunkstr/Stegstr/releases/latest/download/Stegstr-Linux.deb) / [AppImage](https://github.com/brunkstr/Stegstr/releases/latest/download/Stegstr-Linux.AppImage)

See [Releases](https://github.com/brunkstr/Stegstr/releases) for other builds and Android.

### Command-line interface (CLI)

You need [Rust](https://rustup.rs) (latest stable). Clone and build the CLI:

```bash
git clone https://github.com/brunkstr/Stegstr.git
cd Stegstr
cd src-tauri && cargo build --release --bin stegstr-cli
```

Binary: `target/release/stegstr-cli` (Windows: `stegstr-cli.exe`). Example:

```bash
./target/release/stegstr-cli post "Hello from CLI" --output bundle.json
./target/release/stegstr-cli embed cover.png -o out.jpg --payload @bundle.json --mode robust-v2 --encrypt
./target/release/stegstr-cli detect out.jpg
```

Use `--mode robust-v2` for anything that will be shared through a platform that recompresses or
resizes images (WhatsApp, Telegram, Instagram, and similar); omit it for a lossless PNG that will
only be transferred byte-for-byte.

## Build from source (full app)

Prerequisites: Node.js 18+, Rust (latest stable).

```bash
git clone https://github.com/brunkstr/Stegstr.git
cd Stegstr
npm install
npm run build:mac   # or build:win, build:linux
```

See the repo for platform-specific build deps (e.g. Xcode CLI tools, Visual Studio Build Tools, Linux dev packages).

## Links

- [Website](https://stegstr.com) — Downloads, getting started, wiki
- [Wiki / CLI docs](https://stegstr.com/wiki/cli.html) — Full CLI reference
- [Releases](https://github.com/brunkstr/Stegstr/releases)

## License

MIT
