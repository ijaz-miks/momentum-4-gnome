import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';
import {_, format} from '../lib/i18n.js';

export class TransparencyRow {
    constructor(controller, connect) {
        this.controller = controller;
        this.rendering = false;
        this.dragging = false;
        this.value = null;
        this.heading = new PopupMenu.PopupMenuItem(_('Transparency: Unavailable'), {reactive: false, can_focus: false});
        this.item = new PopupMenu.PopupBaseMenuItem({activate: false, can_focus: false});
        this.minus = new St.Button({label: '−', style_class: 'button', can_focus: true, accessible_name: _('Decrease transparency by 10 percentage points')});
        this.slider = new Slider.Slider(0);
        this.slider.accessible_name = _('Transparency percentage');
        this.plus = new St.Button({label: '+', style_class: 'button', can_focus: true, accessible_name: _('Increase transparency by 10 percentage points')});
        for (const actor of [this.minus, this.slider, this.plus]) this.item.add_child(actor);
        connect(this.minus, 'clicked', () => this.step(-10));
        connect(this.plus, 'clicked', () => this.step(10));
        connect(this.slider, 'drag-begin', () => { this.dragging = true; controller.beginDrag(); });
        connect(this.slider, 'drag-end', () => { this.dragging = false; controller.endDrag(); });
        connect(this.slider, 'notify::value', () => {
            const value = Math.round(this.slider.value * 100);
            const expected = controller.current.preview ?? controller.current.snapshot?.transparency;
            if (!this.rendering && this.slider.reactive && value !== expected)
                controller.previewTransparency(value, this.dragging);
        });
    }
    step(delta) {
        if (this.value !== null && this.slider.reactive)
            this.controller.previewTransparency(Math.max(0, Math.min(100, this.value + delta)));
    }
    render(state, sensitive) {
        this.rendering = true;
        try {
            this.value = state.preview ?? state.snapshot?.transparency ?? null;
            this.heading.label.text = this.value === null ? _('Transparency: Unavailable') : format(_('Transparency: %s'), `${this.value}%`);
            if (this.value !== null) this.slider.value = this.value / 100;
            this.slider.visible = this.value !== null;
            for (const actor of [this.minus, this.slider, this.plus]) {
                actor.reactive = sensitive;
                actor.can_focus = sensitive;
                actor.opacity = sensitive ? 255 : 128;
            }
            this.item.sensitive = sensitive;
            this.item.can_focus = false;
        } finally { this.rendering = false; }
    }
}
