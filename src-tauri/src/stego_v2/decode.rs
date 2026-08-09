use super::embed::pilot_pattern;
use super::frame::{self, Header, HEADER_LEN};
use super::image_ops;
use super::profile::RobustnessProfile;
use super::qim;
use super::{canonical_dimensions, PILOT_BITS, PILOT_REPEAT};
use std::path::Path;

const MAX_SYNC_CANDIDATES: usize = 36;
const MIN_PILOT_SCORE: f32 = 0.68;

#[derive(Clone, Debug)]
pub struct DecodeResult {
    pub payload: Vec<u8>,
    pub profile: RobustnessProfile,
    pub sync_confidence: f32,
    pub candidates_tested: usize,
}

#[derive(Clone)]
struct Candidate {
    score: f32,
    profile: RobustnessProfile,
    width: u32,
    height: u32,
    offset_x: u32,
    offset_y: u32,
}

fn majority(bits: &[u8], repeat: usize) -> Vec<u8> {
    bits.chunks_exact(repeat)
        .map(|chunk| (chunk.iter().filter(|bit| **bit != 0).count() * 2 > repeat) as u8)
        .collect()
}

fn bits_to_bytes(bits: &[u8]) -> Vec<u8> {
    bits.chunks_exact(8)
        .map(|chunk| chunk.iter().fold(0u8, |byte, bit| (byte << 1) | (bit & 1)))
        .collect()
}

fn dimensions_for_candidate(
    received_width: u32,
    received_height: u32,
    profile: RobustnessProfile,
    long_edge_adjustment: i32,
) -> (u32, u32) {
    let (base_width, base_height) = canonical_dimensions(received_width, received_height, profile);
    let base_long = base_width.max(base_height) as i32;
    let target_long = (base_long + long_edge_adjustment).max(64) as u32;
    let (mut width, mut height) = if received_width >= received_height {
        (
            target_long,
            ((received_height as f64 / received_width as f64) * target_long as f64).round() as u32,
        )
    } else {
        (
            ((received_width as f64 / received_height as f64) * target_long as f64).round() as u32,
            target_long,
        )
    };
    width = (width.max(64) / 8) * 8;
    height = (height.max(64) / 8) * 8;
    (width, height)
}

fn candidate_luminance(
    image: &image::RgbImage,
    candidate: &Candidate,
) -> (image::RgbImage, Vec<f32>) {
    let phased = image_ops::crop_phase(image, candidate.offset_x, candidate.offset_y);
    let canonical = image_ops::resize(&phased, candidate.width, candidate.height);
    let y = image_ops::luminance(&canonical);
    (canonical, y)
}

pub fn decode(image_path: &Path) -> Result<DecodeResult, String> {
    let image = image_ops::load_oriented(image_path)?;
    let expected_pilot = pilot_pattern();
    let pilot_slots = PILOT_BITS * PILOT_REPEAT;
    let mut specifications = Vec::with_capacity(MAX_SYNC_CANDIDATES);
    // Fast path: resize-only transforms preserve aspect ratio and need neither
    // phase nor long-edge adjustment. Try all three profile bootstraps first.
    for profile in RobustnessProfile::ALL {
        let (width, height) = dimensions_for_candidate(image.width(), image.height(), profile, 0);
        specifications.push((profile, width, height, 0, 0));
    }
    // Bounded recovery path for one-pixel phase/rounding differences.
    for profile in RobustnessProfile::ALL {
        for adjustment in [-8, 0, 8] {
            let (width, height) =
                dimensions_for_candidate(image.width(), image.height(), profile, adjustment);
            for (offset_x, offset_y) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                if adjustment == 0 && offset_x == 0 && offset_y == 0 {
                    continue;
                }
                if specifications.len() >= MAX_SYNC_CANDIDATES {
                    break;
                }
                specifications.push((profile, width, height, offset_x, offset_y));
            }
        }
    }
    let mut errors = Vec::new();
    let mut tested = 0usize;
    for (profile, width, height, offset_x, offset_y) in specifications {
        tested += 1;
        let mut candidate = Candidate {
            score: 0.0,
            profile,
            width,
            height,
            offset_x,
            offset_y,
        };
        let (_, y) = candidate_luminance(&image, &candidate);
        let raw = qim::extract_bits(&y, width, height, profile, pilot_slots)?;
        let recovered = majority(&raw, PILOT_REPEAT);
        let matches = recovered
            .iter()
            .zip(expected_pilot.iter())
            .filter(|(actual, expected)| actual == expected)
            .count();
        candidate.score = matches as f32 / PILOT_BITS as f32;
        if candidate.score < MIN_PILOT_SCORE {
            continue;
        }
        let config = candidate.profile.config();
        let header_slots = HEADER_LEN * 8 * config.header_repeat;
        let prefix_slots = pilot_slots + header_slots;
        let prefix = qim::extract_bits(
            &y,
            candidate.width,
            candidate.height,
            candidate.profile,
            prefix_slots,
        )?;
        let header_bits = majority(&prefix[pilot_slots..], config.header_repeat);
        let header_bytes = bits_to_bytes(&header_bits);
        let header = match Header::parse(&header_bytes) {
            Ok(header) => header,
            Err(error) => {
                errors.push(error);
                continue;
            }
        };
        if header.profile != candidate.profile
            || header.canonical_width as u32 != candidate.width
            || header.canonical_height as u32 != candidate.height
        {
            errors.push(
                "robust-v2 recovered header does not match synchronization candidate".to_string(),
            );
            continue;
        }
        let packet_bits = header.packet_bytes as usize * 8;
        let total_slots = prefix_slots + packet_bits * config.payload_repeat;
        let stream = match qim::extract_bits(
            &y,
            candidate.width,
            candidate.height,
            candidate.profile,
            total_slots,
        ) {
            Ok(stream) => stream,
            Err(error) => {
                errors.push(error);
                continue;
            }
        };
        let payload_bits = majority(&stream[prefix_slots..], config.payload_repeat);
        let packets = bits_to_bytes(&payload_bits);
        match frame::decode(&header_bytes, &packets) {
            Ok(payload) => {
                return Ok(DecodeResult {
                    payload,
                    profile: candidate.profile,
                    sync_confidence: candidate.score,
                    candidates_tested: tested,
                })
            }
            Err(error) => errors.push(error),
        }
    }
    let detail = errors.last().cloned().unwrap_or_else(|| {
        "no synchronization candidate reached the confidence threshold".to_string()
    });
    Err(format!("robust-v2 decode failed: {detail}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn majority_vote_recovers_one_error() {
        assert_eq!(majority(&[1, 0, 1, 0, 0, 1], 3), vec![1, 0]);
    }

    #[test]
    fn byte_bit_helpers_are_msb_first() {
        use super::super::embed::bytes_to_bits;

        let bytes = [0xa5, 0x03];
        assert_eq!(bits_to_bytes(&bytes_to_bits(&bytes)), bytes);
    }
}
