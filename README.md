# Momentum 4 Controls

Native desktop controls for Sennheiser Momentum 4.

| Desktop | Implementation | Setup |
| --- | --- | --- |
| Ubuntu / GNOME Shell 50 | GNOME extension with the bundled momentumctl 0.2.0 CLI | Instructions below |
| macOS 14 and newer | Native SwiftUI/AppKit menu bar app with direct Bluetooth control | [macOS setup](macos/README.md) |

The GNOME extension UUID is momentum4@ijaz-miks.github.io.
The macOS app provides the same headset controls, including multipoint and
source switching, with native appearance and launch-at-login support.

Custom widgets use explicit Momentum 4 GType names because all extensions
share one Shell process. This avoids collisions with other extensions that
also define ui/indicator.js and a class named Indicator.

## Features

- Battery percentage, noise cancellation, adaptive noise control, transparency
  slider and step buttons, and anti-wind Off/Auto/Max.
- Smart Pause, on-head detection, auto-answer and Comfort Call.
- Multipoint on/off with control-channel recovery.
- Paired source-device list, confirmed status and switching between Windows,
  a phone or another source while preserving this Ubuntu computer's connection.
- Five-band EQ, bass boost, speech/podcast mode and explicitly saved presets
  with removal undo.
- Sidetone, auto power-off, tone/voice prompts, audio priority, touch lock and
  low latency, gated by firmware support.
- Headset rename, firmware/codec/voice-language information and headset selection.
- Reconnect, Refresh, Bluetooth Settings and GTK4/libadwaita Preferences.

Values come from the headset. Failed reads mark retained values stale and
disable controls. Presets are saved only by explicit request and applied only
when selected. Restarting or opening the menu never replays headset settings.

## Device switching

Pair Windows with the headset once in Windows Bluetooth Settings. It then
appears automatically in the headset's paired list.

Open Connection management, then Paired devices, and select Windows. The CLI
keeps Ubuntu connected and replaces the other source when both slots are full.
Select an already connected non-host source to disconnect it. Enable multipoint
to connect a second source. The row for this computer is protected.

The headset supports two active sources. If two other sources are already
connected, free one slot before connecting this computer to keep the phone
connected. The headset must be powered on. Its auto power-off timer can end
an idle connection independently of the extension; change the timer explicitly
under Device settings if needed.

The target index and exact name are reread before changing a connection.
Acknowledgement is followed by status polling; a connection can take several
seconds to establish. If connecting the target fails, the previous source is
restored where possible and the failure remains visible.

Multipoint off can close Ubuntu's Bluetooth control connection. The CLI
reconnects through BlueZ, reopens RFCOMM and reads back the state. An uncertain
setter is never blindly repeated. Use Connect headset to this computer when
the headset is disconnected.

These controls manage connections. They do not start or pause audio players
on other computers.

## Supported headset functions

The extension validates a complete schema-versioned snapshot from
momentumctl inspect --json. Optional unsupported controls display Unavailable.

Sound Personalization can activate an existing calibrated profile. Creating a
new calibrated profile, location-based Sound Zones, voice-pack installation
and firmware updates remain phone-app functions. Firmware, codec and current
voice language are information fields in this menu.

## Requirements

- GNOME Shell 50 with GJS ES modules.
- The bundled momentumctl 0.2.0, with the Momentum 4 paired in BlueZ.
  The original upstream CLI does not provide inspect or multipoint.
- GTK4/libadwaita for Preferences.

An empty CLI path searches PATH, ~/.cargo/bin, ~/.local/bin, /usr/local/bin
and /usr/bin. An explicit invalid executable never falls back. Preferences
also accept an optional headset Bluetooth address; ambiguous automatic headset
selection is rejected. Source computers are selected from the headset's list.

## Build, test and install

The complete backend source is in momentumctl/. Build both components from
this repository. The original Codeberg CLI does not include these controls.
Use Rust 1.89 or newer. On Ubuntu, install the build and runtime dependencies:

    sudo apt install pkg-config libdbus-1-dev python3 libglib2.0-bin gjs gir1.2-adw-1

Then, from the repository root:

    cargo build --release --locked --manifest-path momentumctl/Cargo.toml
    cargo test --locked --manifest-path momentumctl/Cargo.toml
    cargo clippy --locked --manifest-path momentumctl/Cargo.toml -- -D warnings
    python3 scripts/install-cli.py momentumctl/target/release/momentumctl

The CLI installer writes to ~/.cargo/bin/momentumctl and refuses to overwrite
an existing file or symbolic link. For an existing CLI installation, first
disable the extension and preserve the old binary in desktop Trash:

    gnome-extensions disable momentum4@ijaz-miks.github.io
    python3 scripts/trash-installed.py --cli --reason 'Update momentumctl' --log "$HOME/momentumctl-removal-log.tsv"
    python3 scripts/install-cli.py momentumctl/target/release/momentumctl

