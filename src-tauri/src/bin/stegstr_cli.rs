//! Stegstr CLI: headless decode, embed, detect, and post for scripts and AI agents.
//! Build with: cargo build --release --bin stegstr-cli

use base64::Engine;
use secp256k1::Secp256k1;
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const STEGSTR_SUFFIX: &str = " Sent by Stegstr.";
const MAX_NOTE_LENGTH: usize = 5000;

fn usage() -> &'static str {
    r#"stegstr-cli — Stegstr command-line interface

Usage:
  stegstr-cli decode <image> [--decrypt]          Extract robust-v2 or legacy payload
  stegstr-cli detect <image>                      Detect robust-v2 first, then legacy
  stegstr-cli embed <cover> -o <out> --payload <string|@file> [--mode legacy|robust-v2] [--robustness standard|robust|maximum] [--encrypt] [--payload-base64]
  stegstr-cli post "content" [--privkey-hex HEX] [--output bundle.json]  Create kind 1 note, output bundle JSON

Decode:
  Writes payload to stdout. With --decrypt: decrypts Stegstr app-layer and prints bundle JSON.
  Without --decrypt: raw payload (JSON text or base64:<data>). Exit 0 on success.

Detect:
  Decodes image and decrypts; prints Nostr bundle JSON { "version": 1, "events": [...] }.

Embed:
  --payload <string>     Payload as UTF-8 string (bundle JSON for full feed)
  --payload @<path>      Payload from file (e.g. --payload @bundle.json)
  --payload-base64 <b64> Payload as base64 string
  --encrypt              Encrypt with app key before embedding (any Stegstr user can detect)
  --mode robust-v2       Use the experimental Rust differential-QIM format (default remains legacy)
  --robustness <profile> standard, robust (default), or maximum; robust-v2 only
  -o, --output <path>    Output PNG path (required for embed)

Robust-v2 currently rejects --encrypt instead of compressing ciphertext in the
wrong order. Legacy --encrypt behavior is unchanged.

Post:
  Creates a kind 1 Nostr note with Stegstr suffix. Outputs bundle JSON to stdout or --output file.
  --privkey-hex <hex>    Nostr secret key (64-char hex). If omitted, a new key is generated for this run.
"#
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("{}", usage());
        std::process::exit(1);
    }
    let sub = &args[1];
    if sub == "decode" {
        if let Err(e) = run_decode(&args[2..]) {
            eprintln!("decode error: {}", e);
            std::process::exit(1);
        }
        return;
    }
    if sub == "detect" {
        if args.len() < 3 {
            eprintln!("{}", usage());
            std::process::exit(1);
        }
        let path = &args[2];
        if let Err(e) = run_detect(path) {
            eprintln!("detect error: {}", e);
            std::process::exit(1);
        }
        return;
    }
    if sub == "embed" {
        if let Err(e) = run_embed(&args[2..]) {
            eprintln!("embed error: {}", e);
            std::process::exit(1);
        }
        return;
    }
    if sub == "post" {
        if let Err(e) = run_post(&args[2..]) {
            eprintln!("post error: {}", e);
            std::process::exit(1);
        }
        return;
    }
    eprintln!("{}", usage());
    std::process::exit(1);
}

