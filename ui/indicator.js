import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import {FIELDS} from '../lib/commands.js';
import {diagnostic} from '../lib/headsetController.js';
import {TransparencyRow} from './transparencyRow.js';

export const Indicator = GObject.registerClass(class Indicator extends PanelMenu.Button {
    _init(controller, settings, openPreferences) {
        super._init(0.5, 'Momentum 4 Controls');
        this.controller = controller;
        this.settings = settings;
        this.signals = [];
        this.rendering = false;
        this.dead = false;
        this.localError = '';
        const connect = (object, signal, callback) => {
            const id = object.connect(signal, (...args) => { if (!this.dead) return callback(...args); });
            this.signals.push([object, id]);
        };
        const panelBox = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        panelBox.add_child(new St.Icon({icon_name: 'audio-headphones-symbolic', style_class: 'system-status-icon'}));
        this.battery = new St.Label({text: '', y_align: Clutter.ActorAlign.CENTER});
        panelBox.add_child(this.battery);
        this.add_child(panelBox);
        this.accessible_name = 'Momentum 4 Controls';
        this.header = new PopupMenu.PopupMenuItem('Momentum 4 Controls', {reactive: false, can_focus: false});
        this.status = new PopupMenu.PopupMenuItem('Checking', {reactive: false, can_focus: false});
        this.menu.addMenuItem(this.header);
        this.menu.addMenuItem(this.status);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Noise control'));
        this.switches = new Map();
        const addSwitch = key => {
            const item = new PopupMenu.PopupSwitchMenuItem(FIELDS[key].title, false);
            item.accessible_name = FIELDS[key].title;
            connect(item, 'toggled', (_item, value) => {
                // Shell 50 can defer a reentrant notify until the render guard has
                // cleared. A rendered value always equals the confirmed snapshot.
                if (!this.rendering && item.sensitive && value !== controller.current.snapshot?.[key])
                    controller.setSetting(key, value);
            });
            this.switches.set(key, item);
            this.menu.addMenuItem(item);
        };
        addSwitch('anc'); addSwitch('adaptive');
        this.transparency = new TransparencyRow(controller, connect);
        this.menu.addMenuItem(this.transparency.heading);
        this.menu.addMenuItem(this.transparency.item);
        this.antiWind = new PopupMenu.PopupSubMenuMenuItem('Anti-wind: Unavailable');
        this.modes = new Map();
        for (const mode of ['off', 'auto', 'max']) {
            const item = new PopupMenu.PopupMenuItem(mode[0].toUpperCase() + mode.slice(1));
            connect(item, 'activate', () => { if (item.sensitive) controller.setSetting('antiWind', mode); });
            this.antiWind.menu.addMenuItem(item);
            this.modes.set(mode, item);
        }
        this.menu.addMenuItem(this.antiWind);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Behaviour'));
        for (const key of ['smartPause', 'onHeadDetection', 'autoAnswer', 'comfortCall']) addSwitch(key);
        this.detail = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
        this.detail.label.clutter_text.line_wrap = true;
        this.detail.label.clutter_text.ellipsize = 0;
        this.detail.label.x_expand = true;
        this.menu.addMenuItem(this.detail);
        this.dismiss = new PopupMenu.PopupMenuItem('Dismiss update error');
        connect(this.dismiss, 'activate', () => controller.dismissWriteError());
        this.menu.addMenuItem(this.dismiss);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.refreshItem = new PopupMenu.PopupMenuItem('Refresh');
        connect(this.refreshItem, 'activate', () => { this.localError = ''; controller.refresh(); });
        this.menu.addMenuItem(this.refreshItem);
        const bluetooth = new PopupMenu.PopupMenuItem('Bluetooth Settings');
        connect(bluetooth, 'activate', () => this._bluetoothSettings());
        this.menu.addMenuItem(bluetooth);
        const prefs = new PopupMenu.PopupMenuItem('Preferences');
        connect(prefs, 'activate', () => {
            Promise.resolve(openPreferences()).catch(e => {
                if (!this.dead) { this.localError = `Could not open Preferences: ${diagnostic(e.message)}`; this.render(controller.current); }
            });
        });
        this.menu.addMenuItem(prefs);
        // PopupMenu owns keyboard navigation; wrap its content in a native scroll view.
        this.menu._boxPointer.bin.set_child(null);
        this.scroll = new St.ScrollView({hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC});
        this.scroll.add_style_class_name('momentumctl-menu');
        this.scroll.set_child(this.menu.box);
        this.menu._boxPointer.bin.set_child(this.scroll);
        const fit = () => {
            if (!this.get_stage()) return;
            const monitor = Main.layoutManager.findMonitorForActor(this) ?? Main.layoutManager.primaryMonitor;
            if (monitor) this.scroll.set_style(`max-height: ${Math.max(180, monitor.height - Main.panel.height - 48)}px; max-width: ${Math.max(240, monitor.width - 48)}px;`);
        };
        connect(this.menu, 'open-state-changed', (_menu, open) => { fit(); controller.setMenuOpen(open); });
        connect(Main.layoutManager, 'monitors-changed', fit);
        connect(global.stage, 'notify::key-focus', () => {
            const focused = global.stage.get_key_focus();
            if (this.menu.isOpen && focused?.has_allocation() && this.menu.box.contains(focused))
                ensureActorVisibleInScrollView(this.scroll, focused);
        });
        connect(settings, 'changed::show-battery-percentage', () => this.render(controller.current));
        fit();
        this.unsubscribe = controller.subscribe(state => { if (!this.dead) this.render(state); });
    }
    _bluetoothSettings() {
        try {
            const executable = GLib.find_program_in_path('gnome-control-center');
            if (!executable) throw new Error('gnome-control-center was not found');
            // GLib's default spawn automatically reaps this OS settings application.
            GLib.spawn_async(null, [GLib.canonicalize_filename(executable, null), 'bluetooth'], null,
                GLib.SpawnFlags.DEFAULT, null);
        } catch (e) {
            this.localError = `Could not open Bluetooth Settings: ${diagnostic(e.message)}`;
            this.render(this.controller.current);
        }
    }
    render(state) {
        if (this.dead) return;
        this.rendering = true;
        try {
            const valid = state.snapshot && !state.snapshotStale;
            const idle = state.activity === 'idle';
            const sensitive = Boolean(valid && idle && state.connection === 'ready');
            this.battery.visible = Boolean(valid && this.settings.get_boolean('show-battery-percentage'));
            this.battery.text = valid ? `${state.snapshot.battery}%` : '';
            this.header.label.text = `Momentum 4 Controls${state.snapshot ? ` · Battery ${state.snapshot.battery}%${state.snapshotStale ? ' (stale)' : ''}` : ''}`;
            let status = state.availability === 'checking' ? 'Checking' : valid ? 'Available' : 'Unavailable';
            if (!idle) status = ['writing', 'settling', 'verifying'].includes(state.activity) ? 'Updating' : 'Checking';
            else if (state.readError || state.writeError || this.localError) status = 'Error';
            this.status.label.text = status;
            this.accessible_name = `Momentum 4 Controls, ${status}${valid ? `, battery ${state.snapshot.battery} percent` : ''}`;
            for (const [key, item] of this.switches) {
                if (state.snapshot) { item.setToggleState(state.snapshot[key]); item.setStatus(null); }
                else item.setStatus('Unavailable');
                item.sensitive = sensitive;
                // setStatus(null) itself makes the item reactive. Resync even when
                // the sensitivity value stayed false across two busy renders.
                item.syncSensitive();
            }
            this.transparency.render(state, sensitive);
            const mode = state.snapshot?.antiWind;
            this.antiWind.label.text = `Anti-wind: ${mode ? mode[0].toUpperCase() + mode.slice(1) : 'Unavailable'}`;
            this.antiWind.sensitive = sensitive;
            for (const [key, item] of this.modes) {
                item.sensitive = sensitive;
                item.setOrnament(key === mode ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
            }
            const messages = [this.localError];
            for (const error of [state.writeError, state.readError]) {
                if (error) messages.push([error.message, error.detail].filter(Boolean).join(': '));
            }
            if (state.snapshotStale && state.snapshot) messages.push('Displayed values are stale. Refresh to confirm current settings.');
            this.detail.label.text = messages.filter(Boolean).join('\n');
            this.detail.visible = Boolean(this.detail.label.text);
            this.dismiss.visible = Boolean(state.writeError);
            this.refreshItem.sensitive = idle;
        } finally { this.rendering = false; }
    }
    destroy() {
        if (this.dead) return;
        this.dead = true;
        this.unsubscribe?.();
        for (const [object, id] of this.signals ?? []) object.disconnect(id);
        this.signals = [];
        // Pop the native modal grab and detach chrome while the popup is alive.
        // This prevents region recomputation from querying a disposed BoxPointer.
        if (this.menu?.actor) {
            if (this.menu.actor.get_stage()) this.menu.actor.get_allocation_box();
            this.menu.close(0);
            this.menu.actor.remove_all_transitions();
            this.menu.actor.hide();
            if (this.menu.actor.get_parent() === Main.uiGroup)
                Main.layoutManager.removeChrome(this.menu.actor);
        }
        super.destroy();
    }
});
