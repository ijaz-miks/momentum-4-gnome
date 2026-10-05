/** The inspected CLI contract. Only these eight settings are writable. */
export const FIELDS = Object.freeze({
    anc: {label: 'ANC', command: 'anc', type: 'boolean', title: 'Noise cancellation'},
    adaptive: {label: 'Adaptive', command: 'adaptive', type: 'boolean', title: 'Adaptive noise control'},
    transparency: {label: 'Transparency', command: 'transparency', type: 'percent', title: 'Transparency'},
    antiWind: {label: 'Anti-wind', command: 'anti-wind', type: 'mode', title: 'Anti-wind'},
    smartPause: {label: 'Smart pause', command: 'smart-pause', type: 'boolean', title: 'Smart Pause'},
    onHeadDetection: {label: 'On-head detection', command: 'on-head-detection', type: 'boolean', title: 'On-head detection'},
    autoAnswer: {label: 'Auto-answer', command: 'auto-answer', type: 'boolean', title: 'Auto-answer'},
    comfortCall: {label: 'Comfort call', command: 'comfort-call', type: 'boolean', title: 'Comfort Call'},
    battery: {label: 'Battery', type: 'percent', title: 'Battery'},
});
Object.values(FIELDS).forEach(Object.freeze);

export function validateValue(type, value) {
    if (type === 'boolean' && typeof value === 'boolean')
        return value;
    if (type === 'percent' && Number.isInteger(value) && value >= 0 && value <= 100)
        return value;
    if (type === 'mode' && ['off', 'auto', 'max'].includes(value))
        return value;
    throw new TypeError(`Invalid ${type} value`);
}

export function buildSetArgs(key, value) {
    const field = Object.hasOwn(FIELDS, key) ? FIELDS[key] : null;
    if (!field?.command)
        throw new TypeError(`Unsupported setting: ${key}`);
    validateValue(field.type, value);
    return ['set', field.command, field.type === 'boolean' ? (value ? 'on' : 'off') : String(value)];
}