fn run_decode(args: &[String]) -> Result<(), String> {
    let mut decrypt = false;
    let mut image_path: Option<&str> = None;
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if a == "--decrypt" {
            decrypt = true;
        } else if !a.starts_with('-') && image_path.is_none() {
            image_path = Some(a);
        }
        i += 1;
    }
    let path_str = image_path.ok_or("decode requires <image.png>")?;
    let path = Path::new(path_str);
    let (payload, is_v2) = match stegstr_lib::stego_v2::decode(path) {
        Ok(result) => (result.payload, true),
        Err(_) => (stegstr_lib::stego::decode(path)?, false),
    };
    if decrypt && is_v2 {
        return Err("robust-v2 encrypted payloads are not enabled yet".to_string());
    }
    let output = if decrypt && stegstr_lib::stego_crypto::is_encrypted_payload(&payload) {
        stegstr_lib::stego_crypto::decrypt_app(&payload)?
    } else if decrypt {
        return Err(
            "Payload is not Stegstr app-encrypted (use without --decrypt for raw)".to_string(),
        );
    } else {
        match String::from_utf8(payload.clone()) {
            Ok(s) if s.trim_start().starts_with('{') => s,
            _ => format!(
                "base64:{}",
                base64::engine::general_purpose::STANDARD.encode(&payload)
            ),
        }
    };
    io::stdout()
        .write_all(output.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn run_detect(image_path: &str) -> Result<(), String> {
    let path = Path::new(image_path);
    let payload = match stegstr_lib::stego_v2::decode(path) {
        Ok(result) => result.payload,
        Err(_) => stegstr_lib::stego::decode(path)?,
    };
    let json = if stegstr_lib::stego_crypto::is_encrypted_payload(&payload) {
        stegstr_lib::stego_crypto::decrypt_app(&payload)?
    } else {
        String::from_utf8(payload).map_err(|e| e.to_string())?
    };
    io::stdout()
        .write_all(json.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn run_embed(args: &[String]) -> Result<(), String> {
    let mut cover: Option<&str> = None;
    let mut output: Option<&str> = None;
    let mut payload_str: Option<String> = None;
    let mut payload_base64: Option<String> = None;
    let mut encrypt = false;
    let mut mode = "legacy".to_string();
    let mut robustness = stegstr_lib::stego_v2::RobustnessProfile::Robust;

    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if a == "-o" || a == "--output" {
            i += 1;
            output = Some(args.get(i).ok_or("missing value for -o/--output")?);
        } else if a == "--payload" {
            i += 1;
            let v = args.get(i).ok_or("missing value for --payload")?;
            if v.starts_with('@') {
                let path = v.trim_start_matches('@');
                payload_str = Some(fs::read_to_string(path).map_err(|e| e.to_string())?);
            } else {
                payload_str = Some(v.clone());
            }
        } else if a == "--payload-base64" {
            i += 1;
            payload_base64 = Some(
                args.get(i)
                    .ok_or("missing value for --payload-base64")?
                    .clone(),
            );
        } else if a == "--encrypt" {
            encrypt = true;
        } else if a == "--mode" {
            i += 1;
            mode = args.get(i).ok_or("missing value for --mode")?.clone();
        } else if a == "--robustness" {
            i += 1;
            robustness = args
                .get(i)
                .ok_or("missing value for --robustness")?
                .parse()?;
        } else if !a.starts_with('-') && cover.is_none() {
            cover = Some(a);
        }
        i += 1;
    }

    let cover_path = cover.ok_or("embed requires <cover.png>")?;
    let output_path = output.ok_or("embed requires -o/--output <out.png>")?;

    let mut payload_bytes: Vec<u8> = if let Some(b64) = payload_base64 {
        base64::engine::general_purpose::STANDARD
            .decode(b64.trim())
            .map_err(|e| e.to_string())?
    } else if let Some(s) = payload_str {
        s.into_bytes()
    } else {
        return Err(
            "embed requires --payload <string|@file> or --payload-base64 <b64>".to_string(),
        );
    };

    if encrypt && mode == "robust-v2" {
        return Err(
            "robust-v2 --encrypt is not enabled until compression-before-encryption is wired"
                .to_string(),
        );
    }
    if encrypt {
        let plaintext = String::from_utf8(payload_bytes).map_err(|e| e.to_string())?;
        payload_bytes = stegstr_lib::stego_crypto::encrypt_app(&plaintext)?;
    }

    let output_bytes = match mode.as_str() {
        "legacy" => stegstr_lib::stego::encode(Path::new(cover_path), &payload_bytes)?,
        "robust-v2" => {
            stegstr_lib::stego_v2::encode(Path::new(cover_path), &payload_bytes, robustness)?
        }
        _ => return Err(format!("unknown embed mode: {mode}")),
    };
    fs::write(output_path, output_bytes).map_err(|e| e.to_string())?;
    eprintln!("Wrote {}", output_path);
    Ok(())
}

fn ensure_stegstr_suffix(content: &str) -> String {
    let mut s = content.to_string();
    if !s.ends_with(STEGSTR_SUFFIX) {
        s.push_str(STEGSTR_SUFFIX);
    }
    if s.len() > MAX_NOTE_LENGTH {
        s.truncate(MAX_NOTE_LENGTH);
    }
    s
}

/// Create a NIP-01 kind 1 event and return (id_hex, pubkey_hex, created_at, sig_hex) for bundle JSON.
fn create_kind1_event(
    content: &str,
    sk: &secp256k1::SecretKey,
) -> Result<(String, String, u64, String), String> {
    let secp = Secp256k1::new();
    let pk = secp256k1::Keypair::from_secret_key(&secp, sk);
    let (xonly, _parity) = pk.x_only_public_key();
    let pubkey_hex = hex::encode(xonly.serialize());
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let tags: Vec<Vec<String>> = vec![];
    let serialized = serde_json::to_string(&serde_json::json!([
        0, pubkey_hex, created_at, 1, tags, content
    ]))
    .map_err(|e| e.to_string())?;
    let id_hash = Sha256::digest(serialized.as_bytes());
    let id_hex = hex::encode(id_hash);
    let msg = secp256k1::Message::from_digest_slice(id_hash.as_ref()).map_err(|e| e.to_string())?;
    let keypair = secp256k1::Keypair::from_secret_key(&secp, sk);
    let sig = secp.sign_schnorr_no_aux_rand(&msg, &keypair);
    let sig_hex = hex::encode(sig.serialize());
    Ok((id_hex, pubkey_hex, created_at, sig_hex))
}

fn run_post(args: &[String]) -> Result<(), String> {
    let mut content: Option<String> = None;
    let mut privkey_hex: Option<String> = None;
    let mut output_path: Option<&str> = None;
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if a == "--privkey-hex" {
            i += 1;
            privkey_hex = Some(
                args.get(i)
                    .ok_or("missing value for --privkey-hex")?
                    .clone(),
            );
        } else if a == "--output" {
            i += 1;
            output_path = Some(args.get(i).ok_or("missing value for --output")?);
        } else if !a.starts_with('-') && content.is_none() {
            content = Some(a.clone());
        }
        i += 1;
    }
    let content = content.ok_or("post requires content (e.g. post \"Hello world\")")?;
    let content_with_suffix = ensure_stegstr_suffix(&content);
    let sk = if let Some(hex) = privkey_hex {
        let bytes = hex::decode(hex.trim()).map_err(|e| e.to_string())?;
        secp256k1::SecretKey::from_slice(&bytes).map_err(|e| e.to_string())?
    } else {
        secp256k1::SecretKey::new(&mut rand::thread_rng())
    };
    let (id_hex, pubkey_hex, created_at, sig_hex) = create_kind1_event(&content_with_suffix, &sk)?;
    let event = serde_json::json!({
        "id": id_hex,
        "pubkey": pubkey_hex,
        "created_at": created_at,
        "kind": 1,
        "tags": [],
        "content": content_with_suffix,
        "sig": sig_hex
    });
    let bundle = serde_json::json!({
        "version": 1,
        "events": [event]
    });
    let json = serde_json::to_string_pretty(&bundle).map_err(|e| e.to_string())?;
    if let Some(path) = output_path {
        fs::write(path, &json).map_err(|e| e.to_string())?;
        eprintln!("Wrote {}", path);
    } else {
        io::stdout()
            .write_all(json.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
