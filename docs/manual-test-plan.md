# Validation and manual acceptance

Automated source tests use a fake executor and clock, or the explicit Python
mock CLI. They never communicate with Bluetooth.

## Automated coverage

| Area | Evidence |
| --- | --- |
| Parser | Nine required fields, ordering, whitespace, CRLF, unknown labels, 0/100, missing/duplicate fields, invalid booleans/modes, malformed/out-of-range percentages and garbage |
| Commands | All eight exact setters; invalid names/types/ranges and battery writes rejected |
| Controller | In-flight display value, BlueZ disconnect/reconnect, no closed-menu polling without battery text, missed-wake recovery, serialized set/settle/read, latest pending value, superseded request settlement, no-op elimination, refresh coalescing, write priority, preview during refresh, close commit, mismatch, failed verification, error retention, backoff/reset, sleep/wake and stop in each phase |
| Real subprocesses | Stateful mock CLI, filename with spaces, Cargo fallback, missing executable, normal/nonzero/signal exit, UTF-8 failure, output cap, separate stderr, C locale, delayed response, forced timeout, cancellation, PID reaping and immediate replacement |
| BlueZ watcher | Fake `org.bluez` on a private bus: GAIA-only matching, connect/disconnect/removal, BlueZ loss, no reports after stop |
| Translations | Literal-only markers, template freshness, .po parsing, .mo read back by Python gettext, translator hooks |
| Packaging | Exact production files, optional locale entries, compiled schema/defaults, import closure, no mocks/tests, retained installation, refusal to overwrite, hostile traversal/absolute/symlink/UUID/missing-module/duplicate archives rejected |

The mock records PIDs and any earlier surviving PIDs at each launch. Tests
assert those overlap lists are empty and that terminated children no longer
exist.

## Isolated GNOME Shell run

`scripts/shell-test-retained.py` runs the packaged extension in a private
headless GNOME Shell with an explicit mock path. It covers all switches,
anti-wind modes, transparency drag/step/debounce/close commit, virtual keyboard
navigation, clicks that must keep the menu open, focus kept on a control
through its update, the requested value shown while updating, battery icon and
low battery hint, the optional shortcut, short-monitor scrolling, battery preference
without CLI activity, a path change during a hung child, malformed status and
recovery, BlueZ disconnect and reconnect through a fake service, repeated disable/enable, the separate GTK4 preferences process and
final teardown. The harness fails on JavaScript errors, disposed-actor access
and Clutter or St criticals in the Shell log even when its JSON report passes.

Useful variants: `--scale 2 --font-scale 1.4 --theme prefer-dark` and the
default 100% light presentation.

## Desktop and real headset acceptance

1. Install, enable and inspect using the README commands. Confirm one icon, the
   native theme, battery and the complete menu. Open and close repeatedly.
2. Navigate with Up/Down, Enter/Space and Escape. Adjust transparency with
   Left/Right, wheel, drag and step buttons. Check that focus stays visible and
   that a screen reader announces controls and values.
3. Change headset settings deliberately. Note the initial values first and
   restore them afterwards. Verify all nine fields after each write.
4. Test every control. Check whether firmware changes related fields, without
   assuming dependencies.
5. Test headset power-off and reconnect (the menu should refresh shortly after
   BlueZ reports the connection), Bluetooth off, external changes from the
   mobile app, off/on-head behaviour and suspend/resume. Confirm stale values
   and failures stay visible and queued writes are discarded.
6. Disable during refresh, write, settle and verification, then re-enable
   immediately. Confirm no duplicate icon, overlapping child, late actor access
   or remaining poll.
7. Open Preferences and toggle battery visibility; no CLI activity should occur.
   Change the path while a query is running, then correct it.
8. Check normal and enlarged fonts, 100% and 200% scale, light and dark styles
   and a small monitor for clipping and readable errors.
9. Open Bluetooth Settings from the menu.
10. Set a shortcut in Preferences and use it to open and close the menu,
    including with another top-bar menu open.
11. Leave the headset connected for an hour with the menu closed and compare
    battery drain with and without the panel battery text, which controls
    whether the extension polls while the menu is closed.
12. Install a test translation and start a session with that language.

## Real read

`gjs -m tests/hardware-read.js [path]` performs one read-only status call with
the same 10-second executor and prints exit, latency and the validated
snapshot, or the concrete failure. No writes are part of automated acceptance.
