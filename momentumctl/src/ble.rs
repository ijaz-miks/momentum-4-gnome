use bluer::{
    Address, Device, Session,
    rfcomm::{SocketAddr, Stream},
};
use std::time::Duration;
use tokio::time::{sleep, timeout};
use uuid::{Uuid, uuid};
const GAIA_UUID: Uuid = uuid!("a2129ff3-081b-4c45-8afe-469d9c4842ec");
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

async fn connect_when_available<T, F: std::future::Future<Output = std::io::Result<T>>>(
    mut connect: impl FnMut() -> F,
) -> std::io::Result<T> {
    loop {
        match connect().await {
            Ok(stream) => return Ok(stream),
            // A previous CLI's closed channel can still be disconnecting in the kernel.
            Err(error) if error.raw_os_error() == Some(libc::EBUSY) => {
                sleep(Duration::from_millis(100)).await;
            }
            Err(error) => return Err(error),
        }
    }
}

async fn wait_connected(mut probe: impl FnMut() -> std::io::Result<()>) -> std::io::Result<()> {
    loop {
        match probe() {
            Ok(()) => return Ok(()),
            Err(error) if error.raw_os_error() == Some(libc::ENOTCONN) => {
                sleep(Duration::from_millis(20)).await;
            }
            Err(error) => return Err(error),
        }
    }
}

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
            let stream = connect_when_available(|| Stream::connect(peer)).await?;
            // Peer addresses exist before RFCOMM is ready; CONNINFO checks the connected state.
            wait_connected(|| {
                stream.as_ref().conn_info()?;
                if stream.peer_addr()? != peer {
                    return Err(std::io::Error::other("unexpected headset control peer"));
                }
                Ok(())
            })
            .await?;
            Ok::<_, std::io::Error>(stream)
        })
        .await
        .map_err(|_| anyhow::anyhow!("headset control connection timed out"))?
        .map_err(Into::into)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn busy_channels_wait_without_retrying_other_connection_errors() {
        let mut attempts = 0;
        let connected = connect_when_available(|| {
            attempts += 1;
            std::future::ready(if attempts < 3 {
                Err(std::io::Error::from_raw_os_error(libc::EBUSY))
            } else {
                Ok(42)
            })
        })
        .await
        .unwrap();
        assert_eq!((connected, attempts), (42, 3));
        let error = connect_when_available(|| {
            std::future::ready(Err::<(), _>(std::io::Error::from_raw_os_error(
                libc::EACCES,
            )))
        })
        .await
        .unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::EACCES));
    }

    #[tokio::test]
    async fn connection_must_be_ready_before_returning() {
        let mut probes = 0;
        wait_connected(|| {
            probes += 1;
            if probes < 3 {
                Err(std::io::Error::from_raw_os_error(libc::ENOTCONN))
            } else {
                Ok(())
            }
        })
        .await
        .unwrap();
        assert_eq!(probes, 3);
    }

    #[tokio::test]
    async fn failed_connections_are_not_retried_and_pending_ones_can_be_cancelled() {
        let error = wait_connected(|| Err(std::io::Error::from_raw_os_error(libc::ECONNREFUSED)))
            .await
            .unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::ECONNREFUSED));
        assert!(
            timeout(
                Duration::from_millis(25),
                wait_connected(|| { Err(std::io::Error::from_raw_os_error(libc::ENOTCONN)) })
            )
            .await
            .is_err()
        );
    }
}
