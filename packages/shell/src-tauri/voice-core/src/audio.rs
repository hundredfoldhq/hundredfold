//! The bridge between platform audio and the voice socket's binary frames.

use crate::protocol::{DOWN_AUDIO_KIND, DOWN_HEADER_BYTES, MAX_DOWN_PCM_BYTES, UP_FRAME_BYTES};

/// A decoded gateway → client audio frame.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DownFrame {
    pub seq: u16,
    pub segment_id: u32,
    /// PCM16LE mono at the output rate (24 kHz).
    pub pcm: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DownFrameError {
    TooShort,
    UnknownKind,
    OddLength,
    TooLarge,
}

/// Decode `[u8 kind=1][u8 0][u16 seq LE][u32 segmentId LE][PCM16LE mono]`.
pub fn parse_down_frame(bytes: &[u8]) -> Result<DownFrame, DownFrameError> {
    if bytes.len() < DOWN_HEADER_BYTES {
        return Err(DownFrameError::TooShort);
    }
    if bytes[0] != DOWN_AUDIO_KIND {
        return Err(DownFrameError::UnknownKind);
    }
    let pcm = &bytes[DOWN_HEADER_BYTES..];
    if pcm.len() > MAX_DOWN_PCM_BYTES {
        return Err(DownFrameError::TooLarge);
    }
    if pcm.len() % 2 != 0 {
        return Err(DownFrameError::OddLength);
    }
    Ok(DownFrame {
        seq: u16::from_le_bytes([bytes[2], bytes[3]]),
        segment_id: u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]),
        pcm: pcm.to_vec(),
    })
}

/// Re-slices captured audio of any chunk size into exact 20 ms up-frames. iOS
/// delivers tap buffers of arbitrary length; Android delivers whatever
/// `AudioRecord.read` returned.
#[derive(Default)]
pub struct FrameChunker {
    pending: Vec<u8>,
}

impl FrameChunker {
    /// Appends `bytes` and returns every complete frame now available.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<Vec<u8>> {
        self.pending.extend_from_slice(bytes);
        let whole = self.pending.len() / UP_FRAME_BYTES * UP_FRAME_BYTES;
        if whole == 0 {
            return Vec::new();
        }
        let frames = self.pending[..whole]
            .chunks_exact(UP_FRAME_BYTES)
            .map(<[u8]>::to_vec)
            .collect();
        self.pending.drain(..whole);
        frames
    }

    /// Drops a partial frame, so audio from before a pause is never joined to
    /// audio from after it.
    pub fn clear(&mut self) {
        self.pending.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn down(kind: u8, seq: u16, segment: u32, pcm: &[u8]) -> Vec<u8> {
        let mut bytes = vec![kind, 0];
        bytes.extend_from_slice(&seq.to_le_bytes());
        bytes.extend_from_slice(&segment.to_le_bytes());
        bytes.extend_from_slice(pcm);
        bytes
    }

    #[test]
    fn decodes_the_down_header_little_endian() {
        let frame = parse_down_frame(&down(1, 0x0102, 0x0a0b0c0d, &[1, 2, 3, 4])).unwrap();
        assert_eq!(frame.seq, 0x0102);
        assert_eq!(frame.segment_id, 0x0a0b0c0d);
        assert_eq!(frame.pcm, vec![1, 2, 3, 4]);
    }

    #[test]
    fn rejects_malformed_down_frames() {
        assert_eq!(parse_down_frame(&[1, 0, 0]), Err(DownFrameError::TooShort));
        assert_eq!(
            parse_down_frame(&down(2, 0, 1, &[0, 0])),
            Err(DownFrameError::UnknownKind)
        );
        assert_eq!(
            parse_down_frame(&down(1, 0, 1, &[0, 0, 0])),
            Err(DownFrameError::OddLength)
        );
        assert_eq!(
            parse_down_frame(&down(1, 0, 1, &vec![0; MAX_DOWN_PCM_BYTES + 2])),
            Err(DownFrameError::TooLarge)
        );
        // A header with no audio is allowed (an empty frame plays nothing).
        assert!(parse_down_frame(&down(1, 0, 1, &[]))
            .unwrap()
            .pcm
            .is_empty());
        assert!(parse_down_frame(&down(1, 0, 1, &vec![0; MAX_DOWN_PCM_BYTES])).is_ok());
    }

    #[test]
    fn chunker_emits_exact_frames_and_keeps_the_remainder() {
        let mut chunker = FrameChunker::default();
        assert!(chunker.push(&[1; 300]).is_empty());
        let frames = chunker.push(&[2; 1000]);
        assert_eq!(frames.len(), 2);
        assert!(frames.iter().all(|f| f.len() == UP_FRAME_BYTES));
        // 300 bytes of 1s then 340 of 2s make the first frame.
        assert_eq!(&frames[0][..300], &[1; 300][..]);
        assert_eq!(&frames[0][300..], &[2; 340][..]);
        // 1300 bytes in total: 20 are left over.
        let rest = chunker.push(&[3; 620]);
        assert_eq!(rest.len(), 1);
        assert_eq!(&rest[0][..20], &[2; 20][..]);
    }

    #[test]
    fn chunker_clear_drops_the_partial_frame() {
        let mut chunker = FrameChunker::default();
        chunker.push(&[9; 100]);
        chunker.clear();
        let frames = chunker.push(&[1; UP_FRAME_BYTES]);
        assert_eq!(frames, vec![vec![1; UP_FRAME_BYTES]]);
    }
}
