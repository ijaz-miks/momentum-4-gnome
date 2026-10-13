use serde::Serialize;
use std::fmt::Display;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AntiWind {
    Auto,
    Max,
    Off,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Percent(u8);
#[derive(Debug, thiserror::Error)]
#[error("value must be between 0 and 100, inclusive")]
pub struct PercentError;
impl Display for Percent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}
impl From<Percent> for u8 {
    fn from(value: Percent) -> Self {
        value.0
    }
}
impl TryFrom<u8> for Percent {
    type Error = PercentError;
    fn try_from(value: u8) -> Result<Self, Self::Error> {
        if value <= 100 {
            Ok(Self(value))
        } else {
            Err(PercentError)
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub index: u8,
    pub priority: u8,
    pub connected: bool,
    pub name: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connections {
    pub capacity: u8,
    pub own_index: u8,
    pub peers: Vec<Peer>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Equalizer {
    /// Gain units are tenths of a decibel, matching the wire representation.
    pub min_gain: i8,
    pub max_gain: i8,
    pub gains: Vec<i8>,
}
pub fn boolean(payload: &[u8]) -> Result<bool, String> {
    match payload {
        [0] => Ok(false),
        [1] => Ok(true),
        _ => Err("expected one Boolean byte".into()),
    }
}
pub fn bounded_byte(payload: &[u8], maximum: u8) -> Result<u8, String> {
    match payload {
        [n] if *n <= maximum => Ok(*n),
        _ => Err(format!("expected one byte in 0..={maximum}")),
    }
}
pub fn decode_peer(payload: &[u8], index: u8) -> Result<Peer, String> {
    if payload.len() < 4 || payload[0] != index || payload[2] > 1 || payload.last() != Some(&0) {
        return Err("invalid paired-device response".into());
    }
    let name = &payload[3..payload.len() - 1];
    if name.contains(&0) {
        return Err("embedded NUL in peer name".into());
    }
    let name = std::str::from_utf8(name)
        .map_err(|_| "invalid UTF-8 peer name")?
        .to_owned();
    if name.is_empty() {
        return Err("empty peer name".into());
    }
    Ok(Peer {
        index,
        priority: payload[1],
        connected: payload[2] != 0,
        name,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn peer_identity_and_booleans_are_strict() {
        let peer = decode_peer(b"\x01\x00\x01Test phone\x00", 1).unwrap();
        assert!(peer.connected);
        assert_eq!(peer.name, "Test phone");
        assert!(decode_peer(b"\x01\x00\x02Test phone\x00", 1).is_err());
        assert!(decode_peer(b"\x01\x00\x01Test phone\x00", 0).is_err());
        assert!(decode_peer(b"\x01\x00\x01Test phone", 1).is_err());
        assert!(boolean(&[1, 0]).is_err());
    }
}
