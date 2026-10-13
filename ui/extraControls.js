import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {EXTRA_FIELDS, validateValue} from '../lib/commands.js';
import {_, N_, format} from '../lib/i18n.js';

const Action = GObject.registerClass({GTypeName: 'IjazMomentum4Action', Signals: {'triggered': {}}},
class Action extends PopupMenu.PopupMenuItem {
    activate() { this.emit('triggered'); }
});
const Switch = GObject.registerClass({GTypeName: 'IjazMomentum4Switch'}, class Switch extends PopupMenu.PopupSwitchMenuItem {
    activate() { if (this._switch.mapped) this.toggle(); }
});
const CHOICES = {
    soundMode: [[0, N_('Off')], [1, N_('Equalizer')], [2, N_('Speech / podcast')], [3, N_('Sound Personalization')]],
    sidetone: [[0, N_('Off')], [1, N_('Very low')], [2, N_('Low')], [3, N_('Medium')], [4, N_('High')], [5, N_('Very high')]],
    promptMode: [[0, N_('Off')], [1, N_('Tones only')], [2, N_('Tones and voice')]],
    audioPriority: [[0, N_('Advanced sound quality')], [1, N_('Bluetooth compatibility')]],
    autoPowerOff: [[0, N_('Never')], [900, N_('15 minutes')], [1800, N_('30 minutes')], [3600, N_('1 hour')], [7200, N_('2 hours')]],
};
const CODECS = ['SBC', 'AAC', 'aptX', 'aptX Low Latency', 'MP3', 'aptX HD', 'FastStream', 'LHDC', 'aptX Adaptive', 'aptX Lossless', 'LC3'];
const LANGUAGES = [N_('English'), N_('German'), N_('French'), N_('Spanish'), N_('Chinese'), N_('Japanese'), N_('Russian'), N_('Korean')];

class EqRow {
    constructor(band, controller, connect) {
        this.band = band;
        this.key = `eq${band}`;
        this.controller = controller;
        this.rendering = false;
        this.dragging = false;
        this.preview = null;
        this.timer = 0;
        this.dead = false;
        this.heading = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
        this.item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this.minus = new St.Button({label: '−', can_focus: true, accessible_name: format(_('Decrease EQ band %s'), band + 1)});
        this.plus = new St.Button({label: '+', can_focus: true, accessible_name: format(_('Increase EQ band %s'), band + 1)});
        this.slider = new Slider(0.5);
        this.slider.x_expand = true;
        this.slider.accessible_name = format(_('Equalizer band %s'), band + 1);
        this.item.add_child(this.minus); this.item.add_child(this.slider); this.item.add_child(this.plus);
        connect(this.slider, 'drag-begin', () => { this.dragging = true; this._cancelTimer(); });
        connect(this.slider, 'drag-end', () => { this.dragging = false; this.commit(); });
        connect(this.slider, 'notify::value', () => {
            if (this.rendering || !this.sensitive) return;
            const value = Math.round(this.minimum + this.slider.value * (this.maximum - this.minimum));
            if (value === this._shown(this.controller.current)) return;
            this.preview = value;
            this._label(value);
            this._cancelTimer();
            if (!this.dragging) this.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                this.timer = 0; this.commit(); return GLib.SOURCE_REMOVE;
            });
        });
        for (const [button, delta] of [[this.minus, -5], [this.plus, 5]]) connect(button, 'clicked', () => {
            if (!this.sensitive) return;
            const before = this.preview ?? this._shown(this.controller.current);
            this.preview = Math.max(this.minimum, Math.min(this.maximum, before + delta));
            this.render(this.controller.current, this.sensitive);
            this._cancelTimer();
            this.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                this.timer = 0; this.commit(); return GLib.SOURCE_REMOVE;
            });
        });
    }
    _cancelTimer() { if (this.timer) GLib.Source.remove(this.timer); this.timer = 0; }
    _shown(state) { return state.inFlight?.key === this.key ? state.inFlight.value : state.snapshot?.[this.key]; }
    _label(value) { this.heading.label.text = format(_('Band %s: %s dB'), this.band + 1, (value / 10).toFixed(1)); }
    commit() {
        this._cancelTimer();
        const value = this.preview;
        this.preview = null;
        if (!this.dead && value !== null && this.controller.ready) this.controller.setSetting(this.key, value);
    }
    render(state, sensitive) {
        this.rendering = true;
        try {
            const eq = state.snapshot?._equalizer;
            const visible = Boolean(eq && this.band < eq.gains.length);
            this.heading.visible = visible; this.item.visible = visible;
            this.sensitive = Boolean(visible && sensitive);
            if (!visible) {
                this._cancelTimer(); this.preview = null; this.dragging = false;
                return;
            }
            this.minimum = eq.minGain; this.maximum = eq.maxGain;
            if (!this.controller.ready) { this._cancelTimer(); this.preview = null; this.dragging = false; }
            const value = this.preview ?? this._shown(state);
            this._label(value);
            this.slider.value = (value - this.minimum) / (this.maximum - this.minimum);
            for (const item of [this.slider, this.minus, this.plus]) {
                item.reactive = this.sensitive; item.can_focus = this.sensitive;
            }
        } finally { this.rendering = false; }
    }
    destroy() { this.dead = true; this._cancelTimer(); this.preview = null; }
}

