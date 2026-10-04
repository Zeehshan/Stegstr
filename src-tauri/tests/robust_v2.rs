use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::imageops::FilterType;
use image::{ExtendedColorType, ImageEncoder, Rgb, RgbImage};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use stegstr_lib::stego_v2::{self, RobustnessProfile};

fn path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("stegstr-v2-{}-{name}", std::process::id()))
}

fn carrier() -> RgbImage {
    let mut image = RgbImage::new(640, 480);
    for (index, pixel) in image.pixels_mut().enumerate() {
        let x = (index as u32 % 640) as u8;
        let y = (index as u32 / 640) as u8;
        let texture = ((index * 73 + 19) & 31) as u8;
        *pixel = Rgb([
            x.wrapping_mul(3).wrapping_add(y).wrapping_add(texture),
            y.wrapping_mul(5).wrapping_add(x / 2),
            (x ^ y).wrapping_add(texture / 2),
        ]);
    }
    image
}

fn write_png(image: &RgbImage, output: &Path) {
    let mut bytes = Vec::new();
    PngEncoder::new(&mut bytes)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            ExtendedColorType::Rgb8,
        )
        .unwrap();
    std::fs::write(output, bytes).unwrap();
}

fn jpeg_bytes(image: &RgbImage, quality: u8) -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    JpegEncoder::new_with_quality(&mut bytes, quality)
        .encode(
            image.as_raw(),
            image.width(),
            image.height(),
            ExtendedColorType::Rgb8,
        )
        .unwrap();
    bytes.into_inner()
}

fn assert_decode(bytes: &[u8], filename: &str, payload: &[u8]) {
    let output = path(filename);
    std::fs::write(&output, bytes).unwrap();
    let decoded =
        stego_v2::decode(&output).unwrap_or_else(|error| panic!("{filename} failed: {error}"));
    assert_eq!(decoded.payload, payload);
    assert_eq!(decoded.profile, RobustnessProfile::Robust);
    let _ = std::fs::remove_file(output);
}

#[test]
fn robust_v2_survives_clean_jpeg_resize_and_combined_channels() {
    let cover = path("cover.png");
    write_png(&carrier(), &cover);
    let payload = b"robust-v2 transformation compatibility";
    let encoded = stego_v2::encode(&cover, payload, RobustnessProfile::Robust).unwrap();
    assert_decode(&encoded, "clean.jpg", payload);

    let embedded = image::load_from_memory(&encoded).unwrap().to_rgb8();
    assert_decode(&jpeg_bytes(&embedded, 80), "jpeg80.jpg", payload);

    let resized_75 = image::imageops::resize(&embedded, 480, 360, FilterType::Lanczos3);
    let mut resized_png = Vec::new();
    PngEncoder::new(&mut resized_png)
        .write_image(
            resized_75.as_raw(),
            resized_75.width(),
            resized_75.height(),
            ExtendedColorType::Rgb8,
        )
        .unwrap();
    assert_decode(&resized_png, "resize75.png", payload);
    assert_decode(&jpeg_bytes(&resized_75, 80), "resize75-jpeg80.jpg", payload);
    let _ = std::fs::remove_file(cover);
}

#[test]
fn robust_v2_corrupt_blocks_never_return_corrupt_payload() {
    let cover = path("corruption-cover.png");
    write_png(&carrier(), &cover);
    let payload = b"integrity must be exact";
    let encoded = stego_v2::encode(&cover, payload, RobustnessProfile::Robust).unwrap();
    let mut damaged = image::load_from_memory(&encoded).unwrap().to_rgb8();
    for block in 0..3u32 {
        let start_x = 80 + block * 144;
        let start_y = 64 + block * 96;
        for y in start_y..start_y + 16 {
            for x in start_x..start_x + 16 {
                damaged.put_pixel(x, y, Rgb([0, 0, 0]));
            }
        }
    }
    let damaged_bytes = jpeg_bytes(&damaged, 92);
    let output = path("corrupt-blocks.jpg");
    std::fs::write(&output, damaged_bytes).unwrap();
    match stego_v2::decode(&output) {
        Ok(result) => assert_eq!(result.payload, payload),
        Err(error) => assert!(error.contains("robust-v2 decode failed")),
    }
    let _ = std::fs::remove_file(cover);
    let _ = std::fs::remove_file(output);
}

#[test]
fn robust_v2_capacity_boundary_rejects_before_embedding() {
    let cover = path("capacity-cover.png");
    write_png(&carrier(), &cover);
    let report = stego_v2::capacity_for_dimensions(640, 480, RobustnessProfile::Robust);
    let mut payload = vec![0u8; report.usable_plaintext_capacity_bytes + 256];
    let mut state = 0x72a5_19c3u32;
    for byte in &mut payload {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        *byte = state as u8;
    }
    let error = stego_v2::encode(&cover, &payload, RobustnessProfile::Robust).unwrap_err();
    assert!(error.contains("payload too large"));
    let _ = std::fs::remove_file(cover);
}
