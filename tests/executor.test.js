import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {CliExecutor} from '../lib/cliExecutor.js';
import {resolveExecutable} from '../lib/executableResolver.js';
import {HeadsetController} from '../lib/headsetController.js';
import {scheduler} from '../lib/scheduler.js';
import {parseStatus} from '../lib/statusParser.js';
import {assert, equal, throws} from './assert.js';

const sleep = ms => new Promise(resolve => scheduler.after(ms, resolve));
export async function run() {
    const dir = GLib.dir_make_tmp('momentumctl-executor-XXXXXX');
    print(`Retained subprocess test files: ${dir}`);
    const source = `${GLib.get_current_dir()}/tests/mock-momentumctl.py`;
    const mock = `${dir}/mock CLI with spaces`;
    Gio.File.new_for_path(source).copy(Gio.File.new_for_path(mock), Gio.FileCopyFlags.NONE, null, null);
    Gio.File.new_for_path(mock).set_attribute_uint32('unix::mode', 0o755, Gio.FileQueryInfoFlags.NONE, null);
    equal(resolveExecutable(mock), mock);
    throws(() => resolveExecutable('relative'));
    throws(() => resolveExecutable(`${dir}/missing`));
    throws(() => resolveExecutable(dir));
    const cargo = `${dir}/.cargo/bin`;
    GLib.mkdir_with_parents(cargo, 0o700);
    Gio.File.new_for_path(mock).copy(Gio.File.new_for_path(`${cargo}/momentumctl`), Gio.FileCopyFlags.NONE, null, null);
    equal(resolveExecutable('', {home: dir, find: () => null}), `${cargo}/momentumctl`);
    let sequence = 0;
    const run = async (mode, options = {}) => {
        const executor = new CliExecutor({deadlineMs: 350, environment: {MOMENTUMCTL_MOCK_DIR: dir, MOMENTUMCTL_MOCK_MODE: mode}, ...options});
        const promise = executor.run([mock, 'status']);
        sequence++;
        const child = executor.active?.process;
        const pid = executor.active?.process.get_identifier();
        if (options.cancel) {
            await sleep(25); executor.cancel();
            let busy = false;
            try { await executor.run([mock, 'status']); } catch { busy = true; }
            assert(busy, 'Cancelled slot released before reap');
        }
        const result = await promise;
        assert(!child || (child.get_stdout_pipe().is_closed() && child.get_stderr_pipe().is_closed()), 'CLI pipe descriptors leaked');
        assert(!executor.active && (!pid || !GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS)), `Orphan process in ${mode}`);
        return result;
    };
    assert(parseStatus((await run('stateful')).stdout).battery === 82);
    equal((await run('locale')).stdout.trim(), 'C');
    GLib.setenv('RUST_LOG', 'trace', true);
    equal((await run('rust-log')).stdout.trim(), 'missing', 'RUST_LOG reached the CLI');
    GLib.unsetenv('RUST_LOG');
    const error = await run('error'); assert(error.exitCode === 7 && error.stderr.includes('protocol failure'));
    assert((await run('unavailable')).exitCode === 1);
    assert((await run('invalid-utf8')).error);
    assert((await run('overflow')).error);
    assert((await run('delay')).exitCode === 0);
    const timeout = await run('hang'); assert(timeout.timedOut && timeout.signal === 9 && timeout.elapsedMs < 2000);
    assert((await run('signal')).signal === 15);
    assert((await run('hang', {cancel: true})).cancelled);
    const missing = await new CliExecutor().run([`${dir}/absent`, 'status']); assert(missing.error);

    // Real stateful controller transactions and immediate restart share a reap barrier.
    const executor = new CliExecutor({deadlineMs: 1000, environment: {MOMENTUMCTL_MOCK_DIR: dir}});
    const create = () => new HeadsetController({executor, scheduler, resolve: () => mock});
    const c = create(); await c.start();
    equal(await c.setSetting('transparency', 53), {status: 'confirmed'});
    assert(c.current.snapshot.transparency === 53);
    GLib.file_set_contents(`${dir}/mode`, 'hang');
    c.refresh(); await sleep(40);
    const drained = c.stop();
    const replacement = create();
    GLib.file_set_contents(`${dir}/mode`, 'stateful');
    await drained; await replacement.start(); assert(replacement.ready); await replacement.stop();

    const [, bytes] = GLib.file_get_contents(`${dir}/events.jsonl`);
    const events = new TextDecoder().decode(bytes).trim().split('\n').map(JSON.parse);
    // At each later launch, earlier PIDs have either logged exit or were confirmed reaped above.
    const active = new Map();
    for (const ev of events) {
        if (ev.phase === 'exit') active.delete(ev.pid);
        else {
            for (const pid of active.keys())
                assert(!GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS), 'Real mock children overlap');
            active.set(ev.pid, ev.time);
            assert(ev.locale === 'C');
            equal(ev.overlap, [], 'PIDs alive at actual launch');
        }
    }
    assert(sequence === 11);
}
