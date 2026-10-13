import {N_} from './i18n.js';

/** Legacy status fields remain compatible with the original CLI output. */
export const FIELDS = Object.freeze({
    anc: {label: 'ANC', command: 'anc', type: 'boolean', title: N_('Noise cancellation')},
    adaptive: {label: 'Adaptive', command: 'adaptive', type: 'boolean', title: N_('Adaptive noise control')},
    transparency: {label: 'Transparency', command: 'transparency', type: 'percent', title: N_('Transparency')},
    antiWind: {label: 'Anti-wind', command: 'anti-wind', type: 'mode', title: N_('Anti-wind')},
    smartPause: {label: 'Smart pause', command: 'smart-pause', type: 'boolean', title: N_('Smart Pause')},
    onHeadDetection: {label: 'On-head detection', command: 'on-head-detection', type: 'boolean', title: N_('On-head detection')},
    autoAnswer: {label: 'Auto-answer', command: 'auto-answer', type: 'boolean', title: N_('Auto-answer')},
    comfortCall: {label: 'Comfort call', command: 'comfort-call', type: 'boolean', title: N_('Comfort Call')},
    battery: {label: 'Battery', type: 'percent', title: N_('Battery')},
});
Object.values(FIELDS).forEach(Object.freeze);


export const EXTRA_FIELDS = Object.freeze({
    multipoint: {command: 'multipoint', type: 'boolean', title: N_('Multipoint')},
    bassBoost: {command: 'bass-boost', type: 'boolean', title: N_('Bass boost')},
    touchLock: {command: 'touch-lock', type: 'boolean', title: N_('Lock touch controls')},
    lowLatency: {command: 'low-latency', type: 'boolean', title: N_('Low latency')},
    sidetone: {command: 'sidetone', type: 'sidetone', title: N_('Sidetone')},
    soundMode: {command: 'sound-mode', type: 'soundMode', title: N_('Sound mode')},
    autoPowerOff: {command: 'auto-power-off', type: 'timer', title: N_('Auto power-off')},
    promptMode: {command: 'prompt-mode', type: 'promptMode', title: N_('Tone and voice prompts')},
    audioPriority: {command: 'audio-priority', type: 'audioPriority', title: N_('Audio mode priority')},
    name: {command: 'name', type: 'name', title: N_('Headset name')},
    ...Object.fromEntries(Array.from({length: 16}, (_, band) =>
        [`eq${band}`, {command: 'eq', type: 'gain', band, title: N_('Equalizer')}]))
});
Object.values(EXTRA_FIELDS).forEach(Object.freeze);
export const CONTROL_FIELDS = Object.freeze({...FIELDS, ...EXTRA_FIELDS});

export function validateValue(type, value) {
    if (type === 'boolean' && typeof value === 'boolean')
        return value;
    if (type === 'percent' && Number.isInteger(value) && value >= 0 && value <= 100)
        return value;
    if (type === 'mode' && ['off', 'auto', 'max'].includes(value))
        return value;
    const maxima = {sidetone: 5, soundMode: 3, timer: 65535, promptMode: 2, audioPriority: 1};
    if (Object.hasOwn(maxima, type) && Number.isInteger(value) && value >= 0 && value <= maxima[type])
        return value;
    if (type === 'gain' && Number.isInteger(value) && value >= -128 && value <= 127)
        return value;
    if (type === 'name' && typeof value === 'string' && value.length &&
        new TextEncoder().encode(value).length <= 32 && !/[\x00-\x1f\x7f]/.test(value))
        return value;
    throw new TypeError(`Invalid ${type} value`);
}

export function buildSetArgs(key, value) {
    const field = Object.hasOwn(CONTROL_FIELDS, key) ? CONTROL_FIELDS[key] : null;
    if (!field?.command)
        throw new TypeError(`Unsupported setting: ${key}`);
    validateValue(field.type, value);
    if (field.type === 'gain')
        return ['set', 'eq', String(field.band), (value / 10).toFixed(1)];
    return ['set', field.command, field.type === 'boolean'  ? (value ? 'on' : 'off') : String(value)];
}

export function buildConnectionArgs(action, peer) {
    if (!['connect', 'disconnect', 'switch'].includes(action) ||
        !Number.isInteger(peer?.index) || peer.index < 0 || peer.index > 15 ||
        typeof peer.name !== 'string' || !peer.name.length || /[\x00-\x1f\x7f]/.test(peer.name))
        throw new TypeError('Invalid connection action or peer identity');
    return ['connections', action, String(peer.index), '--expect-name', peer.name];
}
