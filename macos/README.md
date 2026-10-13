# Momentum 4 Controls for macOS

A native menu bar app with the headset controls provided by this repository's
GNOME extension. It uses SwiftUI, AppKit and Apple's Bluetooth frameworks.
The Mac communicates directly with the paired headset over its GAIA RFCOMM
service. No Linux CLI, phone companion, network service or third-party package
is required at runtime.

## Controls

| Page | Controls |
| --- | --- |
| Devices | Multipoint toggle, paired source list, confirmed connect/disconnect and source switching while preserving this Mac |
| Noise | ANC, adaptive noise control, anti-wind, transparency, on-head detection and Smart Pause |
| Sound | Firmware-reported EQ bands and limits, bass boost, firmware-dependent sound modes, existing personalized profile, explicit local preset save/apply/remove/undo |
| More | Auto-answer, Comfort Call, sidetone, auto power-off, tone/voice prompts, audio priority, touch lock, low latency, headset rename and firmware/codec/language information |
| Settings | Actual launch-at-login status, menu bar battery percentage and headset selection |

Pair each source once in its own Bluetooth settings. It appears in the
headset's paired list, including Windows and Linux computers. With multipoint
enabled, Switch replaces the other source when both slots are full. The app
protects this Mac's connection, rereads the target identity and polls for
confirmed status. A failed switch attempts to restore the previous source.
Switching manages Bluetooth connections; it does not control remote players.

New Sound Personalization calibration, Sound Zones, voice-pack installation
and firmware updates remain phone-app functions, as with the GNOME extension.
Only an existing calibrated personalized profile can be selected here.

The popover follows the system's light/dark appearance and accessibility
settings, with native controls and a Liquid Glass accent on macOS 26 and newer.
On older supported systems it uses native material styling.

## Build and install

Build on a Mac with Swift 6 or newer and the macOS 26 or newer SDK. Command Line
Tools are sufficient; this project does not require a full Xcode installation.
The minimum runtime is macOS 14. The current build and native checks have been
run on Apple Silicon with macOS 27 and Swift 6.4. Older runtimes and Intel Macs
still require physical validation.

From the repository root, choose an output directory that does not exist:

```sh
xcrun swift run --package-path macos MomentumCoreChecks
python3 macos/scripts/build-app.py --output-dir macos/builds/local-release-01
python3 macos/scripts/install-app.py 'macos/builds/local-release-01/Momentum 4 Controls.app' --launch
```

The installer verifies the signature and installs into
`~/Applications/Momentum 4 Controls.app`. It refuses any existing destination,
including a symbolic link. `--name` can select a fresh versioned application
filename in the same user Applications folder while retaining an earlier build.
Build output directories must also be new. Outputs
are retained. Preserve an existing app through your verified desktop Trash
procedure before installing an update.

The build script creates original vector icon artwork and applies a local
ad-hoc signature. This is a source-build installation, not a Developer ID signed
or notarized download. No signing credentials are included in this repository.
A changed locally signed executable can require Bluetooth permission again.
Allow the current build's standard macOS prompt before using its controls.

Turn on Bluetooth, pair the Momentum 4 with the Mac and allow the standard
macOS Bluetooth permission prompt. If the headset is disconnected, choose
Connect to this Mac in the popover. Bluetooth and privacy settings stay under
macOS control. The app never silently changes those system settings.

Launch at login is requested on first normal launch through `SMAppService`.
Settings shows its actual registered status. If macOS requires approval, use
Open Login Items and approve it in System Settings. Turning the preference off
unregisters it. Demo and diagnostic launches never register login items.

## State and privacy

Transactions are serialized. Setter values are validated and read back.
Multipoint and audio-priority changes can reset Bluetooth; the app reconnects
and verifies their state without replaying an uncertain setter. EQ profiles
verify all bands and restore the previous gains/mode if application fails.

Slider drags preview locally and write on release. Keyboard changes debounce.
Closing the popover commits accepted previews. Opening the menu, waking the
Mac or restarting the app reads settings without applying stored presets.
Malformed reads mark retained values stale and disable writes. Firmware-rejected
optional features show Unavailable. Errors remain visible until dismissed.
Sound-mode rejections distinguish a profile that needs configuration from a
mode the firmware does not support. Only an explicit unsupported response
disables that choice. The observation is scoped to the headset and firmware;
a different firmware or a live selection supersedes it. Normal startup never
probes sound-mode support by changing the headset.

