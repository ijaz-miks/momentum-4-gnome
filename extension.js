import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {BluezWatcher} from './lib/bluezWatcher.js';
import {CliExecutor} from './lib/cliExecutor.js';
import {resolveExecutable} from './lib/executableResolver.js';
import {HeadsetController} from './lib/headsetController.js';
import {scheduler} from './lib/scheduler.js';
import {Indicator} from './ui/indicator.js';

// Persist only the previous teardown barrier across enable instances, never headset state.
let drain = Promise.resolve();

export default class MomentumExtension extends Extension {
    enable() {
        this.enabled = true;
        this.epoch = (this.epoch ?? 0) + 1;
        try {
            this.settings = this.getSettings();
            this.settingsSignal = this.settings.connect('changed::cli-path', () => this._replace());
            this.batterySignal = this.settings.connect('changed::show-battery-percentage',
                () => this.controller?.setPollWhileClosed(this.settings.get_boolean('show-battery-percentage')));
            this.link = 'unknown';
            this._replace();
            this.bluez = new BluezWatcher(link => {
                this.link = link;
                this.controller?.setLinkState(link);
            });
            this.bluez.start();
            Main.wm.addKeybinding('momentum4-toggle-menu', this.settings, Meta.KeyBindingFlags.NONE,
                // POPUP lets the same shortcut close the open menu, which holds a modal grab.
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
                () => this.indicator?.menu.toggle());
            this.keybinding = true;
            this.sleepCancellable = new Gio.Cancellable();
            const epoch = this.epoch;
            Gio.bus_get(Gio.BusType.SYSTEM, this.sleepCancellable, (_source, result) => {
                let connection;
                try { connection = Gio.bus_get_finish(result); } catch { return; }
                if (!this.enabled || epoch !== this.epoch) return;
                this.sleepConnection = connection;
                this.sleepSignal = connection.signal_subscribe('org.freedesktop.login1', 'org.freedesktop.login1.Manager',
                    'PrepareForSleep', '/org/freedesktop/login1', null, Gio.DBusSignalFlags.NONE,
                    (_c, _s, _p, _i, _n, parameters) => {
                        if (!this.enabled) return;
                        this.sleeping = parameters.deep_unpack()[0];
                        if (this.sleeping) this.controller?.pause();
                        else this.controller?.resume();
                    });
            });
        } catch (e) { this.disable(); throw e; }
    }
    _replace() {
        const epoch = this.epoch;
        if (this.controller) drain = Promise.all([drain, this.controller.stop()]).then(() => {});
        this.indicator?.destroy();
        const executor = new CliExecutor({logFailure: r => console.warn(
            `Momentum CLI operation ${r.operationId}: exit=${r.exitCode}, signal=${r.signal}, timeout=${r.timedOut}, streamError=${Boolean(r.error)}, elapsed=${Math.round(r.elapsedMs)}ms`)});
        this.controller = new HeadsetController({executor, scheduler, resolve: resolveExecutable,
            cliPath: this.settings.get_string('cli-path'),
            pollWhileClosed: this.settings.get_boolean('show-battery-percentage'),
            onWake: () => { this.sleeping = false; }});
        const controller = this.controller;
        controller.link = this.link;
        // UI actions must also wait for an earlier lifecycle's child to exit.
        controller.paused = true;
        this.indicator = new Indicator(controller, this.settings, () => this.openPreferences());
        Main.panel.addToStatusArea(this.uuid, this.indicator);
        const previousDrain = drain;
        previousDrain.then(() => {
            if (this.enabled && epoch === this.epoch && this.controller === controller) {
                if (this.sleeping) controller.pause();
                else controller.resume();
            }
        }).catch(e => console.error(`Momentum startup: ${e.message}`));
    }
    disable() {
        this.enabled = false;
        this.epoch = (this.epoch ?? 0) + 1;
        for (const id of [this.settingsSignal, this.batterySignal]) {
            if (id) this.settings.disconnect(id);
        }
        this.settingsSignal = this.batterySignal = 0;
        if (this.keybinding) Main.wm.removeKeybinding('momentum4-toggle-menu');
        this.keybinding = false;
        this.bluez?.stop();
        this.bluez = null;
        this.sleepCancellable?.cancel();
        this.sleepCancellable = null;
        if (this.sleepSignal) this.sleepConnection.signal_unsubscribe(this.sleepSignal);
        this.sleepSignal = 0;
        this.sleepConnection = null;
        if (this.controller) drain = Promise.all([drain, this.controller.stop()]).then(() => {});
        this.indicator?.destroy();
        this.indicator = null;
        this.controller = null;
        this.settings = null;
        this.sleeping = false;
    }
}
