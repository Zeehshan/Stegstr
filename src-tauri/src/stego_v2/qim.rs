use super::dct;
use super::profile::RobustnessProfile;
use super::PAIRS_PER_BLOCK;
use std::collections::HashMap;

const PAIRS: [((usize, usize), (usize, usize)); PAIRS_PER_BLOCK] = [
    ((0, 1), (1, 0)),
    ((0, 2), (2, 0)),
    ((1, 1), (0, 3)),
    ((3, 0), (2, 1)),
    ((1, 2), (0, 4)),
    ((4, 0), (2, 2)),
];

fn gcd(mut left: usize, mut right: usize) -> usize {
    while right != 0 {
        let remainder = left % right;
        left = right;
        right = remainder;
    }
    left
}

fn permutation(
    total_slots: usize,
    width: u32,
    height: u32,
    profile: RobustnessProfile,
) -> (usize, usize) {
    let seed = (width as usize)
        .wrapping_mul(0x9e37)
        .wrapping_add((height as usize).wrapping_mul(0x85eb))
        .wrapping_add(profile as usize * 0xc2b2);
    let offset = seed % total_slots;
    let mut stride = 104_729usize.wrapping_add(seed % 4096) | 1;
    while gcd(stride, total_slots) != 1 {
        stride = stride.wrapping_add(2);
    }
    (offset, stride)
}

#[inline]
fn physical_slot(logical: usize, total: usize, offset: usize, stride: usize) -> usize {
    (offset + logical.wrapping_mul(stride)) % total
}

fn extract_block(y: &[f32], width: usize, block_index: usize, blocks_x: usize) -> [f32; 64] {
    let block_y = block_index / blocks_x;
    let block_x = block_index % blocks_x;
    let mut block = [0.0f32; 64];
    for row in 0..8 {
        let source = (block_y * 8 + row) * width + block_x * 8;
        for column in 0..8 {
            block[row * 8 + column] = y[source + column] - 128.0;
        }
    }
    block
}

fn write_block(
    y: &mut [f32],
    width: usize,
    block_index: usize,
    blocks_x: usize,
    block: &[f32; 64],
) {
    let block_y = block_index / blocks_x;
    let block_x = block_index % blocks_x;
    for row in 0..8 {
        let target = (block_y * 8 + row) * width + block_x * 8;
        for column in 0..8 {
            y[target + column] = (block[row * 8 + column] + 128.0).clamp(0.0, 255.0);
        }
    }
}

fn adaptive_delta(block: &[f32; 64], profile: RobustnessProfile) -> f32 {
    let mean = block.iter().sum::<f32>() / 64.0;
    let variance = block
        .iter()
        .map(|value| {
            let difference = *value - mean;
            difference * difference
        })
        .sum::<f32>()
        / 64.0;
    let config = profile.config();
    let texture = (variance.sqrt() / 48.0).clamp(0.0, 1.0);
    config.base_delta + texture * (config.max_delta - config.base_delta)
}

pub(crate) fn embed_bits(
    y: &mut [f32],
    width: u32,
    height: u32,
    profile: RobustnessProfile,
    bits: &[u8],
    strong_prefix_bits: usize,
) -> Result<(), String> {
    let blocks_x = (width / 8) as usize;
    let blocks_y = (height / 8) as usize;
    let block_count = blocks_x * blocks_y;
    let total_slots = block_count * PAIRS_PER_BLOCK;
    if bits.len() > total_slots {
        return Err(format!(
            "robust-v2 needs {} coefficient pairs but carrier has {}",
            bits.len(),
            total_slots
        ));
    }
    let (offset, stride) = permutation(total_slots, width, height, profile);
    let mut assignments = vec![[-1i8; PAIRS_PER_BLOCK]; block_count];
    for (logical, bit) in bits.iter().enumerate() {
        let physical = physical_slot(logical, total_slots, offset, stride);
        let strength_marker = if logical < strong_prefix_bits { 2 } else { 0 };
        assignments[physical / PAIRS_PER_BLOCK][physical % PAIRS_PER_BLOCK] =
            ((*bit & 1) as i8) + strength_marker;
    }

    for (block_index, assignment) in assignments.iter().enumerate() {
        if assignment.iter().all(|bit| *bit < 0) {
            continue;
        }
        let spatial = extract_block(y, width as usize, block_index, blocks_x);
        let delta = adaptive_delta(&spatial, profile);
        let mut coefficients = dct::forward(&spatial);
        for (pair_index, bit) in assignment.iter().enumerate() {
            if *bit < 0 {
                continue;
            }
            let (left, right) = PAIRS[pair_index];
            let left_index = left.0 * 8 + left.1;
            let right_index = right.0 * 8 + right.1;
            let difference = coefficients[left_index] - coefficients[right_index];
            let strong = *bit >= 2;
            let value = *bit & 1;
            let pair_delta = if strong { delta } else { delta * 0.8 };
            let target = if value == 1 { pair_delta } else { -pair_delta };
            if (value == 1 && difference < target) || (value == 0 && difference > target) {
                let adjustment = (target - difference) * 0.5;
                coefficients[left_index] += adjustment;
                coefficients[right_index] -= adjustment;
            }
        }
        write_block(
            y,
            width as usize,
            block_index,
            blocks_x,
            &dct::inverse(&coefficients),
        );
    }
    Ok(())
}

pub(crate) fn extract_bits(
    y: &[f32],
    width: u32,
    height: u32,
    profile: RobustnessProfile,
    count: usize,
) -> Result<Vec<u8>, String> {
    let blocks_x = (width / 8) as usize;
    let blocks_y = (height / 8) as usize;
    let total_slots = blocks_x * blocks_y * PAIRS_PER_BLOCK;
    if count > total_slots {
        return Err("robust-v2 extraction request exceeds carrier slots".to_string());
    }
    let (offset, stride) = permutation(total_slots, width, height, profile);
    let mut cache: HashMap<usize, [f32; 64]> =
        HashMap::with_capacity(count.min(blocks_x * blocks_y));
    let mut bits = Vec::with_capacity(count);
    for logical in 0..count {
        let physical = physical_slot(logical, total_slots, offset, stride);
        let block_index = physical / PAIRS_PER_BLOCK;
        let pair_index = physical % PAIRS_PER_BLOCK;
        let coefficients = cache.entry(block_index).or_insert_with(|| {
            dct::forward(&extract_block(y, width as usize, block_index, blocks_x))
        });
        let (left, right) = PAIRS[pair_index];
        let difference = coefficients[left.0 * 8 + left.1] - coefficients[right.0 * 8 + right.1];
        bits.push((difference >= 0.0) as u8);
    }
    Ok(bits)
}
