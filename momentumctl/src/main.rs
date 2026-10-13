use crate::cli::Cli;
use clap::Parser;
use std::process;
mod ble;
mod cli;
mod client;
mod codec;
mod lock;
mod management;
mod protocol;

#[tokio::main]
async fn main() {
    env_logger::init();
    if let Err(error) = run().await {
        eprintln!("{error:#}");
        process::exit(1);
    }
}
async fn run() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let _lock = lock::acquire().await?;
    let headset = ble::select(cli.device.as_deref()).await?;
    management::run(&cli, &headset).await
}
