use super::fec;
use super::profile::RobustnessProfile;
use crc32fast::Hasher as Crc32;
use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

pub const MAGIC: &[u8; 4] = b"SGV2";
pub const VERSION: u8 = 2;
pub const HEADER_LEN: usize = 74;
pub const FLAG_COMPRESSED: u16 = 1;
pub const MAX_PAYLOAD_BYTES: usize = 65_535;

#[derive(Clone, Debug)]
pub(crate) struct Header {
    pub profile: RobustnessProfile,
    pub flags: u16,
    pub canonical_width: u16,
    pub canonical_height: u16,
    pub data_shards: u8,
    pub parity_shards: u8,
    pub shard_size: u16,
    pub compressed_len: u32,
    pub original_len: u32,
    pub packet_bytes: u32,
    pub frame_id: [u8; 8],
    pub payload_digest: [u8; 32],
}

pub(crate) struct EncodedFrame {
    pub header: Header,
    pub header_bytes: Vec<u8>,
    pub packets: Vec<u8>,
}

impl Header {
    pub(crate) fn serialize(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(HEADER_LEN);
        out.extend_from_slice(MAGIC);
        out.push(VERSION);
        out.push(self.profile as u8);
        out.extend_from_slice(&self.flags.to_be_bytes());
        out.extend_from_slice(&(HEADER_LEN as u16).to_be_bytes());
        out.extend_from_slice(&self.canonical_width.to_be_bytes());
        out.extend_from_slice(&self.canonical_height.to_be_bytes());
        out.push(self.data_shards);
        out.push(self.parity_shards);
        out.extend_from_slice(&self.shard_size.to_be_bytes());
        out.extend_from_slice(&self.compressed_len.to_be_bytes());
        out.extend_from_slice(&self.original_len.to_be_bytes());
        out.extend_from_slice(&self.packet_bytes.to_be_bytes());
        out.extend_from_slice(&self.frame_id);
        out.extend_from_slice(&self.payload_digest);
        debug_assert_eq!(out.len(), HEADER_LEN - 4);
        let mut crc = Crc32::new();
        crc.update(&out);
        out.extend_from_slice(&crc.finalize().to_be_bytes());
        out
    }

    pub(crate) fn parse(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() < HEADER_LEN {
            return Err("robust-v2 header is truncated".to_string());
        }
        if &bytes[..4] != MAGIC {
            return Err("robust-v2 magic mismatch".to_string());
        }
        if bytes[4] != VERSION {
            return Err(format!("unsupported robust-v2 version {}", bytes[4]));
        }
        let header_len = u16::from_be_bytes([bytes[8], bytes[9]]) as usize;
        if header_len != HEADER_LEN {
            return Err(format!("invalid robust-v2 header length {header_len}"));
        }
        let expected_crc = u32::from_be_bytes(bytes[70..74].try_into().unwrap());
        let mut crc = Crc32::new();
        crc.update(&bytes[..70]);
        if crc.finalize() != expected_crc {
            return Err("robust-v2 header checksum mismatch".to_string());
        }
        let profile = RobustnessProfile::from_id(bytes[5])?;
        let flags = u16::from_be_bytes([bytes[6], bytes[7]]);
        if flags & !FLAG_COMPRESSED != 0 {
            return Err(format!("unsupported robust-v2 flags 0x{flags:04x}"));
        }
        let canonical_width = u16::from_be_bytes([bytes[10], bytes[11]]);
        let canonical_height = u16::from_be_bytes([bytes[12], bytes[13]]);
        let data_shards = bytes[14];
        let parity_shards = bytes[15];
        let shard_size = u16::from_be_bytes([bytes[16], bytes[17]]);
        let compressed_len = u32::from_be_bytes(bytes[18..22].try_into().unwrap());
        let original_len = u32::from_be_bytes(bytes[22..26].try_into().unwrap());
        let packet_bytes = u32::from_be_bytes(bytes[26..30].try_into().unwrap());
        let frame_id = bytes[30..38].try_into().unwrap();
        let payload_digest = bytes[38..70].try_into().unwrap();

        let config = profile.config();
        if data_shards as usize != config.data_shards
            || parity_shards as usize != config.parity_shards
        {
            return Err("robust-v2 shard parameters do not match profile".to_string());
        }
        if canonical_width < 64 || canonical_height < 64 || shard_size == 0 {
            return Err("robust-v2 header contains invalid dimensions or shard size".to_string());
        }
        if original_len as usize > MAX_PAYLOAD_BYTES {
            return Err("robust-v2 declared payload exceeds safety limit".to_string());
        }
        let expected_packet_bytes = (data_shards as usize + parity_shards as usize)
            .checked_mul(shard_size as usize + 4)
            .ok_or("robust-v2 packet length overflow")?;
        if packet_bytes as usize != expected_packet_bytes {
            return Err("robust-v2 packet length is inconsistent".to_string());
        }
        if compressed_len as usize > data_shards as usize * shard_size as usize {
            return Err("robust-v2 compressed length exceeds data shards".to_string());
        }

        Ok(Self {
            profile,
            flags,
            canonical_width,
            canonical_height,
            data_shards,
            parity_shards,
            shard_size,
            compressed_len,
            original_len,
            packet_bytes,
            frame_id,
            payload_digest,
        })
    }
}

