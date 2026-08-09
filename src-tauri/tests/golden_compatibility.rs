use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const PAYLOAD: [u8; 32] = [
    0x7b, 0x98, 0x92, 0x09, 0x4d, 0xae, 0xad, 0x70, 0x72, 0x51, 0x5e, 0x35, 0x7a, 0xaa, 0xea, 0xc7,
    0x11, 0x90, 0xa2, 0x3d, 0xc9, 0x36, 0x2b, 0x72, 0xb5, 0x87, 0xe4, 0x59, 0x41, 0x35, 0xbc, 0xd2,
];

fn golden(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("benchmarks")
        .join("golden")
        .join(name)
}

fn assert_hash(name: &str, expected: &str) {
    let bytes = std::fs::read(golden(name)).expect("read golden artifact");
    assert_eq!(hex::encode(Sha256::digest(bytes)), expected);
}

#[test]
fn rust_dwt_golden_vector_decodes_exactly() {
    assert_hash(
        "rust-dwt.png",
        "369c1921e04fac7699b92351ffc5fc060e44b71c9e47de56a397c64ac5a88d09",
    );
    assert_eq!(
        stegstr_lib::stego::decode(&golden("rust-dwt.png")).unwrap(),
        PAYLOAD
    );
}

#[test]
fn rust_dot_golden_vector_decodes_exactly() {
    assert_hash(
        "rust-dot.png",
        "d4042848d96c24082aa6f57cc208fb11af0cd791d2f7b262dfb2d2e359cb0098",
    );
    assert_eq!(
        stegstr_lib::stego_dot::decode(&golden("rust-dot.png")).unwrap(),
        PAYLOAD
    );
}

#[test]
fn typescript_dot_vector_is_not_rust_dot_compatible() {
    assert_hash(
        "typescript-dot.png",
        "daf1302dd1bfd30da03b68100a17ab236d5bc05e50d8f03eae44cbdb1e6ac07a",
    );
    assert!(stegstr_lib::stego_dot::decode(&golden("typescript-dot.png")).is_err());
}
