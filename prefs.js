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
        const path = new Adw.EntryRow({title: 'CLI executable (empty for automatic discovery)', text: settings.get_string('cli-path')});
        const apply = new Gtk.Button({label: 'Apply', valign: Gtk.Align.CENTER, tooltip_text: 'Validate and apply the executable path'});
        path.add_suffix(apply);
        group.add(path);
        const status = new Adw.ActionRow({title: 'Uses momentumctl from PATH, Cargo or standard local directories.'});
        status.title_lines = 0;
        group.add(status);
        const confirm = () => {
            try {
                if (path.text !== '') resolveExecutable(path.text);
                settings.set_string('cli-path', path.text);
                status.title = path.text ? 'Executable path saved.' : 'Automatic discovery selected.';
                path.remove_css_class('error');
            } catch (e) { status.title = e.message; path.add_css_class('error'); }
        };
        apply.connect('clicked', confirm);
        path.connect('entry-activated', confirm);
        const focus = new Gtk.EventControllerFocus();
        focus.connect('leave', () => { if (path.text !== settings.get_string('cli-path')) confirm(); });
        path.add_controller(focus);
        const battery = new Adw.SwitchRow({title: 'Show battery percentage in the top bar', subtitle: 'Shown only after a valid status read. When off, the headset is not polled while the menu is closed.'});
        group.add(battery);
        settings.bind('show-battery-percentage', battery, 'active', Gio.SettingsBindFlags.DEFAULT);
        // No controller, subprocess or headset query exists in this process.
    }
}
