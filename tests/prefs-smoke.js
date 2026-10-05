import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

// Register the same resource environment used by the separate preferences app.
imports.package.init({name: 'gnome-shell', prefix: '/usr', libdir: '/usr/lib'});
Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource')._register();
Gio.Resource.load('/usr/share/gnome-shell/gnome-shell-dbus-interfaces.gresource')._register();
Adw.init();
const root = GLib.getenv('XDG_DATA_HOME') + '/gnome-shell/extensions/momentum4@ijaz-miks.github.io';
const [, bytes] = GLib.file_get_contents(`${root}/metadata.json`);
const metadata = {...JSON.parse(new TextDecoder().decode(bytes)), path: root, dir: Gio.File.new_for_path(root)};
const Prefs = (await import(`file://${root}/prefs.js`)).default;
const prefs = new Prefs(metadata);
const window = new Adw.PreferencesWindow({title: 'Momentum test preferences'});
prefs.fillPreferencesWindow(window);
window.present();
const loop = new GLib.MainLoop(null, false);
const widgets = [];
function walk(widget) {
    widgets.push(widget);
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) walk(child);
}
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
    try {
        walk(window);
        const entry = widgets.find(w => w instanceof Adw.EntryRow);
        const battery = widgets.find(w => w instanceof Adw.SwitchRow);
        if (!entry || !battery) throw new Error('Missing preference rows');
        const settings = prefs.getSettings();
        const path = settings.get_string('cli-path');
        if (!entry.show_apply_button) throw new Error('Path row has no apply button');
        if (!widgets.some(w => w instanceof Gtk.Button && w.icon_name === 'document-open-symbolic')) throw new Error('Missing file chooser button');
        const discovery = widgets.find(w => w instanceof Adw.ActionRow && w.subtitle === path);
        if (!discovery) throw new Error('Selected executable is not shown');
        entry.text = 'relative invalid path';
        entry.emit('entry-activated');
        if (settings.get_string('cli-path') !== path) throw new Error('Invalid path was applied');
        entry.text = path;
        entry.emit('entry-activated');
        battery.active = !battery.active;
        if (settings.get_boolean('show-battery-percentage') !== battery.active) throw new Error('Preference binding failed');
        battery.active = !battery.active;
        GLib.file_set_contents(`${GLib.getenv('MOMENTUMCTL_TEST_OUTPUT')}/prefs-result.json`, JSON.stringify({passed: true, checks: ['GTK4/libadwaita packaged preferences window', 'Invalid path rejected on confirmation', 'Apply button, file chooser and resolved path shown', 'GSettings battery binding']}));
    } catch (e) {
        GLib.file_set_contents(`${GLib.getenv('MOMENTUMCTL_TEST_OUTPUT')}/prefs-result.json`, JSON.stringify({passed: false, error: e.message}));
    } finally { window.destroy(); loop.quit(); }
    return GLib.SOURCE_REMOVE;
});
loop.run();
