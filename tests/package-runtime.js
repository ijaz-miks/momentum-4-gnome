import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {assert} from './assert.js';
const root = GLib.canonicalize_filename(ARGV[0], GLib.get_current_dir());
const source = Gio.SettingsSchemaSource.new_from_directory(`${root}/schemas`, Gio.SettingsSchemaSource.get_default(), false);
const schema = source.lookup('org.gnome.shell.extensions.momentumctl', false);
assert(schema);
assert(schema.list_keys().sort().join(',') === 'cli-path,momentum4-toggle-menu,show-battery-percentage');
const settings = new Gio.Settings({settings_schema: schema, backend: Gio.memory_settings_backend_new()});
assert(settings.get_string('cli-path') === '' && settings.get_boolean('show-battery-percentage') &&
    settings.get_strv('momentum4-toggle-menu').length === 0);
for (const name of ['commands', 'statusParser', 'executableResolver', 'cliExecutor', 'headsetController', 'scheduler', 'bluezWatcher'])
    await import(`file://${root}/lib/${name}.js`);
print('PASS packaged non-Shell runtime modules and compiled schema defaults');
