import Gio from 'gi://Gio';

/** GAIA RFCOMM profile registered by momentumctl (src/ble.rs). */
export const GAIA_UUID = 'a2129ff3-081b-4c45-8afe-469d9c4842ec';
const DEVICE = 'org.bluez.Device1';

/**
 * Read-only BlueZ observer. Reports whether any device offering the GAIA
 * profile is connected: 'connected', 'disconnected', or 'unknown' when BlueZ
 * is not reachable. It never calls BlueZ methods or talks to the headset.
 */
export class BluezWatcher {
    constructor(onChange, {busType = Gio.BusType.SYSTEM, name = 'org.bluez'} = {}) {
        this.onChange = onChange;
        this.busType = busType;
        this.name = name;
        this.manager = null;
        this.signals = [];
        this.state = 'unknown';
        this.cancellable = null;
    }

    start() {
        this.cancellable = new Gio.Cancellable();
        const cancellable = this.cancellable;
        // DO_NOT_AUTO_START: watching must never start bluetoothd through activation.
        Gio.DBusObjectManagerClient.new_for_bus(this.busType, Gio.DBusObjectManagerClientFlags.DO_NOT_AUTO_START,
            this.name, '/', null, cancellable, (_source, result) => {
                let manager;
                try { manager = Gio.DBusObjectManagerClient.new_for_bus_finish(result); } catch { return; }
                if (cancellable.is_cancelled()) return;
                this.manager = manager;
                for (const signal of ['object-added', 'object-removed', 'interface-added',
                    'interface-removed', 'interface-proxy-properties-changed', 'notify::name-owner'])
                    this.signals.push(manager.connect(signal, () => this._update()));
                this._update();
            });
    }

    _update() {
        let next = 'unknown';
        if (this.manager?.name_owner) {
            next = 'disconnected';
            for (const object of this.manager.get_objects()) {
                const device = object.get_interface(DEVICE);
                const uuids = device?.get_cached_property('UUIDs')?.deep_unpack() ?? [];
                if (device?.get_cached_property('Connected')?.unpack() && uuids.includes(GAIA_UUID))
                    next = 'connected';
            }
        }
        if (next === this.state) return;
        this.state = next;
        this.onChange(next);
    }

    stop() {
        this.cancellable?.cancel();
        this.cancellable = null;
        for (const id of this.signals) this.manager.disconnect(id);
        this.signals = [];
        this.manager = null;
        this.onChange = () => {};
    }
}
