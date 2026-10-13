use tokio::io;
use tokio_util::{
    bytes::{Buf, BytesMut},
    codec::{Decoder, Encoder},
};

pub const SENNHEISER: u16 = 0x0495;
pub const QUALCOMM: u16 = 0x001d;

/// GAIA v3 over RFCOMM: start, version, flags, payload length, vendor, command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Frame {
    pub vendor: u16,
    pub command: u16,
    pub payload: Vec<u8>,
}

#[derive(Debug, thiserror::Error)]
pub enum GaiaError {
    #[error("invalid GAIA frame: {0}")]
    InvalidFrame(String),
    #[error(transparent)]
    Io(#[from] io::Error),
}
pub struct GaiaCodec;

impl Decoder for GaiaCodec {
    type Item = Frame;
    type Error = GaiaError;
    fn decode(&mut self, src: &mut BytesMut) -> Result<Option<Frame>, GaiaError> {
        if src.len() < 8 {
            return Ok(None);
        }
        if src[0] != 0xff || src[1] != 3 || src[2] & !1 != 0 {
            return Err(GaiaError::InvalidFrame("unsupported header".into()));
        }
        let length = usize::from(src[3]);
        let checksum = src[2] & 1 != 0;
        let total = 8 + length + usize::from(checksum);
        if src.len() < total {
            src.reserve(total - src.len());
            return Ok(None);
        }
        if checksum && src[..total].iter().fold(0u8, |sum, value| sum ^ value) != 0 {
            return Err(GaiaError::InvalidFrame("checksum mismatch".into()));
        }
        let frame = Frame {
            vendor: u16::from_be_bytes([src[4], src[5]]),
            command: u16::from_be_bytes([src[6], src[7]]),
            payload: src[8..8 + length].to_vec(),
        };
        src.advance(total);
        Ok(Some(frame))
    }
}
impl Encoder<Frame> for GaiaCodec {
    type Error = GaiaError;
    fn encode(&mut self, frame: Frame, dst: &mut BytesMut) -> Result<(), GaiaError> {
        let length = u8::try_from(frame.payload.len())
            .map_err(|_| GaiaError::InvalidFrame("payload exceeds 255 bytes".into()))?;
        dst.reserve(8 + usize::from(length));
        dst.extend_from_slice(&[0xff, 3, 0, length]);
        dst.extend_from_slice(&frame.vendor.to_be_bytes());
        dst.extend_from_slice(&frame.command.to_be_bytes());
        dst.extend_from_slice(&frame.payload);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn captured_multipoint_and_fragmented_peer_frames() {
        let mut codec = GaiaCodec;
        let mut buffer = BytesMut::from(&b"\xff\x03\x00\x01\x00\x1d\x0f\x10\x01\xff\x03"[..]);
        let frame = codec.decode(&mut buffer).unwrap().unwrap();
        assert_eq!(
            frame,
            Frame {
                vendor: QUALCOMM,
                command: 0x0f10,
                payload: vec![1]
            }
        );
        assert!(codec.decode(&mut buffer).unwrap().is_none());
        buffer.extend_from_slice(&[0, 2, 4, 0x95, 0x15, 4, 1, 0]);
        assert_eq!(codec.decode(&mut buffer).unwrap().unwrap().payload, [1, 0]);
        assert!(buffer.is_empty());
    }
    #[test]
    fn vendor_is_preserved_and_unknown_notifications_are_frames() {
        let mut codec = GaiaCodec;
        let mut buffer = BytesMut::from(&b"\xff\x03\x00\x02\x04\x95\x14\x84\x01\x00"[..]);
        assert_eq!(codec.decode(&mut buffer).unwrap().unwrap().command, 0x1484);
    }
    #[test]
    fn encode_live_toggle_and_reject_bad_headers() {
        let mut codec = GaiaCodec;
        let mut buffer = BytesMut::new();
        codec
            .encode(
                Frame {
                    vendor: QUALCOMM,
                    command: 0x0e00,
                    payload: vec![0],
                },
                &mut buffer,
            )
            .unwrap();
        assert_eq!(&buffer[..], &[0xff, 3, 0, 1, 0, 0x1d, 0x0e, 0, 0]);
        buffer[1] = 2;
        assert!(codec.decode(&mut buffer).is_err());
    }
    #[test]
    fn checksum_and_payload_limits() {
        let mut bytes = vec![0xff, 3, 1, 1, 0, 0x1d, 0x0f, 0x10, 1];
        bytes.push(bytes.iter().fold(0, |a, b| a ^ b));
        let mut codec = GaiaCodec;
        assert!(
            codec
                .decode(&mut BytesMut::from(bytes.as_slice()))
                .unwrap()
                .is_some()
        );
        bytes[8] = 0;
        assert!(codec.decode(&mut BytesMut::from(bytes.as_slice())).is_err());
        assert!(
            codec
                .encode(
                    Frame {
                        vendor: SENNHEISER,
                        command: 0,
                        payload: vec![0; 256]
                    },
                    &mut BytesMut::new()
                )
                .is_err()
        );
    }
}
