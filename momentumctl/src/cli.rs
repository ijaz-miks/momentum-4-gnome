use std::fmt::Display;

use clap::{Parser, Subcommand, ValueEnum};
use tokio::io::{AsyncRead, AsyncWrite};

use crate::{client::Client, protocol::Percent};

#[derive(Parser)]
#[command(name = env!("CARGO_CRATE_NAME"), version)]
#[command(about = "CLI to control Sennheiser Momentum 4 headphones", long_about = None)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
    /// Select a paired headset by Bluetooth address.
    #[arg(long, global = true)]
    pub device: Option<String>,
}

impl Cli {
    pub async fn run<S: AsyncRead + AsyncWrite + Unpin>(
        &self,
        mut client: Client<S>,
    ) -> anyhow::Result<()> {
        match self.command {
            Commands::Get(GetCommands::Adaptive) => {
                let status: Status = client.get_adaptive().await?.into();
                println!("{status}");
            }
            Commands::Get(GetCommands::Anc) => {
                let status: Status = client.get_anc().await?.into();
                println!("{status}");
            }
            Commands::Get(GetCommands::AntiWind) => {
                let anti_wind: AntiWind = client.get_anti_wind().await?.into();
                println!("{anti_wind}");
            }
            Commands::Get(GetCommands::AutoAnswer) => {
                let status: Status = client.get_auto_answer().await?.into();
                println!("{status}");
            }
            Commands::Get(GetCommands::Battery) => {
                let charge = client.get_battery().await?;
                println!("{charge}%");
            }
            Commands::Get(GetCommands::ComfortCall) => {
                let status: Status = client.get_comfort_call().await?.into();
                println!("{status}");
            }
            Commands::Get(GetCommands::OnHeadDetection) => {
                let status: Status = client.get_on_head_detection().await?.into();
                println!("{status}");
            }
            Commands::Get(GetCommands::SmartPause) => {
                let status: Status = client.get_smart_pause().await?.into();
                println!("{status}");
            }
            Commands::Get(GetCommands::Transparency) => {
                let level = client.get_transparency().await?;
                println!("{level}%");
            }
            Commands::Set(SetCommands::Adaptive { status }) => {
                client.set_adaptive(status.into()).await?
            }
            Commands::Set(SetCommands::Anc { status }) => client.set_anc(status.into()).await?,
            Commands::Set(SetCommands::AntiWind { mode }) => {
                client.set_anti_wind(mode.into()).await?
            }
            Commands::Set(SetCommands::AutoAnswer { status }) => {
                client.set_auto_answer(status.into()).await?
            }
            Commands::Set(SetCommands::ComfortCall { status }) => {
                client.set_comfort_call(status.into()).await?
            }
            Commands::Set(SetCommands::OnHeadDetection { status }) => {
                client.set_on_head_detection(status.into()).await?
            }
            Commands::Set(SetCommands::SmartPause { status }) => {
                client.set_smart_pause(status.into()).await?
            }
            Commands::Set(SetCommands::Transparency { level }) => {
                client.set_transparency(level).await?
            }
            Commands::Get(GetCommands::Multipoint) => {
                println!("{}", Status::from(client.get_multipoint().await?))
            }
            Commands::Get(GetCommands::BassBoost) => {
                println!("{}", Status::from(client.flag(0x1009).await?))
            }
            Commands::Get(GetCommands::Sidetone) => println!("{}", client.byte(0x0806, 5).await?),
            Commands::Get(GetCommands::SoundMode) => {
                println!("{}", client.byte_sound_mode().await?)
            }
            Commands::Get(GetCommands::AutoPowerOff) => {
                println!("{}", client.auto_power_off().await?)
            }
            Commands::Get(GetCommands::PromptMode) => println!("{}", client.byte(0x0802, 2).await?),
            Commands::Get(GetCommands::TouchLock) => {
                println!("{}", Status::from(client.flag(0x1607).await?))
            }
            Commands::Get(GetCommands::LowLatency) => {
                println!("{}", Status::from(client.flag(0x0818).await?))
            }
            Commands::Get(GetCommands::AudioPriority) => {
                println!("{}", client.byte(0x0406, 1).await?)
            }
            Commands::Get(GetCommands::Eq) => {
                println!("{}", serde_json::to_string(&client.equalizer().await?)?)
            }
            Commands::Set(SetCommands::EqPreset { ref gains }) => {
                client.set_eq_preset(gains).await?
            }
            Commands::Set(SetCommands::BassBoost { status }) => {
                client.write(0x1008, &[bool::from(status).into()]).await?
            }
            Commands::Set(SetCommands::Sidetone { level }) => {
                client.write(0x0805, &[level]).await?
            }
            Commands::Set(SetCommands::SoundMode { mode }) => {
                if mode == 3 && client.byte(0x2001, 3).await? != 2 {
                    anyhow::bail!(
                        "no calibrated Sound Personalization profile exists on the headset"
                    );
                }
                client.write(0x0803, &[0, mode]).await?
            }
            Commands::Set(SetCommands::AutoPowerOff { seconds }) => {
                let [high, low] = seconds.to_be_bytes();
                client.write(0x0600, &[0, high, low]).await?
            }
            Commands::Set(SetCommands::PromptMode { mode }) => {
                client.write(0x0801, &[mode]).await?
            }
            Commands::Set(SetCommands::TouchLock { status }) => {
                client.write(0x1606, &[bool::from(status).into()]).await?
            }
            Commands::Set(SetCommands::LowLatency { status }) => {
                client.write(0x0817, &[bool::from(status).into()]).await?
            }
            Commands::Set(SetCommands::Eq { band, gain }) => client.set_eq(band, gain).await?,
            // These transactions require the selected BlueZ device for recovery.
            Commands::Inspect { .. }
            | Commands::Connections(_)
            | Commands::Reconnect
            | Commands::Set(
                SetCommands::Multipoint { .. }
                | SetCommands::AudioPriority { .. }
                | SetCommands::Name { .. },
            ) => anyhow::bail!("operation must run through the headset transaction manager"),
            Commands::Status => {
                let adaptive: Status = client.get_adaptive().await?.into();
                let anc: Status = client.get_anc().await?.into();
                let anti_wind: AntiWind = client.get_anti_wind().await?.into();
                let auto_answer: Status = client.get_auto_answer().await?.into();
                let battery = client.get_battery().await?;
                let comfort_call: Status = client.get_comfort_call().await?.into();
                let on_head_detection: Status = client.get_on_head_detection().await?.into();
                let smart_pause: Status = client.get_smart_pause().await?.into();
                let transparency = client.get_transparency().await?;
                println!(
                    "Adaptive:          {adaptive}
ANC:               {anc}
Anti-wind:         {anti_wind}
Auto-answer:       {auto_answer}
Battery:           {battery}%
Comfort call:      {comfort_call}
On-head detection: {on_head_detection}
Smart pause:       {smart_pause}
Transparency:      {transparency}%",
                );
            }
        }

        Ok(())
    }
}

