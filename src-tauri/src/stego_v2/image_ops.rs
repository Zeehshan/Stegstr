use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::metadata::Orientation;
use image::{ExtendedColorType, ImageDecoder, ImageReader, Rgb, RgbImage};
use std::io::Cursor;
use std::path::Path;

pub(crate) const MAX_PIXELS: u64 = 24_000_000;
pub(crate) const MAX_DIMENSION: u32 = 8192;

pub(crate) fn load_oriented(path: &Path) -> Result<RgbImage, String> {
    let reader = ImageReader::open(path).map_err(|e| e.to_string())?;
    let mut decoder = reader.into_decoder().map_err(|e| e.to_string())?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut image = image::DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
    image.apply_orientation(orientation);
    let rgb = image.to_rgb8();
    validate_dimensions(rgb.width(), rgb.height())?;
    Ok(rgb)
}

pub(crate) fn validate_dimensions(width: u32, height: u32) -> Result<(), String> {
    if width < 64 || height < 64 {
        return Err("robust-v2 requires an image of at least 64x64".to_string());
    }
    if width > MAX_DIMENSION || height > MAX_DIMENSION {
        return Err(format!("robust-v2 image dimension exceeds {MAX_DIMENSION}"));
    }
    if width as u64 * height as u64 > MAX_PIXELS {
        return Err(format!("robust-v2 image exceeds {MAX_PIXELS} pixels"));
    }
    Ok(())
}

pub(crate) fn resize(image: &RgbImage, width: u32, height: u32) -> RgbImage {
    image::imageops::resize(image, width, height, FilterType::Lanczos3)
}

pub(crate) fn luminance(image: &RgbImage) -> Vec<f32> {
    image
        .pixels()
        .map(|pixel| 0.299 * pixel[0] as f32 + 0.587 * pixel[1] as f32 + 0.114 * pixel[2] as f32)
        .collect()
}

pub(crate) fn apply_luminance(
    image: &RgbImage,
    original_y: &[f32],
    modified_y: &[f32],
) -> RgbImage {
    let mut output = image.clone();
    for (index, pixel) in output.pixels_mut().enumerate() {
        let difference = modified_y[index] - original_y[index];
        for channel in 0..3 {
            pixel[channel] = (pixel[channel] as f32 + difference)
                .round()
                .clamp(0.0, 255.0) as u8;
        }
    }
    output
}

pub(crate) fn merge_canonical_difference(
    original: &RgbImage,
    canonical: &RgbImage,
    modified: &RgbImage,
) -> RgbImage {
    let mut centered = RgbImage::new(canonical.width(), canonical.height());
    for ((target, before), after) in centered
        .pixels_mut()
        .zip(canonical.pixels())
        .zip(modified.pixels())
    {
        for channel in 0..3 {
            target[channel] =
                (after[channel] as i16 - before[channel] as i16 + 128).clamp(0, 255) as u8;
        }
    }
    let expanded = resize(&centered, original.width(), original.height());
    let mut output = original.clone();
    for (target, difference) in output.pixels_mut().zip(expanded.pixels()) {
        for channel in 0..3 {
            target[channel] =
                (target[channel] as i16 + difference[channel] as i16 - 128).clamp(0, 255) as u8;
        }
    }
    output
}

pub(crate) fn encode_jpeg(image: &RgbImage, quality: u8) -> Result<Vec<u8>, String> {
    let mut output = Cursor::new(Vec::new());
    JpegEncoder::new_with_quality(&mut output, quality)
        .encode(
            image.as_raw(),
            image.width(),
            image.height(),
            ExtendedColorType::Rgb8,
        )
        .map_err(|e| e.to_string())?;
    Ok(output.into_inner())
}

pub(crate) fn crop_phase(image: &RgbImage, offset_x: u32, offset_y: u32) -> RgbImage {
    if offset_x == 0 && offset_y == 0 {
        return image.clone();
    }
    let width = image.width().saturating_sub(offset_x).max(1);
    let height = image.height().saturating_sub(offset_y).max(1);
    image::imageops::crop_imm(image, offset_x, offset_y, width, height).to_image()
}

#[allow(dead_code)]
fn _rgb_type_marker(_: Rgb<u8>) {}
