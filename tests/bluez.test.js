import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {BluezWatcher, GAIA_UUID} from '../lib/bluezWatcher.js';
import {assert, equal} from './assert.js';

// Runs against a fake org.bluez ObjectManager on a private session bus
// (check.sh starts it with dbus-run-session). Never touches real Bluetooth.
const NAME = 'org.bluez.MomentumTest';
const XML = `<node><interface name="org.bluez.Device1">
  <property name="Connected" type="b" access="read"/>
  <property name="UUIDs" type="as" access="read"/>
</interface></node>`;
const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { resolve(); return GLib.SOURCE_REMOVE; }));

function device(server, path, uuids, connected) {
    const state = {connected};
    const iface = Gio.DBusExportedObject.wrapJSObject(XML, {
        get Connected() { return state.connected; },
        get UUIDs() { return uuids; },
    });
    const object = Gio.DBusObjectSkeleton.new(path);
    object.add_interface(iface);
    server.export(object);
    return {
        path,
        setConnected(value) {
            state.connected = value;
            iface.emit_property_changed('Connected', GLib.Variant.new_boolean(value));
        },
    };
}

export async function run() {
    assert(GLib.getenv('DBUS_SESSION_BUS_ADDRESS'), 'Run under dbus-run-session');
    const connection = Gio.bus_get_sync(Gio.BusType.SESSION, null);
    const server = Gio.DBusObjectManagerServer.new('/');
    const headset = device(server, '/org/bluez/hci0/dev_00_00_00_00_00_01', [GAIA_UUID], false);
    device(server, '/org/bluez/hci0/dev_00_00_00_00_00_02', ['0000110b-0000-1000-8000-00805f9b34fb'], true);
    server.set_connection(connection);
    const owner = Gio.bus_own_name_on_connection(connection, NAME, Gio.BusNameOwnerFlags.NONE, null, null);
    await sleep(100);

    const seen = [];
    const watcher = new BluezWatcher(state => seen.push(state), {busType: Gio.BusType.SESSION, name: NAME});
    watcher.start();
    await sleep(300);
    equal(seen, ['disconnected'], 'A connected non-GAIA device is not the headset');
    headset.setConnected(true); await sleep(200);
    equal(seen, ['disconnected', 'connected']);
    headset.setConnected(false); await sleep(200);
    headset.setConnected(true); await sleep(200);
    server.unexport(headset.path); await sleep(200);
    equal(seen, ['disconnected', 'connected', 'disconnected', 'connected', 'disconnected']);
    Gio.bus_unown_name(owner); await sleep(300);
    equal(seen.at(-1), 'unknown', 'Losing BlueZ is reported as unknown');
    watcher.stop();
    const count = seen.length;
    Gio.bus_own_name_on_connection(connection, NAME, Gio.BusNameOwnerFlags.NONE, null, null);
    await sleep(300);
    assert(seen.length === count, 'Stopped watcher still reported changes');
}