The app releases its RFCOMM channel after each transaction. It polls while the
panel is open, and reads the battery every two minutes while closed when enabled.
Sleep cancels work; wake starts with a read.

Only the selected headset address, menu preference, login preference,
explicitly named EQ presets and firmware-specific sound-mode support
observations are stored in local user preferences. There is no
telemetry or cloud account. Normal operation does not save packet captures.
Device names and addresses are shown locally and are not transmitted anywhere.

## Validation status

The 0.1.2 release build, twelve protocol/client checks and ten native UI checks
passed on the Apple Silicon development Mac. Native launch-at-login
registration was verified as enabled without additional login-item approval.
The current build has macOS Bluetooth permission.

Live reads on Momentum 4 firmware 3.38.3 returned all seventeen settings and
five EQ bands. Physical testing completed twenty-one checks:

| Physical behavior | Result |
| --- | --- |
| Multipoint on/off | Capacity readback and native reconnection verified |
| Other connected source | Disconnect/reconnect verified while protecting this Mac |
| ANC, adaptive control, anti-wind, transparency, on-head detection, Smart Pause | Changed, read back and restored |
| Auto-answer, Comfort Call, bass boost, sidetone, prompts, touch lock, low latency, auto power-off | Changed, read back and restored |
| Sound mode Off and Equalizer | Changed, read back and restored |
| Five-band EQ | Negative gain change verified; original gains and mode restored |
| Headset name | Rename verified and original name restored |
| Audio priority | Change, reconnection, readback and source restoration verified |
| Final restoration | All original settings, EQ, name and source connections confirmed |

Speech/Podcast mode returned a generic headset rejection (`0495/0803`,
payload `83`). Its two-byte mode payload matches the observed Smart Control
Plus GAIA action, but selection was not accepted on the tested headset. This
response does not establish the explicit unsupported (`82`) or unconfigured
(`81`) cases. The physical test correctly reports a failure for this choice;
the menu retains the confirmed selection and displays the error. No preset
curve or alternative command is substituted. Personalized mode remains gated
on an existing calibrated profile and was not physically tested.

Windows switching and replacement when both slots are full are covered by
simulated checks and still require physical Windows acceptance. The physical
source check verified disconnect/reconnect of the other active source.
Simulated checks must not be treated as proof of physical headset behavior.

## Checks

The standalone `MomentumCoreChecks` executable runs twelve grouped checks for
framing, checksums, validation, complete snapshots, switching, rollback,
unsupported settings and uncertain Bluetooth acknowledgements. Sound-mode
checks preserve the full rejection payload and require fresh confirmation of
an already-selected response. The suite runs without Bluetooth and does not
depend on XCTest, which is absent from some Command
Line Tools installations.

A packaged app can run native UI checks against an explicit simulated headset:

```sh
open -n -W 'macos/builds/local-release-01/Momentum 4 Controls.app' --args \
  --self-test /tmp/momentum-native-check-unique
cat /tmp/momentum-native-check-unique/result.json
```

The output directory must be absent. The checks exercise the real status item,
popover, queue, slider behavior, presets, failure handling, sleep/wake lifecycle
and Settings window. They render all four pages in light and dark appearances.
Captures contain only this app's own views and synthetic device identities.
A cached view capture uses a native solid backdrop because the macOS compositor's
live glass backdrop is not part of that view cache.

For an opt-in read-only physical check:

```sh
open -n -W "$HOME/Applications/Momentum 4 Controls.app" --args \
  --hardware-read /tmp/momentum-hardware-read-unique.json --connect
```

The report contains counts, firmware, battery and Bluetooth access state, never
source names or addresses.

The following is an explicit physical acceptance test. It temporarily changes
headset settings, EQ, its name and source connections, then attempts to restore
the original state. Keep the headset powered on and available throughout:

```sh
open -n -W "$HOME/Applications/Momentum 4 Controls.app" --args \
  --hardware-test /tmp/momentum-hardware-test-unique.json
```

Run only one hardware test instance and quit the normal app first. The result
lists successful readbacks, firmware limitations, rejection codes and any
restoration failures. A rejected individual control is followed by confirmation
of its original value before testing the remaining controls. A physical source
switch is tested only if another source was connected at the initial snapshot.
Synthetic Windows switching does not establish physical Windows acceptance.
