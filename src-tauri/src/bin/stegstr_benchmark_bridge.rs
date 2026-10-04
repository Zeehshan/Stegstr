//! Narrow process bridge used by the Phase 2 benchmark.
//!
//! This binary intentionally delegates to the production encoders/decoders. It
//! contains no steganography logic, so benchmark results cannot silently drift
//! away from the application implementation.

use std::env;
use std::fs;
use std::path::Path;

fn usage() -> &'static str {
    "usage: stegstr-benchmark-bridge <encode|decode> <rust-dwt|rust-dot|robust-v2> <input> <payload-or-output> [output]\n       stegstr-benchmark-bridge suitability <input>"
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().collect();
    if args.len() == 3 && args[1] == "suitability" {
        let report = stegstr_lib::stego_v2::assess_carrier(Path::new(&args[2]))?;
        println!(
            "{}",
            serde_json::to_string(&report).map_err(|e| e.to_string())?
        );
        return Ok(());
    }
    if args.len() < 5 {
        return Err(usage().to_string());
    }
    let operation = args[1].as_str();
    let algorithm = args[2].as_str();
    let input = Path::new(&args[3]);

    match operation {
        "encode" => {
            if args.len() != 6 {
                return Err(usage().to_string());
            }
            let payload = fs::read(&args[4]).map_err(|e| e.to_string())?;
            let encoded = match algorithm {
                "rust-dwt" => stegstr_lib::stego::encode(input, &payload),
                "rust-dot" => stegstr_lib::stego_dot::encode(input, &payload),
                "robust-v2" => stegstr_lib::stego_v2::encode(
                    input,
                    &payload,
                    stegstr_lib::stego_v2::RobustnessProfile::Robust,
                ),
                _ => Err(format!("unknown algorithm: {algorithm}")),
            }?;
            fs::write(&args[5], encoded).map_err(|e| e.to_string())?;
        }
        "decode" => {
            if args.len() != 5 {
                return Err(usage().to_string());
            }
            let decoded = match algorithm {
                "rust-dwt" => stegstr_lib::stego::decode(input),
                "rust-dot" => stegstr_lib::stego_dot::decode(input),
                "robust-v2" => stegstr_lib::stego_v2::decode(input).map(|result| result.payload),
                _ => Err(format!("unknown algorithm: {algorithm}")),
            }?;
            fs::write(&args[4], decoded).map_err(|e| e.to_string())?;
        }
        _ => return Err(usage().to_string()),
    }
    Ok(())
}
