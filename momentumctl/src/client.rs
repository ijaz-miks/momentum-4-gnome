use crate::{
    codec::{Frame, GaiaCodec, GaiaError, QUALCOMM, SENNHEISER},
    protocol::{self, AntiWind, Connections, Equalizer, Peer, Percent},
};
use futures_util::{SinkExt, StreamExt};
use std::time::Duration;
use tokio::{
    io::{AsyncRead, AsyncWrite},
    time::timeout,
};
use tokio_util::codec::Framed;

pub struct Client<S> {
    frame: Framed<S, GaiaCodec>,
}
#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error(transparent)]
    Codec(#[from] GaiaError),
    #[error("no response from headset")]
    NoResponse,
    #[error("headset response timed out")]
    Timeout,
    #[error("headset rejected vendor {vendor:04x}, command {command:04x}: {payload:?}")]
    Rejected {
        vendor: u16,
        command: u16,
        payload: Vec<u8>,
    },
    #[error("invalid headset response: {0}")]
    Invalid(String),
}
impl<S: AsyncRead + AsyncWrite + Unpin> Client<S> {
    pub fn new(stream: S) -> Self {
        Self {
            frame: Framed::new(stream, GaiaCodec),
        }
    }
    pub async fn request(
        &mut self,
        vendor: u16,
        command: u16,
        payload: &[u8],
    ) -> Result<Vec<u8>, ClientError> {
        let operation = async {
            self.frame
                .send(Frame {
                    vendor,
                    command,
                    payload: payload.to_vec(),
                })
                .await?;
            while let Some(frame) = self.frame.next().await {
                let frame = frame?;
                if frame.vendor != vendor {
                    continue;
                }
                if frame.command == command | 0x180 {
                    return Err(ClientError::Rejected {
                        vendor,
                        command,
                        payload: frame.payload,
                    });
                }
                if frame.command == command | 0x100 {
                    return Ok(frame.payload);
                }
                // Notifications and responses to other commands cannot satisfy this request.
                log::debug!("ignoring GAIA {:04x}/{:04x}", frame.vendor, frame.command);
            }
            Err(ClientError::NoResponse)
        };
        timeout(Duration::from_secs(3), operation)
            .await
            .map_err(|_| ClientError::Timeout)?
    }
    pub async fn read(&mut self, command: u16, payload: &[u8]) -> Result<Vec<u8>, ClientError> {
        self.request(SENNHEISER, command, payload).await
    }
    pub async fn byte(&mut self, command: u16, maximum: u8) -> Result<u8, ClientError> {
        protocol::bounded_byte(&self.read(command, &[]).await?, maximum)
            .map_err(ClientError::Invalid)
    }
    pub async fn flag(&mut self, command: u16) -> Result<bool, ClientError> {
        protocol::boolean(&self.read(command, &[]).await?).map_err(ClientError::Invalid)
    }
    pub async fn write(&mut self, command: u16, payload: &[u8]) -> Result<(), ClientError> {
        let result = self.read(command, payload).await?;
        if !result.is_empty() {
            return Err(ClientError::Invalid("nonempty acknowledgement".into()));
        }
        Ok(())
    }
    async fn write_flag(&mut self, command: u16, status: bool) -> Result<(), ClientError> {
        self.write(command, &[status.into()]).await
    }
    pub async fn get_mode(&mut self) -> Result<(bool, AntiWind), ClientError> {
        let p = self.read(0x1a01, &[]).await?;
        if p.len() != 6 {
            return Err(ClientError::Invalid(
                "noise modes must contain three pairs".into(),
            ));
        }
        let mut anti = None;
        let mut adaptive = None;
        let mut seen = [false; 4];
        for pair in p.as_chunks::<2>().0 {
            let mode = usize::from(pair[0]);
            if !(1..=3).contains(&mode) || seen[mode] {
                return Err(ClientError::Invalid("invalid noise mode tags".into()));
            }
            seen[mode] = true;
            match mode {
                1 => {
                    anti = Some(match pair[1] {
                        0 => AntiWind::Off,
                        1 => AntiWind::Max,
                        2 => AntiWind::Auto,
                        _ => return Err(ClientError::Invalid("invalid anti-wind mode".into())),
                    })
                }
                3 => adaptive = Some(protocol::boolean(&pair[1..]).map_err(ClientError::Invalid)?),
                _ => {}
            }
        }
        Ok((
            adaptive.ok_or_else(|| ClientError::Invalid("missing adaptive mode".into()))?,
            anti.ok_or_else(|| ClientError::Invalid("missing anti-wind mode".into()))?,
        ))
    }
    pub async fn get_adaptive(&mut self) -> Result<bool, ClientError> {
        Ok(self.get_mode().await?.0)
    }
    pub async fn get_anti_wind(&mut self) -> Result<AntiWind, ClientError> {
        Ok(self.get_mode().await?.1)
    }
    pub async fn get_anc(&mut self) -> Result<bool, ClientError> {
        self.flag(0x1a05).await
    }
    pub async fn get_auto_answer(&mut self) -> Result<bool, ClientError> {
        self.flag(0x080b).await
    }
    pub async fn get_comfort_call(&mut self) -> Result<bool, ClientError> {
        self.flag(0x0815).await
    }
    pub async fn get_on_head_detection(&mut self) -> Result<bool, ClientError> {
        self.flag(0x0401).await
    }
    pub async fn get_smart_pause(&mut self) -> Result<bool, ClientError> {
        self.flag(0x080d).await
    }
    pub async fn get_battery(&mut self) -> Result<Percent, ClientError> {
        Percent::try_from(self.byte(0x0603, 100).await?)
            .map_err(|e| ClientError::Invalid(e.to_string()))
    }
    pub async fn get_transparency(&mut self) -> Result<Percent, ClientError> {
        Percent::try_from(self.byte(0x1a03, 100).await?)
            .map_err(|e| ClientError::Invalid(e.to_string()))
    }
    pub async fn set_adaptive(&mut self, status: bool) -> Result<(), ClientError> {
        self.write(0x1a00, &[3, status.into()]).await
    }
    pub async fn set_anti_wind(&mut self, mode: AntiWind) -> Result<(), ClientError> {
        self.write(
            0x1a00,
            &[
                1,
                match mode {
                    AntiWind::Off => 0,
                    AntiWind::Max => 1,
                    AntiWind::Auto => 2,
                },
            ],
        )
        .await
    }
    pub async fn set_anc(&mut self, status: bool) -> Result<(), ClientError> {
        self.write_flag(0x1a04, status).await
    }
    pub async fn set_auto_answer(&mut self, status: bool) -> Result<(), ClientError> {
        self.write_flag(0x080a, status).await
    }
    pub async fn set_comfort_call(&mut self, status: bool) -> Result<(), ClientError> {
        self.write_flag(0x0814, status).await
    }
    pub async fn set_on_head_detection(&mut self, status: bool) -> Result<(), ClientError> {
        self.write_flag(0x0400, status).await
    }
    pub async fn set_smart_pause(&mut self, status: bool) -> Result<(), ClientError> {
        self.write_flag(0x080c, status).await
    }
    pub async fn set_transparency(&mut self, level: Percent) -> Result<(), ClientError> {
        self.write(0x1a02, &[level.into()]).await
    }
    pub async fn get_multipoint(&mut self) -> Result<bool, ClientError> {
        protocol::boolean(&self.request(QUALCOMM, 0x0e10, &[]).await?).map_err(ClientError::Invalid)
    }
    pub async fn set_multipoint(&mut self, enabled: bool) -> Result<(), ClientError> {
        let p = self.request(QUALCOMM, 0x0e00, &[enabled.into()]).await?;
        if !p.is_empty() {
            return Err(ClientError::Invalid(
                "nonempty multipoint acknowledgement".into(),
            ));
        }
        Ok(())
    }
    pub async fn peer(&mut self, index: u8) -> Result<Peer, ClientError> {
        protocol::decode_peer(&self.read(0x1401, &[index]).await?, index)
            .map_err(ClientError::Invalid)
    }
    pub async fn connections(&mut self) -> Result<Connections, ClientError> {
        let p = self.read(0x1400, &[]).await?;
        if p.len() != 2 {
            return Err(ClientError::Invalid("paired count must be u16".into()));
        }
        let count = u16::from_be_bytes([p[0], p[1]]);
        if !(1..=16).contains(&count) {
            return Err(ClientError::Invalid(
                "paired count outside supported limits".into(),
            ));
        }
        let own_index = self.byte(0x1407, 15).await?;
        let capacity = self.byte(0x1409, 2).await?;
        if own_index >= count as u8 || capacity == 0 {
            return Err(ClientError::Invalid("invalid own index or capacity".into()));
        }
        let mut peers = Vec::new();
        for index in 0..count as u8 {
            peers.push(self.peer(index).await?);
        }
        if !peers[usize::from(own_index)].connected {
            return Err(ClientError::Invalid("control host is not connected".into()));
        }
        Ok(Connections {
            capacity,
            own_index,
            peers,
        })
    }
    pub async fn peer_connected(&mut self, index: u8) -> Result<bool, ClientError> {
        let p = self.read(0x1404, &[index]).await?;
        if p.len() != 2 || p[0] != index {
            return Err(ClientError::Invalid(
                "connection-status index mismatch".into(),
            ));
        }
        protocol::boolean(&p[1..]).map_err(ClientError::Invalid)
    }
    pub async fn change_peer(&mut self, index: u8, connected: bool) -> Result<(), ClientError> {
        self.write(if connected { 0x1402 } else { 0x1403 }, &[index])
            .await
    }
    pub async fn wait_peer(&mut self, index: u8, connected: bool) -> Result<(), ClientError> {
        let end = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            if self.peer_connected(index).await? == connected {
                return Ok(());
            }
            if tokio::time::Instant::now() >= end {
                return Err(ClientError::Timeout);
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
    pub async fn byte_sound_mode(&mut self) -> Result<u8, ClientError> {
        let p = self.read(0x0804, &[]).await?;
        if p.len() != 2 || p[0] != 0 || p[1] > 3 {
            return Err(ClientError::Invalid("invalid sound mode".into()));
        }
        Ok(p[1])
    }
    pub async fn auto_power_off(&mut self) -> Result<u16, ClientError> {
        let p = self.read(0x0601, &[0]).await?;
        if p.len() != 3 || p[0] != 0 {
            return Err(ClientError::Invalid("invalid auto power-off timer".into()));
        }
        Ok(u16::from_be_bytes([p[1], p[2]]))
    }
    pub async fn eq_config(&mut self) -> Result<Equalizer, ClientError> {
        let p = self.read(0x1000, &[]).await?;
        if p.len() < 3 || p[0] == 0 || p[0] > 16 || (p[1] as i8) >= (p[2] as i8) {
            return Err(ClientError::Invalid("invalid EQ configuration".into()));
        }
        Ok(Equalizer {
            min_gain: p[1] as i8,
            max_gain: p[2] as i8,
            gains: vec![0; usize::from(p[0])],
        })
    }
    pub async fn equalizer(&mut self) -> Result<Equalizer, ClientError> {
        let mut eq = self.eq_config().await?;
        for index in 0..eq.gains.len() {
            let p = self.read(0x1002, &[index as u8]).await?;
            let value = match p.as_slice() {
                [gain] => *gain as i8,
                [band, gain] if usize::from(*band) == index => *gain as i8,
                _ => return Err(ClientError::Invalid("invalid EQ band response".into())),
            };
            if value < eq.min_gain || value > eq.max_gain {
                return Err(ClientError::Invalid(
                    "EQ gain outside reported limits".into(),
                ));
            }
            eq.gains[index] = value;
        }
        Ok(eq)
    }
    pub async fn set_eq_preset(&mut self, gains: &[i8]) -> Result<(), ClientError> {
        let before = self.equalizer().await?;
        if gains.len() != before.gains.len()
            || gains
                .iter()
                .any(|gain| *gain < before.min_gain || *gain > before.max_gain)
        {
            return Err(ClientError::Invalid(
                "EQ preset does not match the headset's band count or gain limits".into(),
            ));
        }
        let mode = self.byte_sound_mode().await?;
        let operation = async {
            if mode != 1 {
                self.write(0x0803, &[0, 1]).await?;
            }
            for (band, gain) in gains.iter().enumerate() {
                if *gain != before.gains[band] {
                    self.write(0x1001, &[band as u8, *gain as u8]).await?;
                }
            }
            if self.equalizer().await?.gains != gains {
                return Err(ClientError::Invalid("EQ preset readback mismatch".into()));
            }
            Ok::<(), ClientError>(())
        }
        .await;
        if let Err(error) = operation {
            let rollback = async {
                let actual = self.equalizer().await?;
                for (band, gain) in before.gains.iter().enumerate() {
                    if actual.gains[band] != *gain {
                        self.write(0x1001, &[band as u8, *gain as u8]).await?;
                    }
                }
                if mode != 1 {
                    self.write(0x0803, &[0, mode]).await?;
                }
                if self.equalizer().await?.gains != before.gains
                    || self.byte_sound_mode().await? != mode
                {
                    return Err(ClientError::Invalid(
                        "EQ restoration readback mismatch".into(),
                    ));
                }
                Ok::<(), ClientError>(())
            }
            .await;
            return Err(ClientError::Invalid(match rollback {
                Ok(()) => format!("EQ preset failed; restored previous EQ: {error}"),
                Err(restore) => {
                    format!("EQ preset failed: {error}; restoration also failed: {restore}")
                }
            }));
        }
        Ok(())
    }

    pub async fn set_eq(&mut self, band: u8, gain: i8) -> Result<(), ClientError> {
        let eq = self.eq_config().await?;
        if usize::from(band) >= eq.gains.len() || gain < eq.min_gain || gain > eq.max_gain {
            return Err(ClientError::Invalid(
                "EQ band or gain outside headset limits".into(),
            ));
        }
        self.write(0x1001, &[band, gain as u8]).await?;
        let p = self.read(0x1002, &[band]).await?;
        if p != vec![gain as u8] && p != vec![band, gain as u8] {
            return Err(ClientError::Invalid("EQ change not confirmed".into()));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    #[tokio::test]
    async fn notification_wrong_vendor_and_rejection() {
        let (a, mut b) = tokio::io::duplex(256);
        let task = tokio::spawn(async move {
            let mut request = [0; 8];
            b.read_exact(&mut request).await.unwrap();
            assert_eq!(request, [0xff, 3, 0, 0, 0, 0x1d, 0x0e, 0x10]);
            b.write_all(&[
                0xff, 3, 0, 1, 4, 0x95, 0x0f, 0x10, 0, 0xff, 3, 0, 1, 0, 0x1d, 0x0e, 0x90, 0, 0xff,
                3, 0, 1, 0, 0x1d, 0x0f, 0x10, 1,
            ])
            .await
            .unwrap();
            b.read_exact(&mut request).await.unwrap();
            b.write_all(&[0xff, 3, 0, 1, 4, 0x95, 0x05, 0x86, 1])
                .await
                .unwrap();
        });
        let mut client = Client::new(a);
        assert!(client.get_multipoint().await.unwrap());
        assert!(matches!(
            client.byte(0x0406, 1).await,
            Err(ClientError::Rejected {
                command: 0x0406,
                ..
            })
        ));
        task.await.unwrap();
    }

    #[tokio::test]
    async fn partial_eq_preset_failure_restores_gains_and_sound_mode() {
        let (host, headset) = tokio::io::duplex(4096);
        let server = tokio::spawn(async move {
            let mut framed = Framed::new(headset, GaiaCodec);
            let mut gains = [0u8; 5];
            let mut mode = 2;
            let mut writes = Vec::new();
            while let Some(request) = framed.next().await {
                let request = request.unwrap();
                let mut command = request.command | 0x100;
                let payload = match request.command {
                    0x1000 => vec![5, (-60i8) as u8, 60, 0, 0],
                    0x1002 => vec![gains[usize::from(request.payload[0])]],
                    0x0804 => vec![0, mode],
                    0x0803 => {
                        mode = request.payload[1];
                        writes.push((request.command, request.payload));
                        vec![]
                    }
                    0x1001 => {
                        writes.push((request.command, request.payload.clone()));
                        if request.payload == [1, 20] {
                            command = request.command | 0x180;
                            vec![1]
                        } else {
                            gains[usize::from(request.payload[0])] = request.payload[1];
                            vec![]
                        }
                    }
                    command => panic!("unexpected EQ request {command:x}"),
                };
                framed
                    .send(Frame {
                        vendor: SENNHEISER,
                        command,
                        payload,
                    })
                    .await
                    .unwrap();
            }
            (gains, mode, writes)
        });
        let mut client = Client::new(host);
        let error = client.set_eq_preset(&[10, 20, 0, 0, 0]).await.unwrap_err();
        assert!(error.to_string().contains("restored previous EQ"));
        drop(client);
        let (gains, mode, writes) = server.await.unwrap();
        assert_eq!(gains, [0; 5]);
        assert_eq!(mode, 2);
        assert_eq!(
            writes,
            vec![
                (0x0803, vec![0, 1]),
                (0x1001, vec![0, 10]),
                (0x1001, vec![1, 20]),
                (0x1001, vec![0, 0]),
                (0x0803, vec![0, 2])
            ]
        );
    }
}
