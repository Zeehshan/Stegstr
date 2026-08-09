use std::sync::OnceLock;

fn cosine_table() -> &'static [[f32; 8]; 8] {
    static TABLE: OnceLock<[[f32; 8]; 8]> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut table = [[0.0f32; 8]; 8];
        for frequency in 0..8 {
            for position in 0..8 {
                table[frequency][position] =
                    (((2 * position + 1) as f32 * frequency as f32 * std::f32::consts::PI) / 16.0)
                        .cos();
            }
        }
        table
    })
}

#[inline]
fn alpha(index: usize) -> f32 {
    if index == 0 {
        std::f32::consts::FRAC_1_SQRT_2
    } else {
        1.0
    }
}

pub(crate) fn forward(block: &[f32; 64]) -> [f32; 64] {
    let cos = cosine_table();
    let mut row_pass = [0.0f32; 64];
    for y in 0..8 {
        for u in 0..8 {
            let mut sum = 0.0;
            for x in 0..8 {
                sum += block[y * 8 + x] * cos[u][x];
            }
            row_pass[y * 8 + u] = 0.5 * alpha(u) * sum;
        }
    }
    let mut output = [0.0f32; 64];
    for v in 0..8 {
        for u in 0..8 {
            let mut sum = 0.0;
            for y in 0..8 {
                sum += row_pass[y * 8 + u] * cos[v][y];
            }
            output[v * 8 + u] = 0.5 * alpha(v) * sum;
        }
    }
    output
}

pub(crate) fn inverse(coefficients: &[f32; 64]) -> [f32; 64] {
    let cos = cosine_table();
    let mut column_pass = [0.0f32; 64];
    for y in 0..8 {
        for u in 0..8 {
            let mut sum = 0.0;
            for v in 0..8 {
                sum += alpha(v) * coefficients[v * 8 + u] * cos[v][y];
            }
            column_pass[y * 8 + u] = 0.5 * sum;
        }
    }
    let mut output = [0.0f32; 64];
    for y in 0..8 {
        for x in 0..8 {
            let mut sum = 0.0;
            for u in 0..8 {
                sum += alpha(u) * column_pass[y * 8 + u] * cos[u][x];
            }
            output[y * 8 + x] = 0.5 * sum;
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_is_precise() {
        let mut block = [0.0f32; 64];
        for (index, value) in block.iter_mut().enumerate() {
            *value = ((index * 37 + 11) % 256) as f32 - 128.0;
        }
        let restored = inverse(&forward(&block));
        for index in 0..64 {
            assert!((restored[index] - block[index]).abs() < 0.001);
        }
    }
}