#[derive(Subcommand)]
pub enum Commands {
    /// Get device settings.
    #[command(subcommand)]
    Get(GetCommands),
    /// Change device settings.
    #[command(subcommand)]
    Set(SetCommands),
    /// Show an overview of device settings.
    Status,
    /// Complete machine-readable headset snapshot, including connections and optional controls.
    Inspect {
        #[arg(long)]
        json: bool,
    },
    /// List and manage the headset's paired source devices.
    #[command(subcommand)]
    Connections(ConnectionCommands),
    /// Reconnect the selected paired headset to this computer.
    Reconnect,
}

#[derive(Subcommand)]
pub enum ConnectionCommands {
    List {
        #[arg(long)]
        json: bool,
    },
    /// Connect a peer without replacing another active connection.
    Connect {
        index: u8,
        #[arg(long)]
        expect_name: String,
    },
    /// Replace the other active source while keeping this computer connected.
    Switch {
        index: u8,
        #[arg(long)]
        expect_name: String,
    },
    /// Disconnect another source, preserving this computer's control channel.
    Disconnect {
        index: u8,
        #[arg(long)]
        expect_name: String,
    },
}

#[derive(Subcommand)]
pub enum GetCommands {
    /// Adaptive noise control status.
    Adaptive,
    /// Active noise-cancelling status.
    Anc,
    /// Anti-wind noise-cancelling mode.
    AntiWind,
    /// Auto-answer status.
    AutoAnswer,
    /// Battery level.
    Battery,
    /// Comfort call status.
    ComfortCall,
    /// On-head detection.
    OnHeadDetection,
    /// Smart pause status.
    SmartPause,
    /// Noise-cancelling transparency level.
    Transparency,
    Multipoint,
    BassBoost,
    Sidetone,
    SoundMode,
    AutoPowerOff,
    PromptMode,
    TouchLock,
    LowLatency,
    AudioPriority,
    Eq,
}

