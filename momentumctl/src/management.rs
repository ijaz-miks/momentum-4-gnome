use crate::{
    ble::Headset,
    cli::{Cli, Commands, ConnectionCommands, SetCommands},
    client::{Client, ClientError},
    protocol::{self, Connections, Peer},
};
use anyhow::{Context, Result, bail};
use bluer::rfcomm::Stream;
use serde_json::{Map, Value, json};
use std::time::Duration;

pub async fn run(cli: &Cli, headset: &Headset) -> Result<()> {
    if matches!(cli.command, Commands::Reconnect) {
        drop(headset.connect(true).await?);
        println!("Connected to {}", headset.name);
        return Ok(());
    }
    let mut client = Client::new(headset.connect(false).await?);
    match &cli.command {
        Commands::Inspect { .. } => println!(
            "{}",
            serde_json::to_string_pretty(&inspect(&mut client, headset).await?)?
        ),
        Commands::Connections(ConnectionCommands::List { json }) => {
            let state = client.connections().await?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&state)?);
            } else {
                println!("Active connection limit: {}", state.capacity);
                for peer in &state.peers {
                    println!(
                        "{}: {} ({}){}",
                        peer.index,
                        peer.name,
                        if peer.connected {
                            "connected"
                        } else {
                            "disconnected"
                        },
                        if peer.index == state.own_index {
                            " [this computer]"
                        } else {
                            ""
                        }
                    );
                }
            }
        }
        Commands::Connections(action) => switch(&mut client, action).await?,
        Commands::Set(SetCommands::Multipoint { status }) => {
            let target = bool::from(*status);
            if client.get_multipoint().await? == target {
                return Ok(());
            }
            let acknowledgement = client.set_multipoint(target).await;
            drop(client);
            // Firmware closes RFCOMM when disabling multipoint. Never repeat the
            // setter after an uncertain acknowledgement; reopen and read actual state.
            tokio::time::sleep(Duration::from_millis(750)).await;
            let mut recovered = recover(headset).await?;
            if recovered.get_multipoint().await? != target {
                return Err(anyhow::anyhow!(
                    "multipoint did not change to the requested state; acknowledgement: {acknowledgement:?}"
                ));
            }
            let expected = if target { 2 } else { 1 };
            if recovered.connections().await?.capacity != expected {
                bail!("multipoint state and connection limit disagree");
            }
        }
        Commands::Set(SetCommands::AudioPriority { mode }) => {
            if client.byte(0x0406, 1).await? == *mode {
                return Ok(());
            }
            let previous_connections = client.connections().await?;
            let acknowledgement = client.write(0x0405, &[*mode]).await;
            drop(client);
            tokio::time::sleep(Duration::from_millis(750)).await;
            let mut recovered = recover(headset).await?;
            if recovered.byte(0x0406, 1).await? != *mode {
                bail!("audio priority was not confirmed; acknowledgement: {acknowledgement:?}");
            }
            restore_connected_peers(&mut recovered, &previous_connections).await
                .context("audio priority changed, but a previous source connection could not be restored")?;
        }
        Commands::Set(SetCommands::Name { name }) => {
            if name.is_empty() || name.len() > 32 || name.chars().any(char::is_control) {
                bail!("name must contain 1..=32 UTF-8 bytes without control characters");
            }
            client.write(0x2801, name.as_bytes()).await?;
            let returned = client.read(0x2802, &[]).await?;
            if returned.strip_suffix(&[0]).unwrap_or(&returned) != name.as_bytes() {
                bail!("headset name change was not confirmed");
            }
        }
        _ => cli.run(client).await?,
    }
    Ok(())
}