/** Native Shell controls. All headset operations pass through the existing queue. */
export class ExtraControls {
    constructor(controller, settings, connect) {
        this.controller = controller;
        this.settings = settings;
        this.rendering = false;
        this.state = null;
        this.switches = new Map();
        this.choices = new Map();
        this.peerItems = new Map();
        this.eqRows = [];
        this.connections = new PopupMenu.PopupMenuSection();
        this.connections.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Connection management')));
        this._switch('multipoint', this.connections, connect);
        this.peers = new PopupMenu.PopupSubMenuMenuItem(_('Paired devices'));
        this.connections.addMenuItem(this.peers);
        for (let index = 0; index < 16; index++) {
            const item = new Action('');
            item.label.x_expand = true;
            const status = new St.Label({text: '', style_class: 'dim-label', y_align: Clutter.ActorAlign.CENTER});
            item.add_child(status);
            connect(item, 'triggered', () => {
                if (!item.sensitive) return;
                const peer = this.state.snapshot._connections.peers[index];
                this.controller.setConnection(index, peer.connected ? 'disconnect' : 'switch');
            });
            item.visible = false;
            this.peers.menu.addMenuItem(item);
            this.peerItems.set(index, {item, status});
        }
        this.connectionHint = new PopupMenu.PopupMenuItem(_('Switching keeps this computer connected and replaces the other source.'), {reactive: false, can_focus: false});
        this.connectionHint.label.clutter_text.line_wrap = true;
        this.connectionHint.label.clutter_text.ellipsize = 0;
        this.connections.addMenuItem(this.connectionHint);
        this.reconnect = new Action(_('Connect headset to this computer'));
        connect(this.reconnect, 'triggered', () => { if (this.reconnect.sensitive) this.controller.reconnect(); });
        this.connections.addMenuItem(this.reconnect);

        this.sound = new PopupMenu.PopupMenuSection();
        this.sound.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Sound')));
        this._choice('soundMode', this.sound, connect);
        this._switch('bassBoost', this.sound, connect);
        this.eq = new PopupMenu.PopupSubMenuMenuItem(_('Equalizer'));
        this.sound.addMenuItem(this.eq);
        for (let band = 0; band < 16; band++) {
            const row = new EqRow(band, controller, connect);
            this.eqRows.push(row);
            this.eq.menu.addMenuItem(row.heading); this.eq.menu.addMenuItem(row.item);
        }
        this.flat = new Action(_('Reset EQ to flat'));
        connect(this.flat, 'triggered', () => {
            if (!this.flat.sensitive) return;
            controller.applyEqPreset(this.state.snapshot._equalizer.gains.map(() => 0));
        });
        this.eq.menu.addMenuItem(this.flat);
        this.presets = new PopupMenu.PopupSubMenuMenuItem(_('Saved EQ presets'));
        this.presetRows = [];
        this.presetNames = [];
        this.selectedPreset = null;
        this.removedPreset = null;
        for (let index = 0; index < 32; index++) {
            const action = new Action('');
            connect(action, 'triggered', () => {
                if (!action.sensitive) return;
                const name = this.presetNames[index];
                const gains = this.settings.get_value('equalizer-presets').deep_unpack()[name];
                this.selectedPreset = name;
                controller.applyEqPreset(gains);
            });
            this.presets.menu.addMenuItem(action); this.presetRows.push(action);
        }
        this.sound.addMenuItem(this.presets);
        const presetInput = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this.presetEntry = new St.Entry({hint_text: _('Preset name'), can_focus: true, x_expand: true});
        presetInput.add_child(this.presetEntry); this.eq.menu.addMenuItem(presetInput);
        this.savePreset = new Action(_('Save current EQ preset'));
        connect(this.savePreset, 'triggered', () => {
            if (!this.savePreset.sensitive) return;
            const name = this.presetEntry.text.trim();
            const presets = this.settings.get_value('equalizer-presets').deep_unpack();
            if (!name || new TextEncoder().encode(name).length > 64 || /[\x00-\x1f\x7f]/.test(name) ||
                (Object.keys(presets).length >= 32 && !Object.hasOwn(presets, name))) {
                this.presetEntry.add_style_class_name('error'); return;
            }
            const entries = Object.entries(presets).filter(([key]) => key !== name);
            entries.push([name, [...this.state.snapshot._equalizer.gains]]);
            this.settings.set_value('equalizer-presets', new GLib.Variant('a{sai}', Object.fromEntries(entries)));
            this.selectedPreset = name;
            this.presetEntry.remove_style_class_name('error');
            this.render(this.state, this.sensitive);
        });
        this.eq.menu.addMenuItem(this.savePreset);
        this.removePreset = new Action(_('Remove selected preset'));
        connect(this.removePreset, 'triggered', () => {
            if (!this.removePreset.sensitive) return;
            const presets = this.settings.get_value('equalizer-presets').deep_unpack();
            this.removedPreset = [this.selectedPreset, [...presets[this.selectedPreset]]];
            this.settings.set_value('equalizer-presets', new GLib.Variant('a{sai}',
                Object.fromEntries(Object.entries(presets).filter(([name]) => name !== this.selectedPreset))));
            this.selectedPreset = null;
            this.render(this.state, this.sensitive);
        });
        this.eq.menu.addMenuItem(this.removePreset);
        this.undoPreset = new Action(_('Undo preset removal'));
        connect(this.undoPreset, 'triggered', () => {
            if (!this.undoPreset.sensitive) return;
            const presets = this.settings.get_value('equalizer-presets').deep_unpack();
            const [name, gains] = this.removedPreset;
            if (Object.hasOwn(presets, name)) return;
            this.settings.set_value('equalizer-presets', new GLib.Variant('a{sai}',
                Object.fromEntries([...Object.entries(presets), [name, gains]])));
            this.selectedPreset = name; this.removedPreset = null;
            this.render(this.state, this.sensitive);
        });
        this.eq.menu.addMenuItem(this.undoPreset);
        connect(settings, 'changed::equalizer-presets', () => { if (this.state) this.render(this.state, this.sensitive); });
        this.personalization = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
        this.personalization.label.clutter_text.line_wrap = true;
        this.personalization.label.clutter_text.ellipsize = 0;
        this.sound.addMenuItem(this.personalization);
        this._choice('sidetone', this.sound, connect);

        this.device = new PopupMenu.PopupMenuSection();
        this.device.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Device settings')));
        for (const key of ['audioPriority', 'autoPowerOff', 'promptMode']) this._choice(key, this.device, connect);
        for (const key of ['touchLock', 'lowLatency']) this._switch(key, this.device, connect);
        this.name = new PopupMenu.PopupSubMenuMenuItem(_('Headset name'));
        this.nameItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this.nameEntry = new St.Entry({hint_text: _('Headset name'), can_focus: true, x_expand: true});
        this.nameItem.add_child(this.nameEntry);
        this.name.menu.addMenuItem(this.nameItem);
        this.saveName = new Action(_('Save headset name'));
        const save = () => {
            if (!this.saveName.sensitive) return;
            try { validateValue('name', this.nameEntry.text); controller.setSetting('name', this.nameEntry.text); }
            catch { this.nameEntry.add_style_class_name('error'); }
        };
        connect(this.saveName, 'triggered', save);
        connect(this.nameEntry.clutter_text, 'activate', save);
        connect(this.nameEntry.clutter_text, 'text-changed', () => this.nameEntry.remove_style_class_name('error'));
        this.name.menu.addMenuItem(this.saveName);
        this.device.addMenuItem(this.name);

        this.information = new PopupMenu.PopupMenuSection();
        this.information.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Device information')));
        this.info = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
        this.info.label.clutter_text.line_wrap = true;
        this.info.label.clutter_text.ellipsize = 0;
        this.information.addMenuItem(this.info);
    }
    _shown(state, key) { return state.inFlight?.key === key ? state.inFlight.value : state.snapshot?.[key]; }
    _switch(key, section, connect) {
        const item = new Switch(_(EXTRA_FIELDS[key].title), false);
        connect(item, 'toggled', (_item, value) => {
            if (!this.rendering && item.sensitive && value !== this._shown(this.controller.current, key))
                this.controller.setSetting(key, value);
        });
        this.switches.set(key, item);
        section.addMenuItem(item);
    }
    _choice(key, section, connect) {
        const item = new PopupMenu.PopupSubMenuMenuItem(_(EXTRA_FIELDS[key].title));
        const options = new Map();
        for (const [value, label] of CHOICES[key]) {
            const action = new Action(_(label));
            connect(action, 'triggered', () => { if (action.sensitive) this.controller.setSetting(key, value); });
            item.menu.addMenuItem(action);
            options.set(value, action);
        }
        this.choices.set(key, {item, options});
        section.addMenuItem(item);
    }
    commitPreviews() { for (const row of this.eqRows) row.commit(); }
    get focusables() {
        return [...this.switches.values(), ...[...this.choices.values()].flatMap(choice => [...choice.options.values()]),
            ...[...this.peerItems.values()].map(row => row.item), this.reconnect, this.flat, this.saveName, this.savePreset, this.removePreset, this.undoPreset,
            this.nameEntry, this.presetEntry, ...this.presetRows,
            ...this.eqRows.flatMap(row => [row.slider, row.minus, row.plus])];
    }
    render(state, sensitive) {
        this.rendering = true; this.state = state; this.sensitive = sensitive;
        try {
            const snapshot = state.snapshot;
            const extended = Boolean(snapshot?._extended);
            for (const section of [this.sound, this.device, this.information]) section.actor.visible = extended;
            this.connections.actor.visible = true;
            this.reconnect.sensitive = state.activity === 'idle' && state.availability !== 'missing';
            for (const [key, item] of this.switches) {
                const value = this._shown(state, key);
                const supported = extended && typeof value === 'boolean';
                if (supported) { item.setToggleState(value); item.setStatus(null); }
                else item.setStatus(_('Unavailable'));
                item.sensitive = Boolean(sensitive && supported); item.syncSensitive();
            }
            const connections = snapshot?._connections;
            this.peers.sensitive = Boolean(extended && snapshot && !state.snapshotStale);
            this.peers.label.text = connections ? format(_('Connections: %s/%s'),
                connections.peers.filter(peer => peer.connected).length, connections.capacity) : _('Paired devices: Unavailable');
            for (const [index, row] of this.peerItems) {
                const peer = connections?.peers[index];
                row.item.visible = Boolean(peer);
                if (!peer) continue;
                row.item.label.text = peer.name;
                const own = index === connections.ownIndex;
                const changing = state.inFlight?.key === `peer:${index}`;
                row.status.text = own ? _('This computer') : changing ? _('Updating') : peer.connected ? _('Connected · Disconnect') :
                    connections.capacity < 2 ? _('Enable multipoint first') : _('Switch to');
                row.item.sensitive = Boolean(sensitive && !own && (peer.connected || connections.capacity >= 2));
                row.item.setOrnament(peer.connected ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
            }
            this.connectionHint.label.text = snapshot?.multipoint === false ? _('Enable multipoint to connect a second source.') :
                _('Switching keeps this computer connected and replaces the other source.');
            for (const [key, choice] of this.choices) {
                const value = this._shown(state, key);
                const supported = extended && Number.isInteger(value);
                const label = CHOICES[key].find(option => option[0] === value)?.[1];
                const shown = label ? _(label) : supported ? String(value) : _('Unavailable');
                choice.item.label.text = format(_('%s: %s'), _(EXTRA_FIELDS[key].title), shown);
                choice.item.sensitive = Boolean(supported && !state.snapshotStale);
                for (const [option, action] of choice.options) {
                    action.sensitive = Boolean(sensitive && supported &&
                        !(key === 'soundMode' && option === 3 && snapshot._device.personalizationState !== 2));
                    action.setOrnament(option === value ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
                }
            }
            this.eq.sensitive = Boolean(extended && snapshot._equalizer && !state.snapshotStale);
            for (const row of this.eqRows) row.render(state, sensitive);
            this.flat.sensitive = Boolean(sensitive && snapshot?._equalizer &&
                snapshot._equalizer.minGain <= 0 && snapshot._equalizer.maxGain >= 0);
            const saved = this.settings.get_value('equalizer-presets').deep_unpack();
            this.presetNames = Object.keys(saved).sort().slice(0, 32);
            this.presets.sensitive = Boolean(snapshot?._equalizer && !state.snapshotStale && this.presetNames.length);
            this.presetRows.forEach((row, index) => {
                const name = this.presetNames[index];
                row.visible = name !== undefined;
                if (name === undefined) return;
                row.label.text = name;
                const values = saved[name];
                row.sensitive = Boolean(sensitive && snapshot?._equalizer && values.length === snapshot._equalizer.gains.length &&
                    values.every(value => Number.isInteger(value) && value >= snapshot._equalizer.minGain && value <= snapshot._equalizer.maxGain));
            });
            this.savePreset.sensitive = Boolean(sensitive && snapshot?._equalizer);
            this.presetEntry.reactive = this.savePreset.sensitive;
            this.removePreset.sensitive = Boolean(sensitive && this.selectedPreset && Object.hasOwn(saved, this.selectedPreset));
            this.removePreset.label.text = this.selectedPreset ? format(_('Remove preset: %s'), this.selectedPreset) : _('Remove selected preset');
            this.undoPreset.visible = Boolean(this.removedPreset);
            this.undoPreset.sensitive = Boolean(sensitive && this.removedPreset && !Object.hasOwn(saved, this.removedPreset[0]));
            const calibrated = snapshot?._device?.personalizationState === 2;
            this.personalization.label.text = calibrated ? _('Sound Personalization profile is available.') :
                _('Sound Personalization requires a calibrated profile from Smart Control Plus.');
            this.personalization.visible = Boolean(extended);
            this.name.sensitive = Boolean(extended && !Object.hasOwn(snapshot._unsupported, 'name') && !state.snapshotStale);
            this.saveName.sensitive = Boolean(sensitive && this.name.sensitive);
            this.nameEntry.reactive = this.saveName.sensitive;
            if (extended && !this.nameEntry.clutter_text.has_key_focus() && this.nameEntry.text !== snapshot.name)
                this.nameEntry.text = snapshot.name;
            if (extended) {
                const device = snapshot._device;
                const codec = device.codec === 255 ? _('No audio stream') : CODECS[device.codec] ?? format(_('Unknown codec %s'), device.codec);
                const language = LANGUAGES[device.promptLanguage];
                this.info.label.text = [device.name, format(_('Firmware: %s'), device.firmware),
                    format(_('Codec: %s'), codec), format(_('Voice prompt language: %s'), language ? _(language) : _('Unavailable')),
                    format(_('Bluetooth address: %s'), device.address)].join('\n');
            }
        } finally { this.rendering = false; }
    }
    destroy() { for (const row of this.eqRows) row.destroy(); }
}
