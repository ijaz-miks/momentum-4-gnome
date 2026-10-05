import {HeadsetController} from '../lib/headsetController.js';
import {assert, equal} from './assert.js';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
class Clock {
    constructor() { this.time = 0; this.next = 0; this.tasks = new Map(); }
    now() { return this.time; }
    after(ms, fn) { const id = ++this.next; this.tasks.set(id, {at: this.time + ms, fn}); return id; }
    cancel(id) { assert(this.tasks.delete(id), 'Timer removed twice'); }
    async tick(ms) {
        this.time += ms;
        for (const [id, task] of [...this.tasks]) {
            if (task.at <= this.time) { this.tasks.delete(id); task.fn(); }
        }
        await flush();
    }
    delays() { return [...this.tasks.values()].map(t => t.at - this.time); }
}
class FakeExecutor {
    constructor() { this.calls = []; this.pending = null; this.max = 0; this.values = {anc: true, transparency: 35}; }
    run(argv) {
        assert(!this.pending, 'Concurrent child');
        this.max = Math.max(this.max, 1);
        this.calls.push(argv.slice(1));
        return new Promise(resolve => { this.pending = {resolve, argv}; });
    }
    reply(options = {}) {
        assert(this.pending, 'No active child');
        const {resolve, argv} = this.pending;
        this.pending = null;
        if (argv[1] === 'set' && !options.fail && !options.mismatch)
            this.values[argv[2]] = argv[2] === 'transparency' ? Number(argv[3]) : argv[3] === 'on';
        const text = `Adaptive: off\nANC: ${this.values.anc ? 'on' : 'off'}\nAnti-wind: auto\nAuto-answer: off\nBattery: 82%\nComfort call: off\nOn-head detection: on\nSmart pause: on\nTransparency: ${this.values.transparency}%\n`;
        resolve({exitCode: options.fail ? 1 : 0, stdout: options.text ?? text,
            stderr: options.fail ? 'no device found' : '', ...options});
    }
    cancel() { if (this.pending) this.reply({cancelled: true, fail: true}); }
}
async function setup() {
    const scheduler = new Clock();
    const executor = new FakeExecutor();
    const c = new HeadsetController({scheduler, executor, resolve: p => p || '/mock'});
    c.start(); await flush(); executor.reply(); await flush();
    assert(c.ready);
    return {c, scheduler, executor};
}
export async function run() {
    // Accepted preview survives a refresh and only the last integer is sent.
    {
        const {c, scheduler: t, executor: e} = await setup();
        c.previewTransparency(41); c.refresh(); await flush();
        c.previewTransparency(47); await t.tick(350);
        assert(c.current.preview === 47);
        e.reply(); await flush();
        equal(e.calls, [['status'], ['status'], ['set', 'transparency', '47']]);
        c.refresh(); c.refresh(); e.reply(); await flush();
        assert(c.current.activity === 'settling');
        await t.tick(499); assert(!e.pending);
        await t.tick(1); equal(e.calls.at(-1), ['status']);
        c.refresh(); c.refresh(); e.reply(); await flush();
        assert(c.current.snapshot.transparency === 47);
        equal(e.calls.at(-1), ['status']); e.reply(); await flush();
        assert(e.calls.length === 5 && c.current.preview === null);
        await c.stop(); assert(t.tasks.size === 0);
    }
    // Coalescing settles superseded requests, preserves setting order, drops no-ops.
    {
        const {c, scheduler: t, executor: e} = await setup();
        c.refresh(); await flush();
        const old = c.setSetting('transparency', 40);
        const last = c.setSetting('transparency', 50);
        const same = c.setSetting('anc', true);
        equal(await old, {status: 'superseded'});
        e.reply(); await flush(); e.reply(); await flush();
        await t.tick(500); e.reply(); await flush();
        equal(await last, {status: 'confirmed'}); equal(await same, {status: 'unchanged'});
        assert(e.calls.filter(a => a[0] === 'set').length === 1);
        await c.stop();
    }
    // Uncertain write is reconciled once and its error remains after later reads.
    {
        const {c, scheduler: t, executor: e} = await setup();
        const job = c.setSetting('anc', false); await flush();
        const queued = c.setSetting('transparency', 20);
        e.reply({fail: true, timedOut: true}); await flush();
        equal(await queued, {status: 'cancelled'});
        await t.tick(500); e.reply(); await flush();
        equal(await job, {status: 'failed'});
        assert(c.ready && c.current.writeError.code === 'timeout');
        c.refresh(); await flush(); e.reply(); await flush();
        assert(c.current.writeError.code === 'timeout');
        await c.stop();
    }
    // The in-flight write is visible for display and cleared once verified or failed.
    for (const fail of [false, true]) {
        const {c, scheduler: t, executor: e} = await setup();
        const job = c.setSetting('anc', false); await flush();
        equal(c.current.inFlight, {key: 'anc', value: false});
        assert(c.current.snapshot.anc === true, 'In-flight value leaked into the snapshot');
        e.reply({fail}); await flush();
        if (fail) assert(c.current.inFlight === null);
        await t.tick(500); e.reply(); await flush(); await job;
        assert(c.current.inFlight === null && c.current.activity === 'idle');
        assert(c.current.snapshot.anc === fail);
        await c.stop();
    }
    {
        const {c, executor: e} = await setup();
        c.setSetting('anc', false); await flush();
        const stopped = c.stop(); assert(c.current.inFlight === null); e.cancel(); await stopped;
    }
    for (const kind of ['mismatch', 'bad-verification']) {
        const {c, scheduler: t, executor: e} = await setup();
        c.setSetting('anc', false); await flush(); e.reply({mismatch: kind === 'mismatch'}); await flush();
        await t.tick(500); e.reply(kind === 'bad-verification' ? {text: 'Battery: 82%'} : {}); await flush();
        assert(c.current.writeError.code === (kind === 'mismatch' ? 'mismatch' : 'unconfirmed'));
        assert(c.current.snapshot.anc === true);
        if (kind === 'bad-verification') assert(c.current.snapshotStale && !c.ready);
        await c.stop();
    }
    // Backoff, atomic state retention and recovery.
    {
        const {c, scheduler: t, executor: e} = await setup();
        const snapshot = c.current.snapshot;
        for (const delay of [30000, 60000, 120000, 300000, 300000]) {
            c.refresh(); await flush(); e.reply({fail: true}); await flush();
            equal(t.delays(), [delay]);
            assert(c.current.snapshot === snapshot && c.current.snapshotStale);
        }
        c.refresh(); await flush(); e.reply(); await flush(); equal(t.delays(), [120000]);
        c.setMenuOpen(true); equal(t.delays(), [30000]);
        c.previewTransparency(60, true); await t.tick(30000); assert(!e.pending);
        c.setMenuOpen(false); await flush(); equal(e.calls.at(-1), ['set', 'transparency', '60']);
        await c.stop(); assert(t.tasks.size === 0);
    }
    // Without panel battery text, nothing polls while the menu is closed.
    {
        const t = new Clock(); const e = new FakeExecutor();
        const c = new HeadsetController({scheduler: t, executor: e, resolve: () => '/mock', pollWhileClosed: false});
        c.start(); await flush(); e.reply(); await flush();
        assert(c.ready && t.tasks.size === 0);
        c.refresh(); await flush(); e.reply({fail: true}); await flush();
        assert(t.tasks.size === 0, 'Closed-menu backoff poll without battery text');
        c.setMenuOpen(true); await flush(); e.reply(); await flush(); equal(t.delays(), [30000]);
        c.setMenuOpen(false); assert(t.tasks.size === 0);
        const calls = e.calls.length;
        c.setPollWhileClosed(true); equal(t.delays(), [120000]);
        assert(e.calls.length === calls && !e.pending, 'Preference change launched a command');
        await c.stop();
    }
    // BlueZ link evidence: disconnect stops polling, reconnect reads after settling.
    {
        const {c, scheduler: t, executor: e} = await setup();
        c.setLinkState('connected');
        equal(t.delays(), [120000]);
        c.setLinkState('disconnected');
        assert(!c.ready && c.current.connection === 'unavailable' && t.tasks.size === 0 && !e.pending);
        await t.tick(600000); assert(!e.pending, 'Polled while BlueZ reports no headset');
        c.setLinkState('connected'); equal(t.delays(), [1500]);
        await t.tick(1500); equal(e.calls.at(-1), ['status']); e.reply(); await flush();
        assert(c.ready); equal(t.delays(), [120000]);
        // A disconnect during a read lets that read fail by itself, then waits.
        c.refresh(); await flush(); c.setLinkState('disconnected');
        e.reply({fail: true}); await flush();
        assert(!c.ready && t.tasks.size === 0);
        await c.stop();
    }
    // Stop during every phase, including pending debounce, and sleep/wake.
    {
        const {c, scheduler: t, executor: e} = await setup();
        c.beginDrag(); await t.tick(120000);
        assert(!e.pending && t.tasks.size === 0, 'Poll began during unchanged pointer drag');
        c.endDrag(); equal(t.delays(), [120000]);
        await c.stop();
    }
    for (const phase of ['refreshing', 'writing', 'settling', 'verifying', 'preview']) {
        const {c, scheduler: t, executor: e} = await setup();
        if (phase === 'refreshing') c.refresh();
        else if (phase === 'preview') c.previewTransparency(66);
        else c.setSetting('anc', false);
        await flush();
        if (['settling', 'verifying'].includes(phase)) { e.reply(); await flush(); }
        if (phase === 'verifying') await t.tick(500);
        let notifications = 0;
        c.subscribe(() => notifications++);
        await c.stop(); const count = notifications;
        await t.tick(500000);
        assert(!e.pending && t.tasks.size === 0 && notifications === count);
        await c.stop();
    }
    {
        const {c, scheduler: t, executor: e} = await setup();
        c.refresh(); await flush(); await c.pause();
        assert(!c.ready && t.tasks.size === 0);
        const wake = c.resume(); await flush(); e.reply(); await wake;
        assert(c.ready); await c.stop();
    }
    {
        const t = new Clock(); const e = new FakeExecutor();
        const c = new HeadsetController({scheduler: t, executor: e, resolve: () => { throw new Error('missing'); }});
        await c.start(); assert(c.current.availability === 'missing' && t.tasks.size === 0 && e.calls.length === 0);
        await c.stop();
    }
}
