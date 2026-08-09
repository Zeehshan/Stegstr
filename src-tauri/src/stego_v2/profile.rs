use std::str::FromStr;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum RobustnessProfile {
    Standard = 0,
    Robust = 1,
    Maximum = 2,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct ProfileConfig {
    pub canonical_long_edge: u32,
    pub header_repeat: usize,
    pub payload_repeat: usize,
    pub data_shards: usize,
    pub parity_shards: usize,
    pub base_delta: f32,
    pub max_delta: f32,
}

impl RobustnessProfile {
    pub const ALL: [Self; 3] = [Self::Standard, Self::Robust, Self::Maximum];

    pub(crate) fn config(self) -> ProfileConfig {
        match self {
            Self::Standard => ProfileConfig {
                canonical_long_edge: 1280,
                header_repeat: 5,
                payload_repeat: 1,
                data_shards: 8,
                parity_shards: 3,
                base_delta: 60.0,
                max_delta: 90.0,
            },
            Self::Robust => ProfileConfig {
                canonical_long_edge: 1024,
                header_repeat: 7,
                payload_repeat: 3,
                data_shards: 6,
                parity_shards: 4,
                base_delta: 120.0,
                max_delta: 170.0,
            },
            Self::Maximum => ProfileConfig {
                canonical_long_edge: 1024,
                header_repeat: 9,
                payload_repeat: 5,
                data_shards: 4,
                parity_shards: 4,
                base_delta: 150.0,
                max_delta: 220.0,
            },
        }
    }

    pub(crate) fn from_id(id: u8) -> Result<Self, String> {
        match id {
            0 => Ok(Self::Standard),
            1 => Ok(Self::Robust),
            2 => Ok(Self::Maximum),
            _ => Err(format!("unsupported robust-v2 profile id {id}")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Standard => "standard",
            Self::Robust => "robust",
            Self::Maximum => "maximum",
        }
    }
}

impl Default for RobustnessProfile {
    fn default() -> Self {
        Self::Robust
    }
}

impl FromStr for RobustnessProfile {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.to_ascii_lowercase().as_str() {
            "standard" => Ok(Self::Standard),
            "robust" => Ok(Self::Robust),
            "maximum" | "max" => Ok(Self::Maximum),
            _ => Err(format!("unknown robustness profile: {value}")),
        }
    }
}
