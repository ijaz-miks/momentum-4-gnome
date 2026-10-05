import GLib from 'gi://GLib';
import {_} from './i18n.js';

function executable(path) {
    return GLib.file_test(path, GLib.FileTest.IS_REGULAR) &&
        GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE);
}

export function resolveExecutable(configuredPath = '', env = {}) {
    const home = env.home ?? GLib.get_home_dir();
    const find = env.find ?? GLib.find_program_in_path;
    if (configuredPath !== '') {
        if (!GLib.path_is_absolute(configuredPath) || !executable(configuredPath))
            throw new Error(_('The selected momentumctl executable cannot be started. Use an absolute executable filename.'));
        return GLib.canonicalize_filename(configuredPath, null);
    }
    const found = find('momentumctl');
    const paths = [found, `${home}/.cargo/bin/momentumctl`, `${home}/.local/bin/momentumctl`,
        '/usr/local/bin/momentumctl', '/usr/bin/momentumctl'];
    for (const path of paths) {
        if (path && executable(path))
            return GLib.canonicalize_filename(path, GLib.get_current_dir());
    }
    throw new Error(_('momentumctl was not found. Select its executable in Preferences.'));
}
