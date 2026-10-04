use super::fec;
use super::frame::HEADER_LEN;
use super::profile::RobustnessProfile;
use super::{PAIRS_PER_BLOCK, PILOT_BITS, PILOT_REPEAT};

#[derive(Clone, Debug, serde::Serialize)]
pub struct CapacityReport {
    pub canonical_width: u32,
    pub canonical_height: u32,
    pub raw_carrier_bits: usize,
    pub sync_overhead_bits: usize,
    pub frame_overhead_bits: usize,
    pub fec_packet_capacity_bytes: usize,
    pub usable_plaintext_capacity_bytes: usize,
    pub data_shards: usize,
    pub parity_shards: usize,
    pub payload_bit_repeat: usize,
}

pub(crate) fn for_dimensions(
    canonical_width: u32,
    canonical_height: u32,
    profile: RobustnessProfile,
) -> CapacityReport {
    let config = profile.config();
    let blocks = (canonical_width / 8) as usize * (canonical_height / 8) as usize;
    let raw_carrier_bits = blocks * PAIRS_PER_BLOCK;
    let sync_overhead_bits = PILOT_BITS * PILOT_REPEAT;
    let frame_overhead_bits = HEADER_LEN * 8 * config.header_repeat;
    let available_embedded_bits = raw_carrier_bits
        .saturating_sub(sync_overhead_bits)
        .saturating_sub(frame_overhead_bits);
    let packet_capacity = available_embedded_bits / config.payload_repeat / 8;

    let mut low = 0usize;
    let mut high = packet_capacity;
    while low < high {
        let mid = (low + high + 1) / 2;
        let fits = fec::encoded_packet_len(mid, config.data_shards, config.parity_shards)
            .is_some_and(|length| length <= packet_capacity);
        if fits {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    // Zlib can add a small wrapper and stored-block overhead for incompressible
    // input. Report a conservative plaintext capacity rather than promising the
    // theoretical compressed-byte maximum.
    let usable_plaintext_capacity_bytes = low.saturating_sub(32);
    CapacityReport {
        canonical_width,
        canonical_height,
        raw_carrier_bits,
        sync_overhead_bits,
        frame_overhead_bits,
        fec_packet_capacity_bytes: packet_capacity,
        usable_plaintext_capacity_bytes,
        data_shards: config.data_shards,
        parity_shards: config.parity_shards,
        payload_bit_repeat: config.payload_repeat,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profiles_trade_capacity_for_redundancy() {
        let standard = for_dimensions(1024, 768, RobustnessProfile::Standard);
        let robust = for_dimensions(1024, 768, RobustnessProfile::Robust);
        let maximum = for_dimensions(1024, 768, RobustnessProfile::Maximum);
        assert!(standard.usable_plaintext_capacity_bytes > robust.usable_plaintext_capacity_bytes);
        assert!(robust.usable_plaintext_capacity_bytes > maximum.usable_plaintext_capacity_bytes);
        assert!(maximum.parity_shards >= robust.parity_shards);
    }
}
