use crc32fast::hash as crc32;
use reed_solomon_erasure::galois_8::ReedSolomon;

pub(crate) fn encoded_packet_len(
    content_len: usize,
    data_shards: usize,
    parity_shards: usize,
) -> Option<usize> {
    if data_shards == 0 {
        return None;
    }
    let shard_size = content_len.max(1).div_ceil(data_shards);
    (data_shards + parity_shards).checked_mul(shard_size.checked_add(4)?)
}

pub(crate) fn encode_packets(
    content: &[u8],
    data_shards: usize,
    parity_shards: usize,
) -> Result<(usize, Vec<u8>), String> {
    let shard_size = content.len().max(1).div_ceil(data_shards);
    if shard_size > u16::MAX as usize {
        return Err("robust-v2 FEC shard exceeds u16 size".to_string());
    }
    let mut shards = vec![vec![0u8; shard_size]; data_shards + parity_shards];
    for (index, byte) in content.iter().enumerate() {
        shards[index / shard_size][index % shard_size] = *byte;
    }
    let rs = ReedSolomon::new(data_shards, parity_shards).map_err(|e| e.to_string())?;
    rs.encode(&mut shards).map_err(|e| e.to_string())?;

    let mut packets = Vec::with_capacity((shard_size + 4) * shards.len());
    for shard in shards {
        packets.extend_from_slice(&crc32(&shard).to_be_bytes());
        packets.extend_from_slice(&shard);
    }
    Ok((shard_size, packets))
}

pub(crate) fn decode_packets(
    packets: &[u8],
    data_shards: usize,
    parity_shards: usize,
    shard_size: usize,
    content_len: usize,
) -> Result<Vec<u8>, String> {
    let total_shards = data_shards + parity_shards;
    let packet_size = shard_size
        .checked_add(4)
        .ok_or("robust-v2 FEC packet size overflow")?;
    let mut shards: Vec<Option<Vec<u8>>> = Vec::with_capacity(total_shards);
    for index in 0..total_shards {
        let start = index * packet_size;
        let end = start + packet_size;
        if end > packets.len() {
            shards.push(None);
            continue;
        }
        let expected_crc = u32::from_be_bytes(packets[start..start + 4].try_into().unwrap());
        let shard = packets[start + 4..end].to_vec();
        if crc32(&shard) == expected_crc {
            shards.push(Some(shard));
        } else {
            shards.push(None);
        }
    }
    if shards.iter().filter(|shard| shard.is_some()).count() < data_shards {
        return Err("robust-v2 has too many missing or corrupt FEC shards".to_string());
    }
    let rs = ReedSolomon::new(data_shards, parity_shards).map_err(|e| e.to_string())?;
    rs.reconstruct(&mut shards).map_err(|e| e.to_string())?;
    let mut content = Vec::with_capacity(data_shards * shard_size);
    for shard in shards.into_iter().take(data_shards) {
        content.extend_from_slice(&shard.ok_or("robust-v2 data shard reconstruction failed")?);
    }
    if content_len > content.len() {
        return Err("robust-v2 reconstructed content is truncated".to_string());
    }
    content.truncate(content_len);
    Ok(content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconstructs_missing_and_corrupt_shards() {
        let content: Vec<u8> = (0..500).map(|i| (i * 37) as u8).collect();
        let (shard_size, packets) = encode_packets(&content, 6, 4).unwrap();
        let packet_size = shard_size + 4;

        let mut damaged = packets.clone();
        damaged[packet_size + 9] ^= 0x80;
        damaged[3 * packet_size + 17] ^= 0x40;
        let decoded = decode_packets(&damaged, 6, 4, shard_size, content.len()).unwrap();
        assert_eq!(decoded, content);

        let truncated = &packets[..8 * packet_size];
        let decoded = decode_packets(truncated, 6, 4, shard_size, content.len()).unwrap();
        assert_eq!(decoded, content);
    }

    #[test]
    fn rejects_too_many_missing_shards() {
        let content = vec![7u8; 500];
        let (shard_size, packets) = encode_packets(&content, 6, 4).unwrap();
        let packet_size = shard_size + 4;
        let truncated = &packets[..5 * packet_size];
        assert!(decode_packets(truncated, 6, 4, shard_size, content.len()).is_err());
    }
}
