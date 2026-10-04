pub mod stego;
pub mod stego_crypto;
pub mod stego_dot;
pub mod stego_v2;
pub mod native_keys;

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

/// Normalize path: strip file:// prefix if present (e.g. from some dialogs)
fn normalize_path(s: &str) -> &str {
    s.trim_start_matches("file://")
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StegoDecodeResult {
    pub ok: bool,
    pub payload: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StegoEncodeResult {
    pub ok: bool,
    pub path: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
fn decode_stego_image(path: String) -> Result<StegoDecodeResult, String> {
    let p = normalize_path(&path);
    match stego::decode(std::path::Path::new(p)) {
        Ok(payload) => {
            let payload_str = match String::from_utf8(payload.clone()) {
                Ok(s) if s.trim_start().starts_with('{') => s,
                _ => format!("base64:{}", base64::engine::general_purpose::STANDARD.encode(&payload)),
            };
            Ok(StegoDecodeResult {
                ok: true,
                payload: Some(payload_str),
                error: None,
            })
        }
        Err(e) => Ok(StegoDecodeResult {
            ok: false,
            payload: None,
            error: Some(e),
        }),
    }
}

#[tauri::command]
fn decode_stego_dot(path: String) -> Result<StegoDecodeResult, String> {
    let p = normalize_path(&path);
    match stego_dot::decode(std::path::Path::new(p)) {
        Ok(payload) => {
            let payload_str = match String::from_utf8(payload.clone()) {
                Ok(s) if s.trim_start().starts_with('{') => s,
                _ => format!("base64:{}", base64::engine::general_purpose::STANDARD.encode(&payload)),
            };
            Ok(StegoDecodeResult {
                ok: true,
                payload: Some(payload_str),
                error: None,
            })
        }
        Err(e) => Ok(StegoDecodeResult {
            ok: false,
            payload: None,
            error: Some(e),
        }),
    }
}

#[tauri::command]
fn decode_stego_robust_v2(path: String) -> Result<StegoDecodeResult, String> {
    let p = normalize_path(&path);
    match stego_v2::decode(std::path::Path::new(p)) {
        Ok(result) => Ok(StegoDecodeResult {
            ok: true,
            payload: Some(format!("base64:{}", base64::engine::general_purpose::STANDARD.encode(result.payload))),
            error: None,
        }),
        Err(e) => Ok(StegoDecodeResult {
            ok: false,
            payload: None,
            error: Some(e),
        }),
    }
}

#[tauri::command]
fn get_robust_v2_capacity(path: String) -> Result<usize, String> {
    let p = normalize_path(&path);
    let (width, height) = image::image_dimensions(p).map_err(|e| e.to_string())?;
    Ok(stego_v2::capacity_for_dimensions(width, height, stego_v2::RobustnessProfile::Robust).usable_plaintext_capacity_bytes)
}

#[tauri::command]
fn encode_stego_robust_v2(cover_path: String, output_path: String, payload: String) -> Result<StegoEncodeResult, String> {
    let cover = normalize_path(&cover_path);
    let output = normalize_path(&output_path);
    let encoded_payload = payload.strip_prefix("base64:")
        .ok_or_else(|| "robust-v2 payload must be base64 encoded".to_string())?;
    let payload_bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded_payload.trim())
        .map_err(|e| e.to_string())?;
    match stego_v2::encode(std::path::Path::new(cover), &payload_bytes, stego_v2::RobustnessProfile::Robust) {
        Ok(encoded) => {
            std::fs::write(output, encoded).map_err(|e| e.to_string())?;
            Ok(StegoEncodeResult { ok: true, path: Some(output.to_string()), error: None })
        }
        Err(e) => Ok(StegoEncodeResult { ok: false, path: None, error: Some(e) }),
    }
}

#[tauri::command]
fn encode_stego_image(cover_path: String, output_path: String, payload: String) -> Result<StegoEncodeResult, String> {
    let cover = normalize_path(&cover_path);
    let output = normalize_path(&output_path);
    let payload_bytes: Vec<u8> = if payload.starts_with("base64:") {
        base64::engine::general_purpose::STANDARD
            .decode(payload.trim_start_matches("base64:").as_bytes())
            .map_err(|e| e.to_string())?
    } else {
        payload.into_bytes()
    };
    let encode_result = stego::encode(std::path::Path::new(cover), &payload_bytes);
    match encode_result {
        Ok(png_bytes) => {
            std::fs::write(output, png_bytes).map_err(|e| e.to_string())?;
            Ok(StegoEncodeResult {
                ok: true,
                path: Some(output.to_string()),
                error: None,
            })
        }
        Err(e) => Ok(StegoEncodeResult {
            ok: false,
            path: None,
            error: Some(e),
        }),
    }
}

#[tauri::command]
fn encode_stego_dot(cover_path: String, output_path: String, payload: String) -> Result<StegoEncodeResult, String> {
    let cover = normalize_path(&cover_path);
    let output_raw = normalize_path(&output_path);
    let output_path_buf = std::path::Path::new(output_raw).with_extension("png");
    let output = output_path_buf.to_string_lossy().to_string();
    let payload_bytes: Vec<u8> = if payload.starts_with("base64:") {
        base64::engine::general_purpose::STANDARD
            .decode(payload.trim_start_matches("base64:").as_bytes())
            .map_err(|e| e.to_string())?
    } else {
        payload.into_bytes()
    };
    let encode_result = stego_dot::encode(std::path::Path::new(cover), &payload_bytes);
    match encode_result {
        Ok(png_bytes) => {
            std::fs::write(output.clone(), png_bytes).map_err(|e| e.to_string())?;
            let sig = std::fs::read(&output).map_err(|e| e.to_string())?;
            if sig.len() < 8 || sig[..8] != [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] {
                return Ok(StegoEncodeResult {
                    ok: false,
                    path: None,
                    error: Some("Dot encoder output is not PNG".to_string()),
                });
            }
            Ok(StegoEncodeResult {
                ok: true,
                path: Some(output.to_string()),
                error: None,
            })
        }
        Err(e) => Ok(StegoEncodeResult {
            ok: false,
            path: None,
            error: Some(e),
        }),
    }
}

#[tauri::command]
fn check_png_signature(path: String) -> Result<bool, String> {
    let p = normalize_path(&path);
    let sig = std::fs::read(p).map_err(|e| e.to_string())?;
    Ok(sig.len() >= 8 && sig[..8] == [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
}

#[tauri::command]
fn get_dot_capacity(path: String) -> Result<usize, String> {
    let p = normalize_path(&path);
    stego_dot::max_payload_bytes(std::path::Path::new(p))
}
#[tauri::command]
fn stegstr_log(
    level: String,
    action: String,
    message: String,
    details: Option<String>,
    error: Option<String>,
    stack: Option<String>,
) -> Result<(), String> {
    use std::io::Write;
    let log_dir = dirs::data_local_dir()
        .or_else(dirs::home_dir)
        .ok_or("no log dir")?
        .join("Stegstr");
    let _ = std::fs::create_dir_all(&log_dir);
    let log_path = log_dir.join("stegstr.log");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| e.to_string())?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    let line = serde_json::json!({
        "ts": ts,
        "level": level,
        "action": action,
        "message": message,
        "details": details,
        "error": error,
        "stack": stack,
    });
    writeln!(file, "{}", line).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_exchange_path() -> Result<String, String> {
    let dir = std::env::temp_dir().join("stegstr-test-exchange");
    let _ = std::fs::create_dir_all(&dir);
    Ok(dir.join("exchange.png").to_string_lossy().to_string())
}

#[tauri::command]
fn get_exchange_path_qim() -> Result<String, String> {
    let dir = std::env::temp_dir().join("stegstr-test-exchange");
    let _ = std::fs::create_dir_all(&dir);
    Ok(dir.join("exchange.jpg").to_string_lossy().to_string())
}

#[tauri::command]
fn get_test_profile() -> Option<String> {
    std::env::var("STEGSTR_TEST_PROFILE").ok().filter(|s| !s.is_empty())
}

#[tauri::command]
fn get_desktop_path() -> Result<String, String> {
    dirs::desktop_dir()
        .and_then(|p| p.into_os_string().into_string().ok())
        .ok_or_else(|| "Could not get Desktop path".to_string())
}

fn qim_cli_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("channel_simulator")
        .join("qim_cli.py")
}

#[tauri::command]
fn encode_stego_qim(cover_path: String, output_path: String, payload: String) -> Result<StegoEncodeResult, String> {
    let cover = normalize_path(&cover_path);
    let output = normalize_path(&output_path);
    let qim_cli = qim_cli_path();
    if !qim_cli.exists() {
        return Ok(StegoEncodeResult {
            ok: false,
            path: None,
            error: Some(format!(
                "QIM script not found at {}. Install channel_simulator deps: pip install jpeglib reedsolo numpy",
                qim_cli.display()
            )),
        });
    }
    let payload_b64 = if payload.starts_with("base64:") {
        payload.trim_start_matches("base64:").to_string()
    } else {
        base64::engine::general_purpose::STANDARD.encode(payload.as_bytes())
    };
    let output_buf = std::process::Command::new("python3")
        .arg(&qim_cli)
        .arg("encode")
        .arg(cover)
        .arg(output)
        .arg(&payload_b64)
        .output()
        .map_err(|e| format!("QIM encode failed: {}", e))?;
    if !output_buf.status.success() {
        let err = String::from_utf8_lossy(&output_buf.stderr);
        return Ok(StegoEncodeResult {
            ok: false,
            path: None,
            error: Some(format!("QIM encode failed: {}", err.trim())),
        });
    }
    Ok(StegoEncodeResult {
        ok: true,
        path: Some(output.to_string()),
        error: None,
    })
}

#[tauri::command]
fn decode_stego_qim(path: String) -> Result<StegoDecodeResult, String> {
    let p = normalize_path(&path);
    let qim_cli = qim_cli_path();
    if !qim_cli.exists() {
        return Ok(StegoDecodeResult {
            ok: false,
            payload: None,
            error: Some(format!(
                "QIM script not found at {}. Install channel_simulator deps: pip install jpeglib reedsolo numpy",
                qim_cli.display()
            )),
        });
    }
    let (tx, rx) = mpsc::channel();
    let qim_cli = qim_cli.clone();
    let p_owned = p.to_string();
    thread::spawn(move || {
        let out = std::process::Command::new("python3")
            .arg(&qim_cli)
            .arg("decode")
            .arg(&p_owned)
            .output();
        let _ = tx.send(out);
    });
    let output_buf = match rx.recv_timeout(Duration::from_secs(30)) {
        Ok(Ok(buf)) => buf,
        Ok(Err(e)) => {
            return Ok(StegoDecodeResult {
                ok: false,
                payload: None,
                error: Some(format!("QIM decode failed: {}", e)),
            });
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            return Ok(StegoDecodeResult {
                ok: false,
                payload: None,
                error: Some("QIM decode timed out after 30 seconds".to_string()),
            });
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            return Ok(StegoDecodeResult {
                ok: false,
                payload: None,
                error: Some("QIM decode thread disconnected".to_string()),
            });
        }
    };
    let stderr_str = String::from_utf8_lossy(&output_buf.stderr);
    if !output_buf.status.success() {
        return Ok(StegoDecodeResult {
            ok: false,
            payload: None,
            error: Some(format!("QIM decode failed: {}", stderr_str.trim())),
        });
    }
    let payload_b64 = String::from_utf8_lossy(&output_buf.stdout).trim().to_string();
    let payload_bytes = base64::engine::general_purpose::STANDARD
        .decode(&payload_b64)
        .map_err(|e| format!("QIM payload decode error: {} (stderr: {})", e, stderr_str.trim()))?;
    let payload_str = format!("base64:{}", base64::engine::general_purpose::STANDARD.encode(&payload_bytes));
    Ok(StegoDecodeResult {
        ok: true,
        payload: Some(payload_str),
        error: None,
    })
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").args(["-R", &path]).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let _ = path;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            decode_stego_image,
            encode_stego_image,
            decode_stego_dot,
            encode_stego_dot,
            decode_stego_robust_v2,
            encode_stego_robust_v2,
            get_robust_v2_capacity,
            get_dot_capacity,
            check_png_signature,
            decode_stego_qim,
            encode_stego_qim,
            get_desktop_path,
            get_test_profile,
            get_exchange_path,
            get_exchange_path_qim,
            reveal_in_finder,
            stegstr_log,
            native_keys::native_key_create,
            native_keys::native_key_import,
            native_keys::native_key_lookup,
            native_keys::native_sign_event,
            native_keys::native_nip04_encrypt,
            native_keys::native_nip04_decrypt,
            native_keys::native_key_export,
            native_keys::native_key_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod command_tests {
    use super::*;

    #[test]
    fn robust_v2_tauri_adapters_round_trip() {
        let suffix = std::process::id();
        let cover = std::env::temp_dir().join(format!("stegstr-command-cover-{suffix}.png"));
        let output = std::env::temp_dir().join(format!("stegstr-command-output-{suffix}.jpg"));
        let mut image = image::RgbImage::new(640, 480);
        for (index, pixel) in image.pixels_mut().enumerate() {
            let x = (index as u32 % 640) as u8;
            let y = (index as u32 / 640) as u8;
            *pixel = image::Rgb([x.wrapping_mul(3).wrapping_add(y), y.wrapping_mul(5), x ^ y]);
        }
        image.save(&cover).unwrap();
        let payload = b"tauri robust-v2 adapter";
        let encoded_payload = format!("base64:{}", base64::engine::general_purpose::STANDARD.encode(payload));
        let result = encode_stego_robust_v2(cover.to_string_lossy().to_string(), output.to_string_lossy().to_string(), encoded_payload).unwrap();
        assert!(result.ok);
        let decoded = decode_stego_robust_v2(output.to_string_lossy().to_string()).unwrap();
        assert_eq!(decoded.payload.unwrap(), format!("base64:{}", base64::engine::general_purpose::STANDARD.encode(payload)));
        let _ = std::fs::remove_file(cover);
        let _ = std::fs::remove_file(output);
    }
}