async fn recover(headset: &Headset) -> Result<Client<Stream>> {
    let operation = async {
        let mut last_error = String::new();
        for _ in 0..5 {
            match headset.connect(true).await {
                Ok(stream) => {
                    let mut client = Client::new(stream);
                    match client.get_battery().await {
                        Ok(_) => return Ok(client),
                        Err(error) => last_error = error.to_string(),
                    }
                }
                Err(error) => last_error = error.to_string(),
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        bail!("could not restore the headset control connection: {last_error}")
    };
    tokio::time::timeout(Duration::from_secs(18), operation)
        .await
        .map_err(|_| {
            anyhow::anyhow!("Bluetooth recovery timed out; reconnect the headset and refresh")
        })?
}

fn checked_peer<'a>(state: &'a Connections, index: u8, name: &str) -> Result<&'a Peer> {
    if index == state.own_index {
        bail!("cannot disconnect or switch this computer's control connection");
    }
    let peer = state
        .peers
        .iter()
        .find(|peer| peer.index == index)
        .context("paired-device index is no longer present")?;
    if peer.name != name {
        bail!("paired-device identity changed; refresh the list before trying again");
    }
    Ok(peer)
}
async fn check_identity<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    client: &mut Client<S>,
    peer: &Peer,
) -> Result<()> {
    if client.peer(peer.index).await?.name != peer.name {
        bail!("paired-device identity changed during transaction");
    }
    Ok(())
}
async fn switch<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    client: &mut Client<S>,
    action: &ConnectionCommands,
) -> Result<()> {
    let (index, name, want_connected, replace) = match action {
        ConnectionCommands::Connect { index, expect_name } => (*index, expect_name, true, false),
        ConnectionCommands::Switch { index, expect_name } => (*index, expect_name, true, true),
        ConnectionCommands::Disconnect { index, expect_name } => {
            (*index, expect_name, false, false)
        }
        ConnectionCommands::List { .. } => unreachable!(),
    };
    let before = client.connections().await?;
    let target = checked_peer(&before, index, name)?.clone();
    if target.connected == want_connected {
        return Ok(());
    }
    let mut displaced = None;
    if want_connected {
        if before.capacity < 2 {
            bail!("enable multipoint before connecting another source");
        }
        let active = before.peers.iter().filter(|peer| peer.connected).count();
        if active >= usize::from(before.capacity) {
            if !replace {
                bail!("both connection slots are occupied; use connections switch");
            }
            let victim = before
                .peers
                .iter()
                .filter(|peer| {
                    peer.connected && peer.index != before.own_index && peer.index != index
                })
                .max_by_key(|peer| peer.priority)
                .context("no replaceable connection slot")?
                .clone();
            check_identity(client, &victim).await?;
            client.change_peer(victim.index, false).await?;
            client.wait_peer(victim.index, false).await?;
            displaced = Some(victim);
        }
    }
    let operation = async {
        check_identity(client, &target).await?;
        client.change_peer(index, want_connected).await?;
        client.wait_peer(index, want_connected).await?;
        if !client.peer_connected(before.own_index).await? {
            bail!("this computer's connection was lost");
        }
        check_identity(client, &target).await?;
        Ok::<(), anyhow::Error>(())
    }
    .await;
    if let Err(error) = operation {
        if let Some(previous) = displaced {
            let rollback = async {
                check_identity(client, &target).await?;
                if client.peer_connected(index).await? {
                    client.change_peer(index, false).await?;
                    client.wait_peer(index, false).await?;
                }
                check_identity(client, &previous).await?;
                if !client.peer_connected(previous.index).await? {
                    client.change_peer(previous.index, true).await?;
                    client.wait_peer(previous.index, true).await?;
                }
                Ok::<(), anyhow::Error>(())
            }
            .await;
            match rollback {
                Ok(()) => bail!("switch failed; restored {}: {error}", previous.name),
                Err(rollback) => bail!(
                    "switch failed: {error}; restoring {} also failed: {rollback}",
                    previous.name
                ),
            }
        }
        return Err(error);
    }
    println!(
        "{} {}",
        if want_connected {
            "Connected"
        } else {
            "Disconnected"
        },
        target.name
    );
    Ok(())
}
async fn restore_connected_peers<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    client: &mut Client<S>,
    before: &Connections,
) -> Result<()> {
    for previous in before
        .peers
        .iter()
        .filter(|peer| peer.connected && peer.index != before.own_index)
    {
        let actual = client.connections().await?;
        let peer = checked_peer(&actual, previous.index, &previous.name)?;
        if peer.connected {
            continue;
        }
        if actual.peers.iter().filter(|peer| peer.connected).count() >= usize::from(actual.capacity)
        {
            bail!("no free slot while restoring {}", previous.name);
        }
        let acknowledgement = client.change_peer(previous.index, true).await;
        // Read actual state even after an uncertain acknowledgement, without
        // repeating the connect request.
        client
            .wait_peer(previous.index, true)
            .await
            .with_context(|| {
                format!(
                    "restoring {} was not confirmed: {acknowledgement:?}",
                    previous.name
                )
            })?;
        if !client.peer_connected(actual.own_index).await? {
            bail!("control host disconnected during source restoration");
        }
        check_identity(client, previous).await?;
    }
    Ok(())
}

