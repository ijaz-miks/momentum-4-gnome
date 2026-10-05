import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {resolveExecutable} from './lib/executableResolver.js';
import {_, setTranslator} from './lib/i18n.js';

export default class MomentumPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        setTranslator(text => this.gettext(text));
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: _('Momentum 4 Controls'), icon_name: 'audio-headphones-symbolic'});
        const group = new Adw.PreferencesGroup({title: _('Extension preferences'), description: _('Headset settings are read when enabled and are never automatically restored.')});
        page.add(group);
        window.add(page);
        const path = new Adw.EntryRow({title: _('CLI executable (empty for automatic discovery)'),
            text: settings.get_string('cli-path'), show_apply_button: true});
        const browse = new Gtk.Button({icon_name: 'document-open-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: _('Choose the momentumctl executable'), css_classes: ['flat']});
        browse.update_property([Gtk.AccessibleProperty.LABEL], [_('Choose the momentumctl executable')]);
        path.add_suffix(browse);
        group.add(path);
        const status = new Adw.ActionRow({subtitle_lines: 0, css_classes: ['property']});
        group.add(status);
        // Discovery here only checks files. This process's PATH can differ from
        // GNOME Shell's, so the Shell result can still differ.
        const describe = () => {
            const configured = settings.get_string('cli-path');
            try {
                const found = resolveExecutable(configured);
                status.title = configured ? _('Selected executable') : _('Automatic discovery found');
                status.subtitle = found;
            } catch (e) {
                status.title = configured ? _('Selected executable is not usable') : _('Automatic discovery found nothing');
                status.subtitle = configured ? e.message : _('Searched PATH, ~/.cargo/bin, ~/.local/bin, /usr/local/bin and /usr/bin.');
            }
        };
        const confirm = () => {
            try {
                if (path.text !== '') resolveExecutable(path.text);
                // Writing an unchanged value would still restart the extension's controller.
                if (path.text !== settings.get_string('cli-path')) settings.set_string('cli-path', path.text);
                path.remove_css_class('error');
                describe();
            } catch (e) {
                status.title = _('Not applied');
                status.subtitle = e.message;
                path.add_css_class('error');
            }
        };
        path.connect('apply', confirm);
        path.connect('entry-activated', confirm);
        const focus = new Gtk.EventControllerFocus();
        focus.connect('leave', () => { if (path.text !== settings.get_string('cli-path')) confirm(); });
        path.add_controller(focus);
        browse.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: _('Choose the momentumctl executable'), modal: true});
            dialog.open(window, null, (_dialog, result) => {
                let file;
                try { file = dialog.open_finish(result); } catch { return; } // Dismissed.
                const chosen = file?.get_path();
                if (!chosen) return;
                path.text = chosen;
                confirm();
            });
        });
        describe();
        const battery = new Adw.SwitchRow({title: _('Show battery percentage in the top bar'), subtitle: _('Shown only after a valid status read. When off, the headset is not polled while the menu is closed.')});
        group.add(battery);
        settings.bind('show-battery-percentage', battery, 'active', Gio.SettingsBindFlags.DEFAULT);
        const keys = new Adw.PreferencesGroup({title: _('Keyboard'),
            // Group descriptions are Pango markup; the example contains angle brackets.
            description: GLib.markup_escape_text(_('Shortcut that opens or closes the menu, for example <Super>m. Leave empty to disable it.'), -1)});
        page.add(keys);
        const shortcut = new Adw.EntryRow({title: _('Shortcut'), show_apply_button: true,
            text: settings.get_strv('momentum4-toggle-menu')[0] ?? ''});
        keys.add(shortcut);
        const applyShortcut = () => {
            const text = shortcut.text.trim();
            if (text === '') {
                settings.set_strv('momentum4-toggle-menu', []);
                shortcut.remove_css_class('error');
                return;
            }
            const [ok, key, mods] = Gtk.accelerator_parse(text);
            if (!ok || !key) { shortcut.add_css_class('error'); return; }
            const name = Gtk.accelerator_name(key, mods);
            settings.set_strv('momentum4-toggle-menu', [name]);
            shortcut.text = name;
            shortcut.remove_css_class('error');
        };
        shortcut.connect('apply', applyShortcut);
        shortcut.connect('entry-activated', applyShortcut);
        // No controller, subprocess or headset query exists in this process.
    }
}
