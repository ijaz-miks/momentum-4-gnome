import GLib from 'gi://GLib';
import {CliExecutor} from '../lib/cliExecutor.js';
import {resolveExecutable} from '../lib/executableResolver.js';
import {parseStatus} from '../lib/statusParser.js';
import {diagnostic} from '../lib/headsetController.js';

// Explicit read-only entry point. Not part of automated check.sh or the bundle.
const loop = new GLib.MainLoop(null, false);
const executor = new CliExecutor();
async function read() {
    const path = resolveExecutable(ARGV[0] ?? '');
    const result = await executor.run([path, 'status']);
    const report = {executable: path, operation: 'status', elapsedMs: Math.round(result.elapsedMs),
        exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut,
        error: diagnostic(result.error || result.stderr)};
    if (result.exitCode === 0 && !result.error && !result.timedOut)
        report.snapshot = parseStatus(result.stdout);
    print(JSON.stringify(report, null, 2));
}
read().catch(e => printerr(diagnostic(e.message))).finally(() => loop.quit());
loop.run();
