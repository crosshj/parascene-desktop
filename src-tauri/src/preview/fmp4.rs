//! Minimal fragmented-MP4 helpers: locate init vs media, rewrite tfdt.

use std::path::Path;

/// Find the byte offset of the first `moof` box (start of media fragments).
pub fn find_first_moof(data: &[u8]) -> Option<usize> {
    let mut i = 0usize;
    while i + 8 <= data.len() {
        let size = u32::from_be_bytes([data[i], data[i + 1], data[i + 2], data[i + 3]]) as usize;
        if size < 8 {
            return None;
        }
        let typ = &data[i + 4..i + 8];
        if typ == b"moof" {
            return Some(i);
        }
        i += size;
    }
    None
}

/// Split a fragmented MP4 into init (ftyp+moov…) and media (moof+mdat…).
pub fn split_init_media(data: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
    let moof = find_first_moof(data).ok_or_else(|| "No moof in fMP4".to_string())?;
    Ok((data[..moof].to_vec(), data[moof..].to_vec()))
}

fn read_tfdt_at(media: &[u8], i: usize, size: usize) -> Option<u64> {
    if size < 16 {
        return None;
    }
    let version = media[i + 8];
    if version == 1 && size >= 20 {
        let mut b = [0u8; 8];
        b.copy_from_slice(&media[i + 12..i + 20]);
        Some(u64::from_be_bytes(b))
    } else if version == 0 {
        let mut b = [0u8; 4];
        b.copy_from_slice(&media[i + 12..i + 16]);
        Some(u32::from_be_bytes(b) as u64)
    } else {
        None
    }
}

fn write_tfdt_at(media: &mut [u8], i: usize, size: usize, base_time: u64) {
    if size < 16 {
        return;
    }
    let version = media[i + 8];
    if version == 1 && size >= 20 {
        media[i + 12..i + 20].copy_from_slice(&base_time.to_be_bytes());
    } else if version == 0 {
        let t = (base_time.min(u32::MAX as u64)) as u32;
        media[i + 12..i + 16].copy_from_slice(&t.to_be_bytes());
    }
}

/// Collect (offset, size, time) for every tfdt in a top-level walk that descends
/// into moof/traf containers.
fn collect_tfdt(media: &[u8], start: usize, end: usize, out: &mut Vec<(usize, usize, u64)>) {
    let mut i = start;
    while i + 8 <= end {
        let size = u32::from_be_bytes([media[i], media[i + 1], media[i + 2], media[i + 3]]) as usize;
        if size < 8 || i + size > end {
            break;
        }
        let typ = [media[i + 4], media[i + 5], media[i + 6], media[i + 7]];
        if &typ == b"tfdt" {
            if let Some(t) = read_tfdt_at(media, i, size) {
                out.push((i, size, t));
            }
        } else if &typ == b"moof" || &typ == b"traf" {
            collect_tfdt(media, i + 8, i + size, out);
        }
        i += size;
    }
}

/// Rebase all `tfdt` values so the earliest is `0`, preserving relative gaps.
///
/// Setting every tfdt to the same absolute 0 (old behavior) collapses multi-moof
/// fragments. All-intra scrub proxies emit many moofs per second — continuous
/// MSE playback then fails after the first frame.
pub fn rebase_tfdt_to_zero(media: &mut [u8]) {
    let mut entries = Vec::new();
    collect_tfdt(media, 0, media.len(), &mut entries);
    let Some(min_t) = entries.iter().map(|(_, _, t)| *t).min() else {
        return;
    };
    if min_t == 0 {
        return;
    }
    for (i, size, t) in entries {
        write_tfdt_at(media, i, size, t.saturating_sub(min_t));
    }
}

/// Shift timestamps so the earliest tfdt becomes `base_time`, preserving gaps.
pub fn rewrite_tfdt_base(media: &mut [u8], base_time: u64) {
    if base_time == 0 {
        rebase_tfdt_to_zero(media);
        return;
    }
    let mut entries = Vec::new();
    collect_tfdt(media, 0, media.len(), &mut entries);
    let min_t = entries.iter().map(|(_, _, t)| *t).min().unwrap_or(0);
    for (i, size, t) in entries {
        write_tfdt_at(media, i, size, base_time + t.saturating_sub(min_t));
    }
}

pub fn read_file(path: &Path) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))
}

pub fn write_file(path: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, data).map_err(|e| format!("write {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn box_header(size: u32, typ: &[u8; 4]) -> Vec<u8> {
        let mut v = size.to_be_bytes().to_vec();
        v.extend_from_slice(typ);
        v
    }

    fn tfdt_v0(t: u32) -> Vec<u8> {
        let mut v = box_header(16, b"tfdt");
        v.extend_from_slice(&[0, 0, 0, 0]);
        v.extend_from_slice(&t.to_be_bytes());
        v
    }

    #[test]
    fn rebase_preserves_relative_tfdt() {
        let mut traf = box_header(8 + 16 + 16, b"traf");
        traf.extend(tfdt_v0(1000));
        traf.extend(tfdt_v0(2000));
        let mut moof = box_header((8 + traf.len()) as u32, b"moof");
        moof.extend(traf);
        rebase_tfdt_to_zero(&mut moof);
        let mut entries = Vec::new();
        collect_tfdt(&moof, 0, moof.len(), &mut entries);
        let times: Vec<u64> = entries.into_iter().map(|(_, _, t)| t).collect();
        assert_eq!(times, vec![0, 1000]);
    }
}
