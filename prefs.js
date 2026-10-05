import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {resolveExecutable} from './lib/executableResolver.js';

export default class MomentumPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'Momentum 4 Controls', icon_name: 'audio-headphones-symbolic'});
        const group = new Adw.PreferencesGroup({title: 'Extension preferences', description: 'Headset settings are read when enabled and are never automatically restored.'});
        page.add(group);
        window.add(page);
        const path = new Adw.EntryRow({title: 'CLI executable (empty for automatic discovery)',
            text: settings.get_string('cli-path'), show_apply_button: true});
        const browse = new Gtk.Button({icon_name: 'document-open-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: 'Choose the momentumctl executable', css_classes: ['flat']});
        browse.update_property([Gtk.AccessibleProperty.LABEL], ['Choose the momentumctl executable']);
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
                status.title = configured ? 'Selected executable' : 'Automatic discovery found';
                status.subtitle = found;
            } catch (e) {
                status.title = configured ? 'Selected executable is not usable' : 'Automatic discovery found nothing';
                status.subtitle = configured ? e.message : 'Searched PATH, ~/.cargo/bin, ~/.local/bin, /usr/local/bin and /usr/bin.';
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
                status.title = 'Not applied';
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
            const dialog = new Gtk.FileDialog({title: 'Choose the momentumctl executable', modal: true});
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
        const battery = new Adw.SwitchRow({title: 'Show battery percentage in the top bar', subtitle: 'Shown only after a valid status read. When off, the headset is not polled while the menu is closed.'});
        group.add(battery);
        settings.bind('show-battery-percentage', battery, 'active', Gio.SettingsBindFlags.DEFAULT);
        const keys = new Adw.PreferencesGroup({title: 'Keyboard',
            description: 'Shortcut that opens or closes the menu, for example <Super>m. Leave empty to disable it.'});
        page.add(keys);
        const shortcut = new Adw.EntryRow({title: 'Shortcut', show_apply_button: true,
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
