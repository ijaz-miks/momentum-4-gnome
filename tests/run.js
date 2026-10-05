import GLib from 'gi://GLib';

const loop = new GLib.MainLoop(null, false);
let failed = false;
async function main() {
    const suites = ARGV.length ? ARGV : ['parser', 'commands', 'i18n', 'controller', 'executor'];
    for (const suite of suites) {
        await (await import(`./${suite}.test.js`)).run();
        print(`PASS ${suite}`);
    }
}
main().catch(e => { failed = true; printerr(e.stack); }).finally(() => loop.quit());
loop.run();
if (failed)
    throw new Error('Tests failed');