pub(crate) fn encode(
    payload: &[u8],
    profile: RobustnessProfile,
    canonical_width: u16,
    canonical_height: u16,
) -> Result<EncodedFrame, String> {
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err(format!(
            "robust-v2 payload exceeds {} byte safety limit",
            MAX_PAYLOAD_BYTES
        ));
    }
    let mut compressor = ZlibEncoder::new(Vec::new(), Compression::default());
    compressor.write_all(payload).map_err(|e| e.to_string())?;
    let compressed = compressor.finish().map_err(|e| e.to_string())?;
    let config = profile.config();
    let (shard_size, packets) =
        fec::encode_packets(&compressed, config.data_shards, config.parity_shards)?;
    let digest: [u8; 32] = Sha256::digest(payload).into();
    let frame_id: [u8; 8] = digest[..8].try_into().unwrap();
    let header = Header {
        profile,
        flags: FLAG_COMPRESSED,
        canonical_width,
        canonical_height,
        data_shards: config.data_shards as u8,
        parity_shards: config.parity_shards as u8,
        shard_size: shard_size as u16,
        compressed_len: compressed.len() as u32,
        original_len: payload.len() as u32,
        packet_bytes: packets.len() as u32,
        frame_id,
        payload_digest: digest,
    };
    let header_bytes = header.serialize();
    Ok(EncodedFrame {
        header,
        header_bytes,
        packets,
    })
}

pub(crate) fn decode(header_bytes: &[u8], packets: &[u8]) -> Result<Vec<u8>, String> {
    let header = Header::parse(header_bytes)?;
    let compressed = fec::decode_packets(
        packets,
        header.data_shards as usize,
        header.parity_shards as usize,
        header.shard_size as usize,
        header.compressed_len as usize,
    )?;
    let payload = if header.flags & FLAG_COMPRESSED != 0 {
        let decoder = ZlibDecoder::new(compressed.as_slice());
        let mut decoded = Vec::with_capacity(header.original_len as usize);
        decoder
            .take(header.original_len as u64 + 1)
            .read_to_end(&mut decoded)
            .map_err(|e| format!("robust-v2 decompression failed: {e}"))?;
        decoded
    } else {
        compressed
    };
    if payload.len() != header.original_len as usize {
        return Err("robust-v2 decoded length mismatch".to_string());
    }
    let digest: [u8; 32] = Sha256::digest(&payload).into();
    if digest != header.payload_digest {
        return Err("robust-v2 payload integrity check failed".to_string());
    }
    Ok(payload)
}