async fn optional(
    client: &mut Client<Stream>,
    command: u16,
    payload: &[u8],
    key: &str,
    unsupported: &mut Map<String, Value>,
) -> Result<Option<Vec<u8>>> {
    match client.read(command, payload).await {
        Ok(p) => Ok(Some(p)),
        Err(error @ ClientError::Rejected { .. }) => {
            unsupported.insert(key.into(), json!(error.to_string()));
            Ok(None)
        }
        Err(error) => Err(error.into()),
    }
}
async fn optional_byte(
    client: &mut Client<Stream>,
    command: u16,
    key: &str,
    max: u8,
    settings: &mut Map<String, Value>,
    unsupported: &mut Map<String, Value>,
) -> Result<()> {
    let value = match optional(client, command, &[], key, unsupported).await? {
        Some(p) => json!(protocol::bounded_byte(&p, max).map_err(anyhow::Error::msg)?),
        None => Value::Null,
    };
    settings.insert(key.into(), value);
    Ok(())
}
async fn optional_flag(
    client: &mut Client<Stream>,
    command: u16,
    key: &str,
    settings: &mut Map<String, Value>,
    unsupported: &mut Map<String, Value>,
) -> Result<()> {
    let value = match optional(client, command, &[], key, unsupported).await? {
        Some(p) => json!(protocol::boolean(&p).map_err(anyhow::Error::msg)?),
        None => Value::Null,
    };
    settings.insert(key.into(), value);
    Ok(())
}
async fn inspect(client: &mut Client<Stream>, headset: &Headset) -> Result<Value> {
    let (adaptive, anti_wind) = client.get_mode().await?;
    let mut settings = Map::new();
    settings.insert("adaptive".into(), json!(adaptive));
    settings.insert(
        "antiWind".into(),
        json!(match anti_wind {
            protocol::AntiWind::Off => "off",
            protocol::AntiWind::Auto => "auto",
            protocol::AntiWind::Max => "max",
        }),
    );
    settings.insert("anc".into(), json!(client.get_anc().await?));
    settings.insert("autoAnswer".into(), json!(client.get_auto_answer().await?));
    settings.insert(
        "battery".into(),
        json!(u8::from(client.get_battery().await?)),
    );
    settings.insert(
        "comfortCall".into(),
        json!(client.get_comfort_call().await?),
    );
    settings.insert(
        "onHeadDetection".into(),
        json!(client.get_on_head_detection().await?),
    );
    settings.insert("smartPause".into(), json!(client.get_smart_pause().await?));
    settings.insert(
        "transparency".into(),
        json!(u8::from(client.get_transparency().await?)),
    );
    let mut unsupported = Map::new();
    match client.get_multipoint().await {
        Ok(value) => {
            settings.insert("multipoint".into(), json!(value));
        }
        Err(error @ ClientError::Rejected { .. }) => {
            settings.insert("multipoint".into(), Value::Null);
            unsupported.insert("multipoint".into(), json!(error.to_string()));
        }
        Err(error) => return Err(error.into()),
    }
    optional_flag(client, 0x1009, "bassBoost", &mut settings, &mut unsupported).await?;
    optional_flag(client, 0x1607, "touchLock", &mut settings, &mut unsupported).await?;
    optional_flag(
        client,
        0x0818,
        "lowLatency",
        &mut settings,
        &mut unsupported,
    )
    .await?;
    optional_byte(
        client,
        0x0806,
        "sidetone",
        5,
        &mut settings,
        &mut unsupported,
    )
    .await?;
    optional_byte(
        client,
        0x0802,
        "promptMode",
        2,
        &mut settings,
        &mut unsupported,
    )
    .await?;
    optional_byte(
        client,
        0x0406,
        "audioPriority",
        1,
        &mut settings,
        &mut unsupported,
    )
    .await?;
    let sound_mode = optional(client, 0x0804, &[], "soundMode", &mut unsupported).await?;
    settings.insert(
        "soundMode".into(),
        match sound_mode {
            Some(p) if p.len() == 2 && p[0] == 0 && p[1] <= 3 => json!(p[1]),
            Some(_) => bail!("invalid sound mode response"),
            None => Value::Null,
        },
    );
    let timer = optional(client, 0x0601, &[0], "autoPowerOff", &mut unsupported).await?;
    settings.insert(
        "autoPowerOff".into(),
        match timer {
            Some(p) if p.len() == 3 && p[0] == 0 => json!(u16::from_be_bytes([p[1], p[2]])),
            Some(_) => bail!("invalid power-off timer"),
            None => Value::Null,
        },
    );
    let eq = match client.equalizer().await {
        Ok(eq) => Some(eq),
        Err(error @ ClientError::Rejected { .. }) => {
            unsupported.insert("equalizer".into(), json!(error.to_string()));
            None
        }
        Err(error) => return Err(error.into()),
    };
    if let Some(eq) = &eq {
        for (index, gain) in eq.gains.iter().enumerate() {
            settings.insert(format!("eq{index}"), json!(gain));
        }
    }
    let firmware = client.read(0x1201, &[]).await?;
    if firmware.len() != 6 {
        bail!("invalid firmware version");
    }
    let firmware = firmware
        .as_chunks::<2>()
        .0
        .iter()
        .map(|p| u16::from_be_bytes([p[0], p[1]]).to_string())
        .collect::<Vec<_>>()
        .join(".");
    let codec = client.byte(0x0800, 255).await?;
    let wear_state = optional(client, 0x0402, &[], "wearState", &mut unsupported)
        .await?
        .map(|p| protocol::bounded_byte(&p, 3).map_err(anyhow::Error::msg))
        .transpose()?;
    let prompt_language = optional(client, 0x0807, &[], "promptLanguage", &mut unsupported)
        .await?
        .map(|p| protocol::bounded_byte(&p, 7).map_err(anyhow::Error::msg))
        .transpose()?;
    let available_prompt_languages = optional(
        client,
        0x0808,
        &[],
        "availablePromptLanguages",
        &mut unsupported,
    )
    .await?;
    let personalization_state = optional(
        client,
        0x2001,
        &[],
        "personalizationState",
        &mut unsupported,
    )
    .await?
    .map(|p| protocol::bounded_byte(&p, 3).map_err(anyhow::Error::msg))
    .transpose()?;
    let local_name = optional(client, 0x2802, &[], "name", &mut unsupported)
        .await?
        .map(|p| String::from_utf8(p.strip_suffix(&[0]).unwrap_or(&p).to_vec()))
        .transpose()?;
    let connections = client.connections().await?;
    Ok(json!({
        "schemaVersion":1,
        "device":{"address":headset.address.to_string(),"name":local_name.unwrap_or_else(||headset.name.clone()),"firmware":firmware,
            "codec":codec,"wearState":wear_state,"promptLanguage":prompt_language,"availablePromptLanguages":available_prompt_languages,
            "personalizationState":personalization_state},
        "settings":settings,"connections":connections,"equalizer":eq,"unsupported":unsupported
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state() -> Connections {
        Connections {
            capacity: 2,
            own_index: 0,
            peers: vec![
                Peer {
                    index: 0,
                    priority: 1,
                    connected: true,
                    name: "Ubuntu".into(),
                },
                Peer {
                    index: 1,
                    priority: 0,
                    connected: true,
                    name: "Windows".into(),
                },
                Peer {
                    index: 2,
                    priority: 2,
                    connected: false,
                    name: "Phone".into(),
                },
            ],
        }
    }
    #[test]
    fn own_host_and_changed_identity_are_rejected() {
        let state = state();
        assert!(checked_peer(&state, 0, "Ubuntu").is_err());
        assert!(checked_peer(&state, 1, "Other PC").is_err());
        assert_eq!(checked_peer(&state, 1, "Windows").unwrap().index, 1);
        assert!(checked_peer(&state, 9, "Missing").is_err());
    }

    async fn simulated_switch(
        reject_target: bool,
        restore: bool,
    ) -> (Result<()>, Connections, Vec<(u16, u8)>) {
        use crate::codec::{Frame, GaiaCodec, SENNHEISER};
        use futures_util::{SinkExt, StreamExt};
        let (host, headset) = tokio::io::duplex(4096);
        let baseline = state();
        let server = tokio::spawn(async move {
            let mut framed = tokio_util::codec::Framed::new(headset, GaiaCodec);
            let mut state = state();
            if restore {
                state.peers[1].connected = false;
            }
            let mut writes = Vec::new();
            let mut pending = None;
            while let Some(request) = framed.next().await {
                let request = request.unwrap();
                assert_eq!(request.vendor, SENNHEISER);
                let mut command = request.command | 0x100;
                let payload = match request.command {
                    0x1400 => vec![0, state.peers.len() as u8],
                    0x1407 => vec![state.own_index],
                    0x1409 => vec![state.capacity],
                    0x1401 => {
                        let peer = &state.peers[usize::from(request.payload[0])];
                        let mut bytes = vec![peer.index, peer.priority, peer.connected.into()];
                        bytes.extend_from_slice(peer.name.as_bytes());
                        bytes.push(0);
                        bytes
                    }
                    0x1404 => {
                        let index = request.payload[0];
                        if let Some((target, remaining)) = pending {
                            if target == index {
                                if remaining == 0 {
                                    state.peers[usize::from(index)].connected = true;
                                    pending = None;
                                } else {
                                    pending = Some((target, remaining - 1));
                                }
                            }
                        }
                        vec![index, state.peers[usize::from(index)].connected.into()]
                    }
                    0x1402 | 0x1403 => {
                        let index = request.payload[0];
                        writes.push((request.command, index));
                        assert_ne!(
                            index, state.own_index,
                            "control host must never be disconnected"
                        );
                        if reject_target && request.command == 0x1402 && index == 2 {
                            command = request.command | 0x180;
                            vec![1]
                        } else {
                            if request.command == 0x1402 {
                                pending = Some((index, 2));
                            } else {
                                state.peers[usize::from(index)].connected = false;
                            }
                            vec![]
                        }
                    }
                    other => panic!("unexpected request {other:x}"),
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
            (state, writes)
        });
        let mut client = Client::new(host);
        let result = if restore {
            restore_connected_peers(&mut client, &baseline).await
        } else {
            switch(
                &mut client,
                &ConnectionCommands::Switch {
                    index: 2,
                    expect_name: "Phone".into(),
                },
            )
            .await
        };
        drop(client);
        let (state, writes) = server.await.unwrap();
        (result, state, writes)
    }
    #[tokio::test]
    async fn switching_waits_for_state_and_keeps_the_control_host() {
        let (result, state, writes) = simulated_switch(false, false).await;
        result.unwrap();
        assert!(state.peers[0].connected && state.peers[2].connected && !state.peers[1].connected);
        assert_eq!(writes, [(0x1403, 1), (0x1402, 2)]);
    }
    #[tokio::test]
    async fn rejected_target_restores_previous_connection_once() {
        let (result, state, writes) = simulated_switch(true, false).await;
        assert!(result.unwrap_err().to_string().contains("restored Windows"));
        assert!(state.peers[0].connected && state.peers[1].connected && !state.peers[2].connected);
        assert_eq!(writes, [(0x1403, 1), (0x1402, 2), (0x1402, 1)]);
    }

    #[tokio::test]
    async fn recovery_restores_the_previous_source_without_touching_the_host() {
        let (result, state, writes) = simulated_switch(false, true).await;
        result.unwrap();
        assert!(state.peers[0].connected && state.peers[1].connected && !state.peers[2].connected);
        assert_eq!(writes, [(0x1402, 1)]);
    }
}
