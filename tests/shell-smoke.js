import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const METRICS = {};
const uuid = 'momentum4@ijaz-miks.github.io';
const output = GLib.getenv('MOMENTUMCTL_TEST_OUTPUT');
const checks = [];
function assert(ok, message) { if (!ok) throw new Error(message); }
const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { resolve(); return GLib.SOURCE_REMOVE; }));
async function until(predicate, message) {
    const end = GLib.get_monotonic_time() + 20_000_000;
    while (!predicate()) { assert(GLib.get_monotonic_time() < end, message); await sleep(30); }
}
function events() {
    const path = `${GLib.getenv('MOMENTUMCTL_MOCK_DIR')}/events.jsonl`;
    if (!GLib.file_test(path, GLib.FileTest.EXISTS)) return [];
    const [, bytes] = GLib.file_get_contents(path);
    return new TextDecoder().decode(bytes).trim().split('\n').filter(Boolean).map(JSON.parse);
}
const writes = () => events().filter(e => e.phase === 'start' && e.args[0] === 'set').length;
async function displayCall(method, parameters = null) {
    return new Promise((resolve, reject) => Gio.DBus.session.call('org.gnome.Mutter.DisplayConfig',
        '/org/gnome/Mutter/DisplayConfig', 'org.gnome.Mutter.DisplayConfig', method,
        parameters, null, Gio.DBusCallFlags.NONE, 5000, null, (connection, result) => {
            try { resolve(connection.call_finish(result).deep_unpack()); } catch (e) { reject(e); }
        }));
}
async function configureScale() {
    const scale = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).get_uint('scaling-factor') || 1;
    const [serial, monitors, logical] = await displayCall('GetCurrentState');
    GLib.file_set_contents(`${output}/display-state.json`, JSON.stringify({serial, monitors, logical},
        (_key, value) => value instanceof GLib.Variant ? value.deep_unpack() : value));
    const spec = monitors[0][0];
    const current = monitors[0][1].find(mode => mode[6]['is-current']?.unpack());
    assert(current && current[5].includes(scale), 'Requested monitor scale is unsupported');
    if (logical[0][2] !== scale) {
        await displayCall('ApplyMonitorsConfig', new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})',
            [serial, 1, [[0, 0, scale, 0, true, [[spec[0], current[0], {}]]]], {}]));
        await sleep(250);
    }
    const actual = (await displayCall('GetCurrentState'))[2][0][2];
    assert(actual === scale, 'Compositor did not apply requested scale');
    checks.push(`Actual isolated monitor scale ${actual * 100}%`);
    return actual;
}
// A pointer click reaches an item through its ClickGesture, which calls activate().
// Synthetic pointer events are not used: this headless startup leaves the
// Overview in the pick tree, so it would receive them instead of the menu.
async function click(item) {
    assert(item.mapped && item.reactive, `${item} is not clickable`);
    item._clickGesture.emit('recognize');
    await sleep(120);
}
// Fake BlueZ on the isolated system bus (the harness aliases it to the session bus).
function fakeBluez() {
    const xml = `<node><interface name="org.bluez.Device1">
      <property name="Connected" type="b" access="read"/><property name="UUIDs" type="as" access="read"/>
    </interface></node>`;
    const state = {connected: false};
    const iface = Gio.DBusExportedObject.wrapJSObject(xml, {
        get Connected() { return state.connected; },
        get UUIDs() { return ['a2129ff3-081b-4c45-8afe-469d9c4842ec']; },
    });
    const object = Gio.DBusObjectSkeleton.new('/org/bluez/hci0/dev_00_00_00_00_00_01');
    object.add_interface(iface);
    const server = Gio.DBusObjectManagerServer.new('/');
    server.export(object);
    server.set_connection(Gio.DBus.system);
    Gio.bus_own_name_on_connection(Gio.DBus.system, 'org.bluez', Gio.BusNameOwnerFlags.NONE, null, null);
    return {setConnected(value) {
        state.connected = value;
        iface.emit_property_changed('Connected', GLib.Variant.new_boolean(value));
    }};
}
const statusReads = () => events().filter(e => e.phase === 'start' && e.args[0] === 'status').length;
async function ready(extension) {
    await until(() => extension.controller?.ready && extension.controller.current.activity === 'idle', 'Controller did not become ready');
}
let running = null;
// Start directly through the automation hook. The performance helper is not needed
// for widget tests and can stall before the headless session's startup completes.
export function init() {
    sleep(1500).then(() => run()).then(() => global.context.terminate(), e => {
        logError(e, 'Momentum Shell test');
        global.context.terminate();
    });
}
export function run() {
    running ??= execute();
    return running;
}
async function execute() {
    try {
        await until(() => Main.extensionManager.lookup(uuid)?.stateObj?.indicator, 'Packaged extension failed to enable');
        const extension = Main.extensionManager.lookup(uuid).stateObj;
        assert(extension.settings.get_string('cli-path') === GLib.getenv('MOMENTUMCTL_TEST_MOCK'), 'Refusing test without explicit mock selection');
        const monitorScale = await configureScale();
        await ready(extension);
        checks.push('Packaged extension enabled using explicit mock');
        let ui = extension.indicator;
        ui.menu.open(); await sleep(250);
        assert(ui.switches.size === 6 && ui.modes.size === 3 && ui.battery.text === '82%', 'Missing controls or battery');
        assert(ui.header._icon.icon_name === 'battery-level-80-symbolic', 'Battery level icon not shown');
        ui.render({...extension.controller.current, snapshot: Object.freeze({...extension.controller.current.snapshot, battery: 12})});
        assert(ui.status.label.text.endsWith('Battery low') && ui.header._icon.icon_name === 'battery-level-10-symbolic', 'Low battery not shown');
        ui.render(extension.controller.current);
        assert(ui.scroll.height <= Main.layoutManager.primaryMonitor.height, 'Menu exceeds monitor');
        const original = extension.controller.current;
        const start = writes();
        const changed = {...original.snapshot, transparency: 67};
        for (const key of ui.switches.keys()) changed[key] = !changed[key];
        ui.render({...original, snapshot: Object.freeze(changed)});
        ui.render(original); await sleep(450);
        assert(writes() === start, 'Rendering fired a setter');
        checks.push('Actual Shell 50 switch and slider signal feedback suppressed; battery level icon and low battery hint');
        ui.switches.get('anc').grab_key_focus();
        assert(global.stage.get_key_focus() === ui.switches.get('anc'), 'Switch keyboard focus failed');
        ui.transparency.slider.grab_key_focus();
        assert(global.stage.get_key_focus() === ui.transparency.slider, 'Slider keyboard focus failed');
        ui.transparency.plus.grab_key_focus();
        assert(global.stage.get_key_focus() === ui.transparency.plus, 'Step button keyboard focus failed');
        checks.push('Native controls accept keyboard focus');
        for (const [key, item] of ui.switches) {
            const before = extension.controller.current.snapshot[key];
            assert(item.state === before && item.sensitive, `Invalid switch state before ${key} input`);
            item.toggle();
            await until(() => extension.controller.current.snapshot[key] === !before, `${key} setter failed`);
            await ready(extension);
        }
        ui.antiWind.setSubmenuShown(true); await sleep(250);
        for (const [mode, item] of ui.modes) {
            await click(item);
            await until(() => extension.controller.current.snapshot.antiWind === mode, `Anti-wind ${mode} failed`);
            assert(ui.menu.isOpen, `Clicking anti-wind ${mode} closed the menu`);
            await ready(extension);
        }
        ui.antiWind.setSubmenuShown(false); await sleep(250);
        checks.push('All six switches and anti-wind off/auto/max verified through mock CLI');
        const clicked = ui.switches.get('smartPause');
        const clickedBefore = extension.controller.current.snapshot.smartPause;
        await click(clicked);
        // Mid-transaction (settling), the switch shows the requested position rather than bouncing back.
        assert(extension.controller.current.inFlight?.key === 'smartPause' && clicked.state === !clickedBefore, 'Switch bounced back during its update');
        await until(() => extension.controller.current.snapshot.smartPause === !clickedBefore, 'Pointer click did not toggle switch');
        assert(ui.menu.isOpen, 'Clicking a switch closed the menu');
        await ready(extension);
        const readsBefore = events().filter(e => e.phase === 'start' && e.args[0] === 'status').length;
        await click(ui.refreshItem);
        await until(() => events().filter(e => e.phase === 'start' && e.args[0] === 'status').length > readsBefore, 'Refresh click did not read');
        assert(ui.menu.isOpen, 'Clicking Refresh closed the menu');
        await ready(extension);
        checks.push('Pointer clicks on switches, anti-wind modes and Refresh keep the menu open; switch shows requested value while updating');
        const beforeDrag = writes();
        ui.transparency.slider.emit('drag-begin');
        ui.transparency.slider.value = 0.43;
        await sleep(450);
        assert(writes() === beforeDrag && extension.controller.current.preview === 43, 'Drag wrote early');
        ui.transparency.slider.emit('drag-end');
        await until(() => extension.controller.current.snapshot.transparency === 43, 'Final drag intent lost');
        await ready(extension);
        ui.transparency.plus.emit('clicked', 1); ui.transparency.plus.emit('clicked', 1);
        await until(() => extension.controller.current.snapshot.transparency === 63, 'Step debounce failed');
        await ready(extension);
        ui.transparency.minus.emit('clicked', 1); ui.menu.close();
        await until(() => extension.controller.current.snapshot.transparency === 53, 'Close lost preview');
        await ready(extension);
        checks.push('Slider drag, integer values, step debounce and close commit');
        ui.menu.open(); await sleep(100);
        const keyboard = global.stage.context.get_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const key = async symbol => {
            keyboard.notify_keyval(GLib.get_monotonic_time(), symbol, Clutter.KeyState.PRESSED);
            keyboard.notify_keyval(GLib.get_monotonic_time(), symbol, Clutter.KeyState.RELEASED);
            await sleep(60);
        };
        const focused = ui.switches.get('anc');
        focused.grab_key_focus();
        await key(Clutter.KEY_Down);
        assert(global.stage.get_key_focus() !== focused, 'Down did not move focus');
        await key(Clutter.KEY_Up);
        assert(global.stage.get_key_focus() === focused, 'Up did not restore focus');
        const keyboardBefore = extension.controller.current.snapshot.anc;
        await key(Clutter.KEY_space);
        await until(() => extension.controller.current.snapshot.anc === !keyboardBefore, 'Space failed to toggle switch');
        await ready(extension);
        assert(ui.menu.isOpen && global.stage.get_key_focus() === focused, 'Keyboard focus left the switch after its update');
        ui.transparency.slider.grab_key_focus();
        const transparencyBefore = extension.controller.current.snapshot.transparency;
        await key(Clutter.KEY_Right);
        await until(() => extension.controller.current.snapshot.transparency > transparencyBefore, 'Right failed to adjust slider');
        await ready(extension);
        await key(Clutter.KEY_Escape);
        assert(!ui.menu.isOpen, 'Escape failed to close menu');
        checks.push('Virtual keyboard Up/Down navigation, Space toggle, Right slider, Escape close');
        // Optional shortcut toggles the menu through real key events.
        extension.settings.set_strv('momentum4-toggle-menu', ['<Control>F9']); await sleep(200);
        const chord = async () => {
            for (const sym of [Clutter.KEY_Control_L, Clutter.KEY_F9]) {
                keyboard.notify_keyval(GLib.get_monotonic_time(), sym, Clutter.KeyState.PRESSED); await sleep(40); }
            for (const sym of [Clutter.KEY_F9, Clutter.KEY_Control_L]) {
                keyboard.notify_keyval(GLib.get_monotonic_time(), sym, Clutter.KeyState.RELEASED); await sleep(40); }
            await sleep(250);
        };
        await chord();
        assert(ui.menu.isOpen, 'Shortcut did not open the menu');
        await ready(extension);
        await chord();
        assert(!ui.menu.isOpen, 'Shortcut did not close the menu');
        extension.settings.set_strv('momentum4-toggle-menu', []); await sleep(200);
        await chord();
        assert(!ui.menu.isOpen, 'Cleared shortcut still opens the menu');
        checks.push('Optional keyboard shortcut opens and closes the menu, and can be cleared');
        let commands = events().length;
        extension.settings.set_boolean('show-battery-percentage', false); await sleep(200);
        assert(!ui.battery.visible && events().length === commands, 'Battery preference invoked CLI');
        extension.settings.set_boolean('show-battery-percentage', true);
        // Change path during a hung read, then immediately change back. No live path is selected.
        GLib.file_set_contents(`${GLib.getenv('MOMENTUMCTL_MOCK_DIR')}/mode`, 'hang');
        extension.controller.refresh(); await sleep(150);
        extension.settings.set_string('cli-path', `${GLib.getenv('MOMENTUMCTL_TEST_MOCK')} missing`);
        await sleep(100);
        GLib.file_set_contents(`${GLib.getenv('MOMENTUMCTL_MOCK_DIR')}/mode`, 'stateful');
        extension.settings.set_string('cli-path', GLib.getenv('MOMENTUMCTL_TEST_MOCK'));
        await ready(extension); ui = extension.indicator;
        checks.push('Path change cancels a real hung child and safely re-resolves');
        for (let i = 0; i < 3; i++) {
            const previousMenu = extension.indicator.menu.actor;
            extension.disable();
            assert(!Main.layoutManager._trackedActors.some(d => d.actor === previousMenu), 'Disposed popup remains tracked as chrome');
            extension.enable();
            // Native PopupMenu positioning requires its source actor allocation.
            await sleep(100);
            await until(() => extension.indicator.has_allocation(), 'New panel icon was not allocated');
            extension.indicator.menu.open();
            await ready(extension);
            assert(Main.panel.statusArea[uuid] === extension.indicator, 'Duplicate or missing panel icon');
        }
        checks.push('Repeated immediate disable/enable, including immediate menu open');
        ui = extension.indicator;
        GLib.file_set_contents(`${GLib.getenv('MOMENTUMCTL_MOCK_DIR')}/mode`, 'malformed');
        await extension.controller.refresh();
        assert(extension.controller.current.snapshotStale && !ui.battery.visible && !ui.switches.get('anc').sensitive && !ui.switches.get('anc').reactive && ui.detail.visible, 'Stale state is not visible or controls remain reactive');
        GLib.file_set_contents(`${GLib.getenv('MOMENTUMCTL_MOCK_DIR')}/mode`, 'stateful');
        await extension.controller.refresh(); await ready(extension);
        checks.push('Malformed status disables controls, hides panel battery, recovers');
        assert(extension.controller.link === 'unknown', 'Test Shell reached a real BlueZ');
        const bluez = fakeBluez();
        await until(() => extension.controller.link === 'disconnected' && !extension.controller.ready, 'BlueZ disconnect not reflected');
        assert(ui.detail.label.text.includes('Headset disconnected') && !ui.battery.visible, 'Disconnect not shown');
        const readsWhileGone = statusReads();
        extension.controller.setMenuOpen(false); await sleep(500);
        assert(statusReads() === readsWhileGone, 'Polled while BlueZ reported no headset');
        bluez.setConnected(true);
        await until(() => extension.controller.ready && statusReads() > readsWhileGone, 'Reconnect did not trigger a read');
        await ready(extension);
        checks.push('BlueZ disconnect shows unavailable without polling; reconnect reads again');
        const beforePrefs = events().length;
        const prefsScript = Gio.File.new_for_uri(import.meta.url).get_parent().get_child('prefs-smoke.js').get_path();
        const prefsProcess = Gio.Subprocess.new(['/usr/bin/gjs', '-m', prefsScript], Gio.SubprocessFlags.NONE);
        const prefsExit = new Promise((resolve, reject) => prefsProcess.wait_async(null, (p, result) => {
            try { p.wait_finish(result); resolve(); } catch (e) { reject(e); }
        }));
        let prefsTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => { prefsTimer = 0; prefsProcess.force_exit(); return GLib.SOURCE_REMOVE; });
        await prefsExit;
        if (prefsTimer) GLib.Source.remove(prefsTimer);
        assert(prefsProcess.get_if_exited() && prefsProcess.get_exit_status() === 0, 'Preferences process failed');
        const [, prefsBytes] = GLib.file_get_contents(`${output}/prefs-result.json`);
        const prefsReport = JSON.parse(new TextDecoder().decode(prefsBytes));
        assert(prefsReport.passed, `Preferences checks failed: ${prefsReport.error}`);
        assert(events().length === beforePrefs, 'Preferences started headset commands');
        checks.push('Packaged GTK4 preferences run separately, path validation, battery binding, zero CLI commands');
        ui.menu.open(); await sleep(250);
        // Simulate a short monitor so the settings section must scroll.
        ui.menu.box.set_style('max-height: 360px;'); await sleep(300);
        const [, contentHeight] = ui.controls.box.get_preferred_height(-1);
        assert(ui.scroll.height < contentHeight, 'Settings section did not shrink to scroll');
        const visible = (actor, area) => {
            const [, y] = actor.get_transformed_position();
            const [, top] = area.get_transformed_position();
            return y >= top && y + actor.height <= top + area.height + 1;
        };
        assert(visible(ui.refreshItem, ui.menu.box), 'Footer actions scrolled out of view');
        ui.switches.get('comfortCall').grab_key_focus();
        await sleep(300);
        assert(visible(ui.switches.get('comfortCall'), ui.scroll), 'Offscreen keyboard focus was not revealed');
        checks.push('Settings scroll on a short monitor, focus reveals lower controls, footer stays visible');
        const screenshot = new Shell.Screenshot();
        const file = Gio.File.new_for_path(`${output}/menu.png`);
        const stream = file.create(Gio.FileCreateFlags.NONE, null);
        try { await screenshot.screenshot(false, stream); } finally { stream.close(null); }
        checks.push('Menu screenshot captured for visual inspection');
        const allEvents = events();
        assert(allEvents.every(e => !e.overlap?.length), 'Real child overlap detected');
        extension.disable(); await sleep(250);
        assert(!Main.panel.statusArea[uuid], 'Panel icon leaked after disable');
        for (const ev of allEvents.filter(e => e.phase === 'start'))
            assert(!GLib.file_test(`/proc/${ev.pid}`, GLib.FileTest.EXISTS), 'Mock child leaked');
        checks.push('No overlapping or surviving mock children, final teardown');
        GLib.file_set_contents(`${output}/result.json`, JSON.stringify({passed: true,
            monitorScale, themeScale: St.ThemeContext.get_for_stage(global.stage).scale_factor,
            textScale: new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).get_double('text-scaling-factor'), checks}));
    } catch (e) {
        GLib.file_set_contents(`${output}/result.json`, JSON.stringify({passed: false, checks, error: e.message, stack: e.stack}));
        throw e;
    }
}
