use super::capacity;
use super::frame;
use super::image_ops;
use super::profile::RobustnessProfile;
use super::qim;
use super::{canonical_dimensions, PILOT_BITS, PILOT_REPEAT};
use std::path::Path;

pub(crate) fn pilot_pattern() -> Vec<u8> {
    let mut state = 0xa5c3_71d9u32;
    let mut bits = Vec::with_capacity(PILOT_BITS);
    for _ in 0..PILOT_BITS {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        bits.push((state & 1) as u8);
    }
    bits
}

pub(crate) fn bytes_to_bits(bytes: &[u8]) -> Vec<u8> {
    let mut bits = Vec::with_capacity(bytes.len() * 8);
    for byte in bytes {
        for shift in (0..8).rev() {
            bits.push((byte >> shift) & 1);
        }
    }
    bits
}

pub(crate) fn repeat_bits(bits: &[u8], repeat: usize) -> Vec<u8> {
    let mut repeated = Vec::with_capacity(bits.len() * repeat);
    for bit in bits {
        repeated.extend(std::iter::repeat_n(*bit, repeat));
    }
    repeated
}

pub(crate) fn build_stream(encoded: &frame::EncodedFrame) -> Vec<u8> {
    let config = encoded.header.profile.config();
    let pilot = repeat_bits(&pilot_pattern(), PILOT_REPEAT);
    let header = repeat_bits(&bytes_to_bits(&encoded.header_bytes), config.header_repeat);
    let payload = repeat_bits(&bytes_to_bits(&encoded.packets), config.payload_repeat);
    let mut stream = Vec::with_capacity(pilot.len() + header.len() + payload.len());
    stream.extend_from_slice(&pilot);
    stream.extend_from_slice(&header);
    stream.extend_from_slice(&payload);
    stream
}

pub fn encode(
    image_path: &Path,
    payload: &[u8],
    profile: RobustnessProfile,
) -> Result<Vec<u8>, String> {
    let original = image_ops::load_oriented(image_path)?;
    let (canonical_width, canonical_height) =
        canonical_dimensions(original.width(), original.height(), profile);
    let report = capacity::for_dimensions(canonical_width, canonical_height, profile);
    let encoded = frame::encode(
        payload,
        profile,
        canonical_width as u16,
        canonical_height as u16,
    )?;
    let stream = build_stream(&encoded);
    if stream.len() > report.raw_carrier_bits {
        return Err(format!(
            "robust-v2 payload too large for {} profile: need {} embedded bits, carrier has {} (reported usable plaintext capacity {} bytes)",
            profile.as_str(),
            stream.len(),
            report.raw_carrier_bits,
            report.usable_plaintext_capacity_bytes
        ));
    }

    let canonical = image_ops::resize(&original, canonical_width, canonical_height);
    let original_y = image_ops::luminance(&canonical);
    let mut modified_y = original_y.clone();
    qim::embed_bits(
        &mut modified_y,
        canonical_width,
        canonical_height,
        profile,
        &stream,
        PILOT_BITS * PILOT_REPEAT + frame::HEADER_LEN * 8 * profile.config().header_repeat,
    )?;
    let modified_canonical = image_ops::apply_luminance(&canonical, &original_y, &modified_y);
    let output = image_ops::merge_canonical_difference(&original, &canonical, &modified_canonical);
    image_ops::encode_jpeg(&output, 95)
}
