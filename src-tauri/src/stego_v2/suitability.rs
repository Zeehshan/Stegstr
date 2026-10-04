use super::image_ops;
use serde::Serialize;
use std::path::Path;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SuitabilityRating {
    Excellent,
    Good,
    Marginal,
    Unsuitable,
}

#[derive(Clone, Debug, Serialize)]
pub struct CarrierSuitability {
    pub score: u8,
    pub rating: SuitabilityRating,
    pub mean_block_standard_deviation: f32,
    pub textured_block_fraction: f32,
}

/// Rates local luminance texture without changing encode eligibility. The
/// thresholds are deliberately advisory until real-platform evidence is broad
/// enough to justify rejecting carriers.
pub fn assess_carrier(path: &Path) -> Result<CarrierSuitability, String> {
    let image = image_ops::load_oriented(path)?;
    let y = image_ops::luminance(&image);
    let blocks_x = image.width() / 8;
    let blocks_y = image.height() / 8;
    let mut standard_deviation_sum = 0.0f32;
    let mut textured = 0usize;
    let block_count = (blocks_x * blocks_y) as usize;

    for block_y in 0..blocks_y {
        for block_x in 0..blocks_x {
            let mut sum = 0.0f32;
            let mut sum_squared = 0.0f32;
            for row in 0..8 {
                let start = ((block_y * 8 + row) * image.width() + block_x * 8) as usize;
                for value in &y[start..start + 8] {
                    sum += *value;
                    sum_squared += *value * *value;
                }
            }
            let mean = sum / 64.0;
            let deviation = (sum_squared / 64.0 - mean * mean).max(0.0).sqrt();
            standard_deviation_sum += deviation;
            if deviation >= 10.0 {
                textured += 1;
            }
        }
    }

    let mean_deviation = standard_deviation_sum / block_count.max(1) as f32;
    let textured_fraction = textured as f32 / block_count.max(1) as f32;
    let score = ((mean_deviation / 32.0 * 55.0) + textured_fraction * 45.0)
        .round()
        .clamp(0.0, 100.0) as u8;
    let rating = match score {
        70..=100 => SuitabilityRating::Excellent,
        45..=69 => SuitabilityRating::Good,
        20..=44 => SuitabilityRating::Marginal,
        _ => SuitabilityRating::Unsuitable,
    };
    Ok(CarrierSuitability {
        score,
        rating,
        mean_block_standard_deviation: mean_deviation,
        textured_block_fraction: textured_fraction,
    })
}
