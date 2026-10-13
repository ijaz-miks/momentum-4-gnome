use bluer::{
    Address, Device, Session,
    rfcomm::{SocketAddr, Stream},
};
use std::time::Duration;
use tokio::time::{sleep, timeout};
use uuid::{Uuid, uuid};
const GAIA_UUID: Uuid = uuid!("a2129ff3-081b-4c45-8afe-469d9c4842ec");
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

pub struct Headset {
    // Retain the D-Bus session for the entire operation.
    _session: Session,
    pub device: Device,
    pub address: Address,
    pub name: String,
}
pub async fn select(address: Option<&str>) -> anyhow::Result<Headset> {
    let wanted = address.map(str::parse::<Address>).transpose()?;
    let session = Session::new().await?;
    let mut candidates = Vec::new();
    for adapter_name in session.adapter_names().await? {
        let adapter = session.adapter(&adapter_name)?;
        for addr in adapter.device_addresses().await? {
            if wanted.is_some_and(|wanted| wanted != addr) {
                continue;
            }
            let device = adapter.device(addr)?;
            if !device.is_paired().await? {
                continue;
            }
            if !device
                .uuids()
                .await?
                .unwrap_or_default()
                .contains(&GAIA_UUID)
            {
                continue;
            }
            let name = device.name().await?.unwrap_or_else(|| addr.to_string());
            candidates.push((device, addr, name));
        }
    }
    if candidates.is_empty() {
        anyhow::bail!("no device found: pair a Momentum 4 headset in Bluetooth Settings");
    }
    if wanted.is_none() && candidates.len() > 1 {
        anyhow::bail!("multiple compatible headsets found; select one using --device MAC");
    }
    let (device, address, name) = candidates.remove(0);
    Ok(Headset {
        _session: session,
        device,
        address,
        name,
    })
}
impl Headset {
    pub async fn connect(&self, reconnect: bool) -> anyhow::Result<Stream> {
        if !self.device.is_connected().await? {
            if !reconnect {
                anyhow::bail!("no device found: headset disconnected");
            }
            timeout(CONNECT_TIMEOUT, self.device.connect())
                .await
                .map_err(|_| anyhow::anyhow!("Bluetooth reconnection timed out"))??;
        }
        // Momentum 4's GAIA SDP service uses RFCOMM channel 1. Unlike registering
        // a global BlueZ profile, a direct socket does not replace another app's profile.
        timeout(CONNECT_TIMEOUT, async {
            let peer = SocketAddr::new(self.address, 1);
            let stream = Stream::connect(peer).await?;
            // A newly registered nonblocking socket can report writable before
            // RFCOMM finishes connecting. SO_ERROR == 0 alone is not enough:
            // confirm the peer before the first GAIA write instead of failing
            // with ENOTCONN or opening another simultaneous control connection.
            loop {
                match stream.peer_addr() {
                    Ok(address) if address == peer => return Ok(stream),
                    Ok(_) => {
                        return Err(std::io::Error::other("unexpected headset control peer"));
                    }
                    Err(error) if error.raw_os_error() == Some(libc::ENOTCONN) => {
                        sleep(Duration::from_millis(20)).await;
                    }
                    Err(error) => return Err(error),
                }
            }
        })
        .await
        .map_err(|_| anyhow::anyhow!("headset control connection timed out"))?
        .map_err(Into::into)
    }
}
