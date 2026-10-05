import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const COMMAND_DEADLINE_MS = 10_000;
export const STREAM_LIMIT_BYTES = 64 * 1024;

function wait(process) {
    return new Promise((resolve, reject) => process.wait_async(null, (p, result) => {
        try { p.wait_finish(result); resolve(); } catch (e) { reject(e); }
    }));
}

function close(stream) {
    return new Promise(resolve => stream.close_async(GLib.PRIORITY_DEFAULT, null, (s, result) => {
        try { s.close_finish(result); } catch { /* The child was already reaped. */ }
        resolve();
    }));
}

async function collect(stream, cancellable, overflow) {
    const chunks = [];
    let size = 0;
    while (true) {
        const bytes = await new Promise((resolve, reject) => {
            stream.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, cancellable, (s, result) => {
                try { resolve(s.read_bytes_finish(result).get_data()); } catch (e) { reject(e); }
            });
        });
        if (!bytes.length)
            break;
        size += bytes.length;
        if (size > STREAM_LIMIT_BYTES) {
            overflow();
            throw new Error('CLI output exceeded 64 KiB per stream');
        }
        chunks.push(bytes);
    }
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.length;
    }
    return new TextDecoder('utf-8', {fatal: true}).decode(joined);
}

/** One owned child. Completion always follows wait_finish, including cancellation. */
export class CliExecutor {
    constructor({deadlineMs = COMMAND_DEADLINE_MS, environment = {}, logFailure = null} = {}) {
        this.deadlineMs = deadlineMs;
        this.environment = environment;
        this.logFailure = logFailure;
        this.active = null;
        this.sequence = 0;
    }

    cancel() {
        this.active?.terminate('cancelled');
    }

    _result(result) {
        const frozen = Object.freeze(result);
        if (!result.cancelled && !/no device found/i.test(result.stderr) &&
            (result.error || result.timedOut || result.signal || result.exitCode !== 0))
            this.logFailure?.(frozen);
        return frozen;
    }

    async run(argv) {
        if (this.active)
            throw new Error('A CLI child is still active');
        if (!Array.isArray(argv) || !argv.length || !GLib.path_is_absolute(argv[0]) ||
            argv.some(a => typeof a !== 'string'))
            throw new TypeError('An absolute executable and string argv are required');
        const started = GLib.get_monotonic_time();
        const result = {operationId: ++this.sequence, exitCode: null, signal: null,
            stdout: '', stderr: '', timedOut: false, cancelled: false, error: null, elapsedMs: 0};
        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE});
        for (const [key, value] of Object.entries(this.environment))
            launcher.setenv(key, value, true);
        launcher.setenv('LC_ALL', 'C', true);
        let process;
        try { process = launcher.spawnv(argv); } catch (e) {
            result.error = e.message;
            result.elapsedMs = (GLib.get_monotonic_time() - started) / 1000;
            return this._result(result);
        }
        const cancellable = new Gio.Cancellable();
        const operation = {
            process,
            terminate: reason => {
                if (reason === 'timeout') result.timedOut = true;
                if (reason === 'cancelled') result.cancelled = true;
                process.force_exit();
                // Kill the child first, then interrupt streams. wait has no cancellable.
                cancellable.cancel();
            },
        };
        this.active = operation;
        let timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this.deadlineMs, () => {
            timer = 0;
            operation.terminate('timeout');
            return GLib.SOURCE_REMOVE;
        });
        const stdoutPipe = process.get_stdout_pipe();
        const stderrPipe = process.get_stderr_pipe();
        const read = stream => collect(stream, cancellable, () => operation.terminate('overflow'))
            .catch(e => {
                if (!result.cancelled && !result.timedOut) {
                    result.error ??= e.message;
                    operation.terminate('stream-error');
                }
                return '';
            });
        try {
            const [stdout, stderr] = await Promise.all([read(stdoutPipe), read(stderrPipe), wait(process)]);
            result.stdout = stdout;
            result.stderr = stderr;
            if (process.get_if_exited()) result.exitCode = process.get_exit_status();
            else if (process.get_if_signaled()) result.signal = process.get_term_sig();
        } finally {
            if (timer) GLib.Source.remove(timer);
            await Promise.all([close(stdoutPipe), close(stderrPipe)]);
            this.active = null;
        }
        result.elapsedMs = (GLib.get_monotonic_time() - started) / 1000;
        return this._result(result);
    }
}
