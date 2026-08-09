mod capacity;
mod dct;
mod decode;
mod embed;
mod fec;
mod frame;
mod image_ops;
mod profile;
mod qim;

pub use capacity::CapacityReport;
pub use profile::RobustnessProfile;

pub use decode::{decode, DecodeResult};
pub use embed::encode;

pub(crate) const PAIRS_PER_BLOCK: usize = 6;
pub(crate) const PILOT_BITS: usize = 64;
pub(crate) const PILOT_REPEAT: usize = 5;

pub fn capacity_for_dimensions(
    width: u32,
    height: u32,
    profile: RobustnessProfile,
) -> CapacityReport {
    let (canonical_width, canonical_height) = canonical_dimensions(width, height, profile);
    capacity::for_dimensions(canonical_width, canonical_height, profile)
}

pub(crate) fn canonical_dimensions(
    width: u32,
    height: u32,
    profile: RobustnessProfile,
) -> (u32, u32) {
    let target = profile.config().canonical_long_edge;
    let (mut w, mut h) = if width >= height {
        (
            target,
            ((height as f64 / width as f64) * target as f64).round() as u32,
        )
    } else {
        (
            ((width as f64 / height as f64) * target as f64).round() as u32,
            target,
        )
    };
    w = (w.max(64) / 8) * 8;
    h = (h.max(64) / 8) * 8;
    (w, h)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_clean_roundtrip_and_corruption_rejection() {
        let payload: Vec<u8> = (0..1024).map(|i| (i * 19) as u8).collect();
        let encoded = frame::encode(&payload, RobustnessProfile::Robust, 1024, 768).unwrap();
        assert_eq!(
            frame::decode(&encoded.header_bytes, &encoded.packets).unwrap(),
            payload
        );

        let mut bad_header = encoded.header_bytes.clone();
        bad_header[22] ^= 1;
        assert!(frame::decode(&bad_header, &encoded.packets).is_err());

        let mut bad_packets = encoded.packets.clone();
        for byte in bad_packets.iter_mut().take(20) {
            *byte ^= 0x55;
        }
        assert!(frame::decode(&encoded.header_bytes, &bad_packets).is_ok());

        bad_packets.truncate(bad_packets.len() / 3);
        assert!(frame::decode(&encoded.header_bytes, &bad_packets).is_err());
    }

    #[test]
    fn canonical_grid_preserves_aspect_and_block_alignment() {
        let (w, h) = canonical_dimensions(1920, 1080, RobustnessProfile::Robust);
        assert_eq!((w, h), (1024, 576));
        assert_eq!(w % 8, 0);
        assert_eq!(h % 8, 0);
    }

    #[test]
    fn clean_image_roundtrip() {
        use image::ImageEncoder;

        let mut carrier = image::RgbImage::new(640, 480);
        for (index, pixel) in carrier.pixels_mut().enumerate() {
            let x = (index as u32 % 640) as u8;
            let y = (index as u32 / 640) as u8;
            *pixel = image::Rgb([
                x.wrapping_mul(3).wrapping_add(y),
                y.wrapping_mul(5).wrapping_add(x / 2),
                x ^ y,
            ]);
        }
        let suffix = std::process::id();
        let cover = std::env::temp_dir().join(format!("stegstr-v2-cover-{suffix}.png"));
        let output = std::env::temp_dir().join(format!("stegstr-v2-output-{suffix}.jpg"));
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(
                carrier.as_raw(),
                carrier.width(),
                carrier.height(),
                image::ExtendedColorType::Rgb8,
            )
            .unwrap();
        std::fs::write(&cover, png).unwrap();
        let payload = b"robust-v2 clean image roundtrip";
        let encoded = encode(&cover, payload, RobustnessProfile::Robust).unwrap();
        std::fs::write(&output, encoded).unwrap();
        let decoded = decode(&output).unwrap();
        assert_eq!(decoded.payload, payload);
        let _ = std::fs::remove_file(cover);
        let _ = std::fs::remove_file(output);
    }
}