Build and install the extension:

    bash scripts/check.sh
    python3 scripts/package.py --output-dir builds/<fresh-build-name>
    python3 scripts/install-local.py builds/<fresh-build-name>/momentum4@ijaz-miks.github.io.shell-extension.zip

Output directories must be new. Staging and test output are retained.
The installer validates the exact production file set, rejects unsafe archive
entries and refuses an existing destination.

For an update, disable the extension, preserve its installed directory in
desktop Trash with the verified workflow, then install the validated bundle:

    gnome-extensions disable momentum4@ijaz-miks.github.io
    python3 scripts/trash-installed.py --reason 'Update Momentum 4 Controls' --log "$HOME/momentumctl-removal-log.tsv"
    python3 scripts/install-local.py builds/<fresh-build-name>/momentum4@ijaz-miks.github.io.shell-extension.zip

The Trash helper verifies the original path, mount, owner, new Trash entry and
recovery metadata and prints the exact recovery command. Never empty Trash.

GNOME caches imported extension modules. Log out and back in to load this
version, then enable it:

    gnome-extensions enable momentum4@ijaz-miks.github.io

The running desktop is not signed out automatically during installation.

## Runtime behavior

Every CLI invocation is asynchronous, uses argv without a shell, runs with
LC_ALL=C and limits each output stream to 64 KiB. Deadlines allow 30 seconds
for snapshots, 60 seconds for multipoint/audio priority and 75 seconds for
switching or complete EQ profiles. Cancellation terminates and reaps the
child before another operation starts.

The controller serializes writes, settles, reads the complete snapshot and
verifies the requested value. Malformed output never defaults to off or zero.
Errors remain visible until dismissed. The CLI's user-scoped OS lock also
serializes terminal invocations with extension operations.

The CLI waits for the kernel's RFCOMM connected state before sending its first
request. A peer address alone does not prove readiness. If the previous control
channel is still disconnecting, opening the next one waits within the connection
deadline. These connection retries never replay a headset-setting command.

Transparency and EQ drags commit at drag end; keyboard/wheel/step inputs
debounce. Closing the menu commits accepted previews. EQ profiles validate
band count and device limits, activate EQ, verify all gains and restore the
previous EQ/mode on failure.

Polling follows completed transactions: 30 seconds with the menu open,
120 seconds while closed when battery text is enabled, with failure backoff.
A read-only BlueZ observer follows the selected headset, suppresses offline
polling and reads after reconnection. logind sleep cancels pending work.

The menu uses native widgets, the active theme, keyboard navigation and
scrolling. Preferences never open a headset connection.

## Development validation

The extended controls are experimental. Multipoint wire commands, paired-peer
disconnect/reconnect commands and additional reads were checked on Momentum 4 firmware
3.38.3. Automated Rust tests and the isolated GNOME suite validate framing,
rollback, UI and lifecycle behavior with simulated headset responses. Complete
physical acceptance of the rebuilt CLI and the new EQ/device setters remains
pending. Run the manual headset checks before relying on every control.

    python3 tests/package.test.py builds/<build>/momentum4@ijaz-miks.github.io.shell-extension.zip
    gjs -m tests/package-runtime.js builds/<build>/staging
    python3 scripts/shell-test-retained.py builds/<build>/momentum4@ijaz-miks.github.io.shell-extension.zip --output-dir builds/<fresh-shell-test>

The Shell harness runs a private headless compositor, its own XDG directories
and D-Bus session, and a fake headset CLI. It never reaches the host's BlueZ.
A retained wrapper gives GNOME's real performance helper enough time for the
expanded suite. The harness checks switches, Windows/phone switching, EQ and
presets, additional settings, lifecycle, errors, scrolling and Preferences.

Read-only physical verification:

    gjs -m tests/hardware-read.js [path-to-momentumctl]
    momentumctl inspect --json

See docs/manual-test-plan.md for physical acceptance checks.

## Translations

Strings use the momentum4 gettext domain and literal translation markers.

    python3 scripts/i18n.py pot

Packaging compiles available PO catalogs. The tooling uses Python's standard
library and retains build files.

## Layout

| Path | Responsibility |
| --- | --- |
| momentumctl/ | Extended MIT-licensed Rust backend, build and protocol tests |
| lib/commands.js, lib/statusParser.js, lib/inspectionParser.js | CLI contract and strict snapshots |
| lib/headsetController.js | Serialized intent, verification, timers and lifecycle |
| lib/cliExecutor.js | Owned child process, deadlines and cancellation |
| lib/bluezWatcher.js | Read-only selected-headset observation |
| ui/ | Native connection, sound, EQ/preset, behavior and device controls |
| prefs.js | GTK4/libadwaita preferences |
| scripts/ | Retained packaging, installation, translations and Shell tests |

## License

MIT. See LICENSE and NOTICE. Sennheiser and Momentum are trademarks of their
owners. This project is not affiliated with Sennheiser.
