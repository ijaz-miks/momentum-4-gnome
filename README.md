# Momentum 4 Controls

A GNOME Shell top-bar menu for Sennheiser Momentum 4 headphones, built on the
[momentumctl](https://codeberg.org/galen/momentumctl) command-line tool. It is a
native GNOME counterpart of the Omarchy
[omarchy-momentumctl](https://github.com/timmo001/omarchy-momentumctl) panel.

UUID: `momentum4@ijaz-miks.github.io`. Supported GNOME Shell: 50.

## Features

- Battery percentage in the top bar and menu.
- Noise cancellation, adaptive noise control, transparency (slider and
  10-point step buttons), anti-wind Off/Auto/Max.
- Smart Pause, on-head detection, auto-answer and Comfort Call.
- Refresh, Bluetooth Settings and Preferences.

Headset values are read from the device and never persisted or automatically
replayed. Unknown values display Unavailable. After a failed read, retained
values are marked stale and the controls are disabled until a valid read.

The menu uses native GNOME Shell widgets, the active theme and normal keyboard
navigation: Up/Down to move, Enter/Space to activate, Left/Right on the slider
and Escape to close. It scrolls when it does not fit on the monitor.

## Requirements

- GNOME Shell 50 (GJS ES modules). Preferences use GTK4 and libadwaita.
- An installed `momentumctl` executable, with the headset paired in BlueZ.

Preferences accept an absolute executable filename, including names with
spaces. An explicit invalid path never falls back to another program. When the
setting is empty, the extension searches PATH, then `~/.cargo/bin`,
`~/.local/bin`, `/usr/local/bin` and `/usr/bin`. GNOME Shell's PATH usually does
not include `~/.cargo/bin`, so the explicit fallback matters for Cargo installs.

Only `momentumctl status` and the eight documented setters are used. There is no
device picker, firmware operation, factory reset or profile restoration, and no
second Bluetooth protocol implementation.

## Build and install

```bash
bash scripts/check.sh
python3 scripts/package.py --output-dir builds/<new-build-name>
python3 scripts/install-local.py builds/<new-build-name>/momentum4@ijaz-miks.github.io.shell-extension.zip
```

Then log out and back in so GNOME Shell discovers the extension (Wayland
sessions cannot restart Shell in place), and run:

```bash
gnome-extensions enable momentum4@ijaz-miks.github.io
gnome-extensions info momentum4@ijaz-miks.github.io
gnome-extensions prefs momentum4@ijaz-miks.github.io
```

Disable immediately with `gnome-extensions disable momentum4@ijaz-miks.github.io`.

`package.py` refuses an existing output directory and keeps its staging files.
`install-local.py` validates the exact production file set and UUID, rejects
traversal, absolute paths, symlinks, duplicate entries and oversized files,
refuses an existing destination, and installs without enabling.

## Updating an installed copy

The installer never overwrites. Disable the extension, move the installed
directory aside, then install the new bundle. `scripts/trash-installed.py` moves
the exact installed directory to the desktop Trash (never permanent deletion),
verifies the Trash entry and its recovery metadata, appends records to the
given TSV log and prints the restore command:

```bash
gnome-extensions disable momentum4@ijaz-miks.github.io
python3 scripts/trash-installed.py --reason 'Update Momentum 4 Controls' --log "$HOME/.local/state/removal-log.tsv"
python3 scripts/install-local.py builds/<new-build-name>/momentum4@ijaz-miks.github.io.shell-extension.zip
```

Roll back by moving the new copy to Trash the same way and running the printed
`gio trash --restore` command for the previous copy. Log out and back in to
reload the code.

## How it works

Every CLI invocation is asynchronous, uses an argv array (never a shell), runs
with `LC_ALL=C`, has a 10-second deadline and captures separate UTF-8 streams
capped at 64 KiB each. Timeout and cancellation terminate the child and wait for
it to exit before another command can start. Disable, immediate re-enable and
path changes share the same barrier, so at most one child of this extension
exists at a time.

Each change is one transaction: setter, 500 ms settling delay, then a full
`status` read. Status must contain all nine fields exactly once with strict
booleans, modes and percentages, and the snapshot is replaced atomically.
Malformed output is never defaulted or clamped. Setter errors stay visible after
later successful reads. An uncertain setter is never retried; one read reconciles
the observed state. If the headset reports a different value than requested,
the actual value is shown with an error.

Transparency keeps a separate preview. Pointer drags commit at drag end;
keyboard, wheel and step changes debounce for 350 ms; closing the menu commits a
pending preview.

Polling runs after completed transactions: every 30 seconds with the menu open
and every 120 seconds while closed. Read failures back off to 30, 60, 120 and 300
seconds. A missing CLI does not poll. Opening the menu and Refresh bypass the
backoff. logind sleep signals cancel work and waking rereads.

Serialization covers this extension only. Another program using `momentumctl`
at the same time can still contend for the headset's Bluetooth profile. A
successful status means the control interface answered; it is not a Bluetooth
connection indicator, and the product name is not a device identity.

## Development

```bash
bash scripts/check.sh
python3 scripts/package.py --output-dir builds/<build>
python3 tests/package.test.py builds/<build>/momentum4@ijaz-miks.github.io.shell-extension.zip
gjs -m tests/package-runtime.js builds/<build>/staging
python3 scripts/shell-test-retained.py builds/<build>/momentum4@ijaz-miks.github.io.shell-extension.zip --output-dir builds/<shell-test>
```

Use fresh directory names each time; build and test output is retained and
ignored by Git. `check.sh` runs the parser, command, controller and real
subprocess tests against `tests/mock-momentumctl.py`, plus schema and static
checks. The Shell test starts the packaged extension in a private headless
GNOME Shell with its own XDG directories, D-Bus session and Wayland display, and
selects the mock CLI explicitly so it cannot reach a real headset. It does not
use the installed `gnome-shell-test-tool`, which removes its output.

`tests/hardware-read.js` performs one read-only `status` call against a real
headset and is excluded from the bundle and from automated checks:

```bash
gjs -m tests/hardware-read.js [path-to-momentumctl]
```

Manual acceptance steps are in `docs/manual-test-plan.md`.

## Layout

| Path | Responsibility |
| --- | --- |
| `lib/commands.js`, `lib/statusParser.js` | CLI contract and strict status parsing |
| `lib/executableResolver.js` | Executable discovery |
| `lib/cliExecutor.js` | One owned child process with deadline and cancellation |
| `lib/headsetController.js` | Transactions, state, timers and intent (no Shell imports, unit tested) |
| `ui/` | Panel indicator and menu widgets |
| `extension.js` | Settings, lifecycle and system signal subscriptions |
| `prefs.js` | GTK4 preferences; never talks to the headset |

## License

MIT. See `LICENSE` and `NOTICE`. Sennheiser and Momentum are trademarks of their
respective owners; this project is not affiliated with Sennheiser.
