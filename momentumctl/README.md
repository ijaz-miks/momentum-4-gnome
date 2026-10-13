# momentumctl

A Linux CLI for Sennheiser Momentum 4 controls, including Bluetooth multipoint
and the headset's paired source-device list.

## Build

Build this checkout with Rust 1.89 or newer and BlueZ development dependencies:

```bash
cargo build --release --locked
cargo test --locked
cargo clippy --locked -- -D warnings
```

The executable is `target/release/momentumctl`. Install it at the path used by
the GNOME extension. Preserve an existing installation with the verified
desktop Trash procedure before installing its replacement.

## Connection management

```bash
momentumctl connections list
momentumctl connections list --json
momentumctl get multipoint
momentumctl set multipoint on
momentumctl set multipoint off
momentumctl connections switch 2 --expect-name "Windows PC"
momentumctl connections disconnect 2 --expect-name "Windows PC"
momentumctl reconnect
```

Use the index and exact name returned by `connections list`, rather than the
example index. Pair Windows with the headset in Windows Bluetooth Settings
first; it then appears in the headset's list automatically.

A switch retains the computer running this CLI and replaces the other active
source. It validates the target's current index and name, waits for confirmed
connection state after acknowledgement, and restores the previous source if
connecting the target fails. `connect` requires a free slot; `switch` may
replace the other source. Disconnecting the control host is rejected.

Disabling multipoint closes the control connection on firmware 3.38.3. The CLI
reconnects through BlueZ, reopens RFCOMM and verifies the requested setting.
An uncertain setter is read back rather than repeated. Multipoint off supports
one active source; on supports two. Enabling it does not reconnect every pairing.

These commands manage Bluetooth connections. They do not force the active
audio player on another computer to start or pause.

## Headset controls

The original `get`, `set` and nine-field text `status` interface remains
available. Additional controls include:

| Control | CLI |
| --- | --- |
| Five-band EQ | `get eq`, `set eq <band> <gain-dB>` |
| Complete EQ profile | `set eq-preset <gain1-dB> ... <gain5-dB>` |
| Bass boost | `get/set bass-boost` |
| Sound mode | `get/set sound-mode`: 0 off, 1 EQ, 2 speech/podcast, 3 existing personalization |
| Sidetone | `get/set sidetone`: 0 through 5 |
| Auto power-off | `get/set auto-power-off`: seconds, 0 disables |
| Tone/voice prompts | `get/set prompt-mode`: 0 off, 1 tones, 2 tones and voice |
| Touch lock | `get/set touch-lock` |
| Low latency | `get/set low-latency` |
| Audio priority | `get/set audio-priority`: 0 advanced quality, 1 compatibility |
| Headset name | `set name <name>`: at most 32 UTF-8 bytes |

Boolean setters use `on` or `off`. Run each command with `--help` for details.
EQ gains use 0.1 dB steps and the device's reported limits. A complete profile
activates EQ, verifies every band, and restores the previous EQ/mode on failure.

```bash
momentumctl status
momentumctl inspect --json
# Replace the fictional address with your headset address.
momentumctl --device 00:11:22:33:44:55 inspect --json
momentumctl set eq 0 -1.5
```

`inspect --json` returns a complete, versioned snapshot: settings, firmware,
codec, wear state, voice language, personalization availability, EQ limits and
gains, control-host index, current connection capacity and all paired peers.
Rejected optional features return `null` with an explanation under
`unsupported`. Malformed responses and transport failures fail the snapshot.

Sound Personalization can activate an existing calibrated profile. Creating a
new calibrated profile, location-based Sound Zones, voice-pack installation
and firmware updates remain Smart Control Plus functions. No unverified
firmware, factory-reset or pairing-deletion command is exposed.

## Transport

The paired Momentum 4 is discovered through BlueZ and uses GAIA v3 over RFCOMM
channel 1. `--device MAC` selects a particular headset; ambiguous automatic
selection is rejected. A user-scoped OS lock serializes CLI operations across
processes, including the GNOME extension.

Frames preserve Sennheiser vendor `0x0495` and Qualcomm vendor `0x001D`.
Multipoint uses getter `001D:0E10` and setter `001D:0E00` with a Boolean byte.
Source-device commands use `0495:1400` through `1404`, host index `1407` and
active connection limit `1409`. Replies match vendor and command; notifications
cannot satisfy a request. Reads and recovery are bounded.

Only Momentum 4 has been verified. Other models may use different RFCOMM
channels and payloads.

## Validation

This extended version is experimental. Live protocol testing on firmware
3.38.3 confirmed multipoint reads, both toggle values, source disconnect/reconnect
and the new setting reads. Those checks validated wire commands separately
from the rebuilt CLI. Complete physical acceptance of the extended CLI, new
EQ/device setters and the connection-readiness fix remains pending. Automated tests
cover captured frames, notifications, vendor matching, identity guards,
delayed switching, failed-switch restoration and partial EQ-profile restoration.

## Credits

The original momentumctl supplied noise and behavior controls. Protocol IDs
were checked against the installed Smart Control Plus app, live replies and
public protocol research. New control code is implemented in this repository.
