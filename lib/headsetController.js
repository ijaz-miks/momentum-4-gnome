import {buildSetArgs, FIELDS} from './commands.js';
import {parseStatus} from './statusParser.js';

const SETTLE_MS = 500;
const DEBOUNCE_MS = 350;
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000];
const succeeded = r => r.exitCode === 0 && !r.error && !r.timedOut && !r.cancelled;
export function diagnostic(text) {
    return String(text ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220);
}
function commandError(r) {
    if (r.timedOut) return {code: 'timeout', message: 'The headset did not respond in time'};
    if (/no device found/i.test(r.stderr)) return {code: 'unavailable', message: 'Headset unavailable. Connect it in Bluetooth Settings, then refresh.'};
    return {code: 'communication', message: 'Could not communicate with the headset', detail: diagnostic(r.error || r.stderr || `Exit ${r.exitCode}, signal ${r.signal}`)};
}

/** No GI or Shell dependencies. scheduler, executor and resolver are injectable. */
export class HeadsetController {
    constructor({executor, scheduler, resolve, cliPath = ''}) {
        this.executor = executor;
        this.scheduler = scheduler;
        this.resolve = resolve;
        this.cliPath = cliPath;
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
    refresh(_reason = 'manual') {
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
    dismissWriteError() { this._emit({writeError: null}); }
    _valid(gen) { return !this.disposed && !this.paused && gen === this.generation; }
    _pump() {
        if (this.pumping) return this.pumping;
        // Start on the next microtask so pumping is assigned before callbacks run.
        this.pumping = Promise.resolve().then(() => this._work(this.generation))
            .catch(e => {
                if (!this.disposed && !this.paused) this._readFailure({code: 'internal', message: 'Could not read headset settings', detail: diagnostic(e.message)});
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
            if (this.pending.size && this.ready) {
                const [key, job] = this.pending.entries().next().value;
                this.pending.delete(key);
                if (this.state.snapshot[key] === job.value) {
                    if (key === 'transparency' && this.state.preview === job.value) this._emit({preview: null});
                    job.finish({status: 'unchanged'});
                    continue;
                }
                try { await this._write(job, gen); }
                catch (e) {
                    if (this._valid(gen)) {
                        const error = Object.freeze({code: 'execution', message: `Could not update ${FIELDS[job.key].title}`,
                            detail: diagnostic(e.message), setting: job.key, target: job.value});
                        this._emit({writeError: error});
                        this._readFailure({code: 'execution', message: 'Could not confirm current headset settings', detail: diagnostic(e.message)});
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
        const r = await this.executor.run([this.path, 'status']);
        if (!this._valid(gen)) return false;
        if (!succeeded(r)) { this._readFailure(commandError(r)); return false; }
        let snapshot;
        try { snapshot = parseStatus(r.stdout); } catch (e) {
            this._readFailure({code: 'invalid-output', message: 'Could not read headset settings', detail: diagnostic(e.message)});
            return false;
        }
        this.failures = 0;
        this._emit({snapshot, snapshotStale: false, connection: 'ready', lastSuccessAt: this.scheduler.now(), readError: null});
        return true;
    }
    async _write(job, gen) {
        const args = buildSetArgs(job.key, job.value);
        this._emit({activity: 'writing', inFlight: Object.freeze({key: job.key, value: job.value})});
        try { await this._transaction(job, gen, args); } finally { this.state.inFlight = null; }
    }
    async _transaction(job, gen, args) {
        const r = await this.executor.run([this.path, ...args]);
        if (!this._valid(gen)) return;
        const acknowledged = succeeded(r);
        if (!acknowledged) {
            const cause = commandError(r);
            this._clearIntent('cancelled');
            this._emit({snapshotStale: true, connection: 'error', inFlight: null, writeError: Object.freeze({code: cause.code,
                message: `Could not update ${FIELDS[job.key].title}`, detail: [cause.message, cause.detail].filter(Boolean).join('. '), setting: job.key, target: job.value})});
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
            this._emit({writeError: Object.freeze({code: 'unconfirmed', message: 'Update sent; current headset state could not be confirmed', setting: job.key, target: job.value})});
        else if (acknowledged && this.state.snapshot[job.key] !== job.value)
            this._emit({writeError: Object.freeze({code: 'mismatch', message: `${FIELDS[job.key].title} did not change to the requested value`, setting: job.key, target: job.value})});
        if (job.key === 'transparency' && this.state.preview === job.value) this._emit({preview: null});
    }
    _schedulePoll() {
        this._clearTimer('poll');
        if (this.disposed || this.paused || this.state.availability === 'missing' || this.state.preview !== null || this.dragging) return;
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
        this._invalidate();
        this._emit({activity: 'stopping', snapshotStale: true, connection: 'unknown'});
        return this.pumping ?? Promise.resolve();
    }
    async resume() {
        const gen = this.generation;
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