#[derive(Subcommand)]
pub enum SetCommands {
    /// Enable or disable adaptive noise control.
    Adaptive {
        status: Status,
    },
    /// Enable or disable active noise-cancelling.
    Anc {
        status: Status,
    },
    /// Set the anti-wind noise-cancelling mode.
    AntiWind {
        mode: AntiWind,
    },
    /// Enable or disable auto-answer.
    AutoAnswer {
        status: Status,
    },
    /// Enable or disable comfort call.
    ComfortCall {
        status: Status,
    },
    /// Enable or disable on-head detection.
    OnHeadDetection {
        status: Status,
    },
    /// Enable or disable smart pause.
    SmartPause {
        status: Status,
    },
    /// Enable or disable Bluetooth multipoint, recovering the control connection.
    Multipoint {
        status: Status,
    },
    BassBoost {
        status: Status,
    },
    Sidetone {
        #[arg(value_parser=clap::value_parser!(u8).range(0..=5))]
        level: u8,
    },
    /// 0=off, 1=equalizer, 2=speech/podcast, 3=existing sound personalization.
    SoundMode {
        #[arg(value_parser=clap::value_parser!(u8).range(0..=3))]
        mode: u8,
    },
    /// Idle shutdown in seconds; 0 disables the timer.
    AutoPowerOff {
        seconds: u16,
    },
    /// 0=off, 1=tones, 2=tones and voice.
    PromptMode {
        #[arg(value_parser=clap::value_parser!(u8).range(0..=2))]
        mode: u8,
    },
    TouchLock {
        status: Status,
    },
    LowLatency {
        status: Status,
    },
    /// 0=advanced sound quality, 1=Bluetooth compatibility.
    AudioPriority {
        #[arg(value_parser=clap::value_parser!(u8).range(0..=1))]
        mode: u8,
    },
    /// Set one EQ band using a gain in decibels (steps of 0.1).
    Eq {
        band: u8,
        #[arg(allow_hyphen_values=true,value_parser=parse_gain)]
        gain: i8,
    },
    /// Apply a complete EQ profile in decibels, verifying and restoring on failure.
    EqPreset {
        #[arg(num_args=1..=16,allow_hyphen_values=true,value_parser=parse_gain)]
        gains: Vec<i8>,
    },
    /// Rename the headset (at most 32 UTF-8 bytes).
    Name {
        name: String,
    },
    /// Set the noise-cancelling transparency level.
    Transparency {
        #[arg(value_parser = parse_percent)]
        level: Percent,
    },
}

#[derive(Clone, Copy, ValueEnum)]
pub enum AntiWind {
    Auto,
    Max,
    Off,
}

impl Display for AntiWind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}",
            match self {
                AntiWind::Auto => "auto",
                AntiWind::Max => "max",
                AntiWind::Off => "off",
            }
        )
    }
}

impl From<AntiWind> for crate::protocol::AntiWind {
    fn from(value: AntiWind) -> Self {
        match value {
            AntiWind::Auto => Self::Auto,
            AntiWind::Max => Self::Max,
            AntiWind::Off => Self::Off,
        }
    }
}

impl From<crate::protocol::AntiWind> for AntiWind {
    fn from(value: crate::protocol::AntiWind) -> Self {
        match value {
            crate::protocol::AntiWind::Auto => Self::Auto,
            crate::protocol::AntiWind::Max => Self::Max,
            crate::protocol::AntiWind::Off => Self::Off,
        }
    }
}

#[derive(Clone, Copy, ValueEnum)]
pub enum Status {
    On,
    Off,
}

impl Display for Status {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}",
            match self {
                Status::On => "on",
                Status::Off => "off",
            }
        )
    }
}

impl From<bool> for Status {
    fn from(value: bool) -> Self {
        match value {
            true => Self::On,
            false => Self::Off,
        }
    }
}

impl From<Status> for bool {
    fn from(value: Status) -> Self {
        match value {
            Status::On => true,
            Status::Off => false,
        }
    }
}

fn parse_percent(s: &str) -> Result<Percent, String> {
    Percent::try_from(s.parse::<u8>().map_err(|err| err.to_string())?)
        .map_err(|err| err.to_string())
}

fn parse_gain(s: &str) -> Result<i8, String> {
    let gain = s.parse::<f64>().map_err(|_| "gain must be a number")?;
    let raw = gain * 10.0;
    if !raw.is_finite() || (raw - raw.round()).abs() > 1e-6 || !(-128.0..=127.0).contains(&raw) {
        return Err("gain must use 0.1 dB steps within the int8 range".into());
    }
    Ok(raw.round() as i8)
}
