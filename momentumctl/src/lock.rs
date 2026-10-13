use std::{
    fs::{File, OpenOptions},
    os::unix::{fs::OpenOptionsExt, io::AsRawFd},
    path::PathBuf,
    time::Duration,
};
pub async fn acquire() -> anyhow::Result<File> {
    let directory = if let Some(path) = std::env::var_os("XDG_RUNTIME_DIR") {
        PathBuf::from(path)
    } else {
        let mut path = PathBuf::from(
            std::env::var_os("HOME").ok_or_else(|| anyhow::anyhow!("HOME is unavailable"))?,
        );
        path.push(".local/state/momentumctl");
        std::fs::create_dir_all(&path)?;
        path
    };
    if !directory.is_absolute() {
        anyhow::bail!("lock directory must be absolute");
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(directory.join("momentumctl.lock"))?;
    let end = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        // Process-scoped advisory lock is released by the OS on cancellation or exit.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(file);
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::WouldBlock {
            return Err(error.into());
        }
        if tokio::time::Instant::now() >= end {
            anyhow::bail!("another momentumctl operation is still running");
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
