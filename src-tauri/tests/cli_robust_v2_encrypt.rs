// Regression test: `stegstr-cli embed --mode robust-v2 --encrypt` was previously rejected
// with "robust-v2 --encrypt is not enabled until compression-before-encryption is wired".
// The desktop app already produces encrypted robust-v2 images (App.tsx encrypts the bundle
// with stego-crypto.ts's STEGSTR1 AES-GCM format before calling encode_stego_robust_v2), so
// the CLI only needed to stop rejecting the combination and reuse the same app-layer
// encrypt/decrypt helpers. This test drives the actual built binary end-to-end.

use std::process::Command;

fn cli() -> Command {
    Command::new(env!("CARGO_BIN_EXE_stegstr-cli"))
}

#[test]
fn embed_and_decode_robust_v2_with_encrypt_round_trips() {
    let dir = std::env::temp_dir();
    let suffix = std::process::id();
    let cover = dir.join(format!("cli-rv2-encrypt-cover-{suffix}.png"));
    let output = dir.join(format!("cli-rv2-encrypt-output-{suffix}.jpg"));

    // Build a small deterministic cover image.
    let mut image = image::RgbImage::new(640, 480);
    for (index, pixel) in image.pixels_mut().enumerate() {
        let x = (index as u32 % 640) as u8;
        let y = (index as u32 / 640) as u8;
        *pixel = image::Rgb([x.wrapping_mul(3).wrapping_add(y), y.wrapping_mul(5), x ^ y]);
    }
    image.save(&cover).unwrap();

    let payload = r#"{"version":1,"events":[]}"#;

    let embed_status = cli()
        .args([
            "embed",
            cover.to_str().unwrap(),
            "-o",
            output.to_str().unwrap(),
            "--payload",
            payload,
            "--mode",
            "robust-v2",
            "--encrypt",
        ])
        .status()
        .expect("failed to run stegstr-cli embed");
    assert!(embed_status.success(), "embed with --mode robust-v2 --encrypt should no longer be rejected");

    // Raw decode (no --decrypt) must return the opaque STEGSTR1 ciphertext, not the plaintext.
    let raw = cli()
        .args(["decode", output.to_str().unwrap()])
        .output()
        .expect("failed to run stegstr-cli decode");
    assert!(raw.status.success());
    let raw_stdout = String::from_utf8_lossy(&raw.stdout);
    assert!(!raw_stdout.contains("events"), "raw decode of an encrypted image should not leak plaintext");

    // Decrypted decode must recover the exact original bundle JSON.
    let decrypted = cli()
        .args(["decode", output.to_str().unwrap(), "--decrypt"])
        .output()
        .expect("failed to run stegstr-cli decode --decrypt");
    assert!(
        decrypted.status.success(),
        "decode --decrypt on a robust-v2 encrypted image should succeed: {}",
        String::from_utf8_lossy(&decrypted.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&decrypted.stdout), payload);

    // `detect` (used by AI agents per skill/stegstr/SKILL.md) auto-decrypts too.
    let detect = cli()
        .args(["detect", output.to_str().unwrap()])
        .output()
        .expect("failed to run stegstr-cli detect");
    assert!(detect.status.success());
    assert_eq!(String::from_utf8_lossy(&detect.stdout), payload);

    let _ = std::fs::remove_file(cover);
    let _ = std::fs::remove_file(output);
}
