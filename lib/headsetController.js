import {buildSetArgs, buildConnectionArgs, CONTROL_FIELDS as FIELDS} from './commands.js';
import {_, format} from './i18n.js';
import {parseStatus} from './statusParser.js';
import {parseInspection} from './inspectionParser.js';

const SETTLE_MS = 500;
const DEBOUNCE_MS = 350;
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000];
// The GAIA profile can lag the Bluetooth link coming up.
const LINK_SETTLE_MS = 1500;
const succeeded = r => r.exitCode === 0 && !r.error && !r.timedOut && !r.cancelled;
export function diagnostic(text) {
    return String(text ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220);
}
function commandError(r) {
    if (r.timedOut) return {code: 'timeout', message: _('The headset did not respond in time')};
    if (/no device found/i.test(r.stderr)) return {code: 'unavailable', message: _('Headset unavailable. Connect it in Bluetooth Settings, then refresh.')};
    return {code: 'communication', message: _('Could not communicate with the headset'), detail: diagnostic(r.error || r.stderr || `Exit ${r.exitCode}, signal ${r.signal}`)};
}

/** No GI or Shell dependencies. scheduler, executor and resolver are injectable. */
export class HeadsetController {
    constructor({executor, scheduler, resolve, cliPath = '', pollWhileClosed = true, onWake = null, extended = false, headsetAddress = ''}) {
        this.executor = executor;
        this.scheduler = scheduler;
        this.resolve = resolve;
        this.cliPath = cliPath;
        this.extended = extended;
        if (headsetAddress && !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(headsetAddress))
            throw new TypeError('Invalid headset Bluetooth address');
        this.headsetAddress = headsetAddress;
        // Closed-menu polls only keep the panel battery text current.
        this.pollWhileClosed = pollWhileClosed;
        this.onWake = onWake;
        this.sleepPaused = false;
        this.path = null;
        this.listeners = new Set();
        this.pending = new Map();
        this.timers = new Map();
        this.generation = 0;
        this.disposed = false;
        this.paused = false;
        this.open = false;
        this.dragging = false;
        this.failures = 0;
        this.refreshRequested = false;
        this.pumping = null;
        // BlueZ evidence: 'connected', 'disconnected' or 'unknown' (no watcher or no BlueZ).
        this.link = 'unknown';
        this.state = {availability: 'checking', connection: 'unknown', activity: 'idle', snapshot: null,
            snapshotStale: true, lastSuccessAt: null, readError: null, writeError: null, preview: null,
            // The write currently being sent and verified. Display only; never confirmed state.
            inFlight: null};
    }
    get current() { return Object.freeze({...this.state}); }
    get ready() { return this.state.connection === 'ready' && !this.state.snapshotStale && !this.paused && !this.disposed; }
    subscribe(callback) {
        this.listeners.add(callback);
        callback(this.current);
        return () => this.listeners.delete(callback);
    }
    _emit(patch = {}) {
        Object.assign(this.state, patch);
        for (const callback of this.listeners) callback(this.current);
    }
    _clearTimer(name) {
        const timer = this.timers.get(name);
        if (timer !== undefined) { this.scheduler.cancel(timer); this.timers.delete(name); }
    }
    _timer(name, ms, callback) {
        this._clearTimer(name);
        const gen = this.generation;
        this.timers.set(name, this.scheduler.after(ms, () => {
            this.timers.delete(name);
            if (!this.disposed && !this.paused && gen === this.generation) callback();
        }));
    }
    _clearIntent(reason) {
        this._clearTimer('debounce');
        this.dragging = false;
        this.state.preview = null;
        for (const job of this.pending.values()) job.finish({status: reason});
        this.pending.clear();
    }
    start() { return this.refresh('enable'); }
    refresh(reason = 'manual') {
        // Someone using the menu proves the system is awake, even if the logind
        // wake signal was missed. Only sleep pauses recover this way; a pause
        // waiting for an earlier lifecycle's child must not.
        if (this.sleepPaused && !this.disposed && (reason === 'manual' || reason === 'open')) {
            this.onWake?.();
            return this.resume();
        }
        if (this.disposed || this.paused) return Promise.resolve();
        this._clearTimer('poll');
        this.refreshRequested = true;
        return this._pump();
    }
    setMenuOpen(open) {
        this.open = open;
        if (!open) this.commitPreview();
        if (open && (this.state.lastSuccessAt === null || this.scheduler.now() - this.state.lastSuccessAt >= 2000 || !this.ready))
            this.refresh('open');
        else if (!this.pumping) this._schedulePoll();
    }
    setPollWhileClosed(enabled) {
        this.pollWhileClosed = enabled;
        // Reschedule only; a preference change never launches a command itself.
        if (!this.pumping) this._schedulePoll();
    }
    setLinkState(link) {
        const previous = this.link;
        this.link = link;
        if (this.disposed || this.paused || link === previous) return;
        if (link === 'connected' && !this.ready) {
            this.failures = 0;
            this._clearTimer('poll');
            this._timer('link', LINK_SETTLE_MS, () => this.refresh('link'));
        } else if (link === 'disconnected') {
            this._clearTimer('link');
            this._clearTimer('poll');
            // A running command fails on its own; otherwise reflect the evidence now.
            if (!this.pumping && this.state.availability === 'available')
                this._readFailure({code: 'unavailable', message: _('Headset disconnected. Connect it in Bluetooth Settings.')});
        }
    }
    previewTransparency(value, dragging = false) {
        buildSetArgs('transparency', value);
        if (!this.ready) return;
        this.dragging = dragging;
        this._clearTimer('poll');
        this._emit({preview: value});
        this._clearTimer('debounce');
        if (!dragging) this._timer('debounce', DEBOUNCE_MS, () => this.commitPreview());
    }
    beginDrag() {
        if (!this.ready) return;
        this.dragging = true;
        this._clearTimer('poll');
    }
    endDrag() {
        this.dragging = false;
        this.commitPreview();
        if (!this.pumping && !this.pending.size) this._schedulePoll();
    }
    commitPreview() {
        this._clearTimer('debounce');
        this.dragging = false;
        const value = this.state.preview;
        if (value === null) return;
        if (!this.ready) { this._emit({preview: null}); return; }
        this.setSetting('transparency', value);
    }
    setSetting(key, value) {
        buildSetArgs(key, value);
        if (!this.ready) return Promise.resolve({status: 'unavailable'});
        this._clearTimer('poll');
        const promise = new Promise(finish => {
            this.pending.get(key)?.finish({status: 'superseded'});
            this.pending.set(key, {key, value, finish});
        });
        this._emit({writeError: null});
        this._pump();
        return promise;
    }
    setConnection(index, action) {
        if (!this.ready || !this.state.snapshot?._extended)
            return Promise.resolve({status: 'unavailable'});
        const connections = this.state.snapshot._connections;
        const peer = connections.peers.find(value => value.index === index);
        if (!peer || index === connections.ownIndex)
            throw new TypeError('This computer cannot be switched or disconnected here');
        const args = buildConnectionArgs(action, peer);
        if (action !== 'disconnect' && connections.capacity < 2)
            return Promise.resolve({status: 'unavailable'});
        const value = action !== 'disconnect';
        return this._queueAction({key: `peer:${index}`, value, args, title: peer.name, kind: 'peer', deadlineMs: 75_000,
            unchanged: snapshot => snapshot?._connections?.peers.find(p => p.index === index && p.name === peer.name)?.connected === value,
            verify: snapshot => snapshot?._connections?.peers.find(p => p.index === index && p.name === peer.name)?.connected === value &&
                snapshot._connections.peers[snapshot._connections.ownIndex].connected});
    }
    applyEqPreset(gains) {
        if (!this.ready || !this.state.snapshot?._equalizer) return Promise.resolve({status: 'unavailable'});
        const eq = this.state.snapshot._equalizer;
        if (!Array.isArray(gains) || gains.length !== eq.gains.length ||
            gains.some(gain => !Number.isInteger(gain) || gain < eq.minGain || gain > eq.maxGain))
            throw new TypeError('EQ preset does not match headset limits');
        const target = [...gains];
        return this._queueAction({key: 'eqPreset', value: target, kind: 'preset', deadlineMs: 75_000,
            args: ['set', 'eq-preset', ...target.map(gain => (gain / 10).toFixed(1))],
            title: _('Equalizer preset'),
            unchanged: snapshot => snapshot?.soundMode === 1 &&
                snapshot._equalizer.gains.every((gain, band) => gain === target[band]),
            verify: snapshot => snapshot?.soundMode === 1 &&
                snapshot._equalizer.gains.every((gain, band) => gain === target[band])});
    }
    reconnect() {
        if (this.disposed || this.paused) return Promise.resolve({status: 'unavailable'});
        return this._queueAction({key: 'reconnect', value: true, args: ['reconnect'], kind: 'reconnect',
            title: _('Headset connection'), deadlineMs: 30_000, verify: snapshot => Boolean(snapshot)});
    }
    _queueAction(action) {
        this._clearTimer('poll');
        const promise = new Promise(finish => {
            this.pending.get(action.key)?.finish({status: 'superseded'});
            this.pending.set(action.key, {...action, finish});
        });
        this._emit({writeError: null});
        this._pump();
        return promise;
    }
    _argv(...args) {
        return [this.path, ...(this.headsetAddress ? ['--device', this.headsetAddress] : []), ...args];
    }
    _title(job) { return job.title ?? _(FIELDS[job.key].title); }
    dismissWriteError() { this._emit({writeError: null}); }
    _valid(gen) { return !this.disposed && !this.paused && gen === this.generation; }
    _pump() {
        if (this.pumping) return this.pumping;
        // Start on the next microtask so pumping is assigned before callbacks run.
        this.pumping = Promise.resolve().then(() => this._work(this.generation))
            .catch(e => {
                if (!this.disposed && !this.paused) this._readFailure({code: 'internal', message: _('Could not read headset settings'), detail: diagnostic(e.message)});
            }).finally(() => {
                this.pumping = null;
                if (!this.disposed && !this.paused) {
                    this._emit({activity: 'idle'});
                    if (this.pending.size || this.refreshRequested) this._pump();
                    else this._schedulePoll();
                }
            });
        return this.pumping;
    }
    async _work(gen) {
        while (this._valid(gen) && (this.pending.size || this.refreshRequested)) {
            if (this.pending.size && (this.ready || this.pending.values().next().value.kind === 'reconnect')) {
                const [key, job] = this.pending.entries().next().value;
                this.pending.delete(key);
                if (job.unchanged ? job.unchanged(this.state.snapshot) : this.state.snapshot?.[key] === job.value) {
                    if (key === 'transparency' && this.state.preview === job.value) this._emit({preview: null});
                    job.finish({status: 'unchanged'});
                    continue;
                }
                try {
                    if (!this.path) this.path = this.resolve(this.cliPath);
                    await this._write(job, gen);
                }
                catch (e) {
                    if (this._valid(gen)) {
                        const error = Object.freeze({code: 'execution', message: format(_('Could not update %s'), this._title(job)),
                            detail: diagnostic(e.message), setting: job.key, target: job.value});
                        this._emit({writeError: error});
                        this._readFailure({code: 'execution', message: _('Could not confirm current headset settings'), detail: diagnostic(e.message)});
                    }
                }
                finally { job.finish({status: this._valid(gen) ? (this.state.writeError ? 'failed' : 'confirmed') : 'cancelled'}); }
            } else {
                this.refreshRequested = false;
                try {
                    this.path = this.resolve(this.cliPath);
                    this._emit({availability: 'available'});
                } catch (e) {
                    this.path = null;
                    this._readFailure({code: 'missing', message: e.message});
                    this._emit({availability: 'missing'});
                    break;
                }
                await this._read(gen, 'refreshing');
            }
        }
    }
    _readFailure(error) {
        this.failures++;
        this._clearIntent('cancelled');
        this._emit({snapshotStale: true, connection: error.code === 'unavailable' ? 'unavailable' : 'error', readError: Object.freeze(error)});
    }
    async _read(gen, activity) {
        this._emit({activity});
        const r = await this.executor.run(this._argv(...(this.extended ? ['inspect', '--json'] : ['status'])),
            this.extended ? {deadlineMs: 30_000} : {});
        if (!this._valid(gen)) return false;
        if (!succeeded(r)) { this._readFailure(commandError(r)); return false; }
        let snapshot;
        try { snapshot = this.extended ? parseInspection(r.stdout) : parseStatus(r.stdout); } catch (e) {
            this._readFailure({code: 'invalid-output', message: _('Could not read headset settings'), detail: diagnostic(e.message)});
            return false;
        }
        this.failures = 0;
        this._emit({snapshot, snapshotStale: false, connection: 'ready', lastSuccessAt: this.scheduler.now(), readError: null});
        return true;
    }
    async _write(job, gen) {
        const args = job.args ?? buildSetArgs(job.key, job.value);
        this._emit({activity: 'writing', inFlight: Object.freeze({key: job.key, value: job.value})});
        try { await this._transaction(job, gen, args); } finally { this.state.inFlight = null; }
    }
    async _transaction(job, gen, args) {
        const deadlineMs = job.deadlineMs ?? (['multipoint', 'audioPriority'].includes(job.key) ? 60_000 : this.extended ? 25_000 : undefined);
        const r = await this.executor.run(this._argv(...args), deadlineMs ? {deadlineMs} : {});
        if (!this._valid(gen)) return;
        const acknowledged = succeeded(r);
        if (!acknowledged) {
            const cause = commandError(r);
            this._clearIntent('cancelled');
            this._emit({snapshotStale: true, connection: 'error', inFlight: null, writeError: Object.freeze({code: cause.code,
                message: format(_('Could not update %s'), this._title(job)), detail: [cause.message, cause.detail].filter(Boolean).join('. '), setting: job.key, target: job.value})});
        }
        this._emit({activity: 'settling'});
        await new Promise(resolve => {
            this.settleFinish = resolve;
            this._timer('settle', SETTLE_MS, () => { this.settleFinish = null; resolve(); });
        });
        if (!this._valid(gen)) return;
        // This read satisfies every refresh requested before it starts.
        this.refreshRequested = false;
        const valid = await this._read(gen, 'verifying');
        if (!this._valid(gen)) return;
        if (acknowledged && !valid)
            this._emit({writeError: Object.freeze({code: 'unconfirmed', message: _('Update sent; current headset state could not be confirmed'), setting: job.key, target: job.value})});
        else if (acknowledged && !(job.verify ? job.verify(this.state.snapshot) : this.state.snapshot[job.key] === job.value))
            this._emit({writeError: Object.freeze({code: 'mismatch', message: format(_('%s did not change to the requested value'), this._title(job)), setting: job.key, target: job.value})});
        if (job.key === 'transparency' && this.state.preview === job.value) this._emit({preview: null});
    }
    _schedulePoll() {
        this._clearTimer('poll');
        if (this.disposed || this.paused || this.state.availability === 'missing' || this.state.preview !== null || this.dragging) return;
        // While BlueZ reports no headset, reconnecting triggers the next read.
        if (this.link === 'disconnected') return;
        if (!this.open && !this.pollWhileClosed) return;
        const ms = this.failures ? BACKOFF_MS[Math.min(this.failures - 1, 3)] : (this.open ? 30_000 : 120_000);
        this._timer('poll', ms, () => this.refresh('poll'));
    }
    _invalidate() {
        this.generation++;
        this.refreshRequested = false;
        this._clearIntent('cancelled');
        this.state.inFlight = null;
        for (const name of [...this.timers.keys()]) this._clearTimer(name);
        this.settleFinish?.();
        this.settleFinish = null;
        this.executor.cancel();
    }
    pause() {
        this.paused = true;
        this.sleepPaused = true;
        this._invalidate();
        this._emit({activity: 'stopping', snapshotStale: true, connection: 'unknown'});
        const drained = this.pumping ?? Promise.resolve();
        const gen = this.generation;
        // Once cancelled work has exited, show idle so Refresh is available again.
        drained.then(() => {
            if (this.paused && !this.disposed && gen === this.generation) this._emit({activity: 'idle'});
        });
        return drained;
    }
    async resume() {
        const gen = this.generation;
        this.sleepPaused = false;
        await this.pumping;
        if (this.disposed || gen !== this.generation) return;
        this.paused = false;
        return this.refresh('resume');
    }
    stop() {
        if (!this.disposed) {
            this.disposed = true;
            this._invalidate();
            this.listeners.clear();
        }
        return this.pumping ?? Promise.resolve();
    }
}
