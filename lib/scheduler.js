import GLib from 'gi://GLib';

export const scheduler = {
    now: () => GLib.get_monotonic_time() / 1000,
    after(ms, callback) {
        return GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            callback();
            return GLib.SOURCE_REMOVE;
        });
    },
    cancel: id => GLib.Source.remove(id),
};
