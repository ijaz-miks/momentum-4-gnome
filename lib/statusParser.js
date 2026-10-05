import {FIELDS, validateValue} from './commands.js';

export class StatusParseError extends Error {
    constructor(message, field = null) {
        super(message);
        this.name = 'StatusParseError';
        this.code = 'invalid-output';
        this.field = field;
    }
}

/** Parse a complete snapshot. Call only after a successful process exit. */
export function parseStatus(stdout) {
    if (typeof stdout !== 'string')
        throw new StatusParseError('Status is not text');
    const labels = new Map(Object.entries(FIELDS).map(([key, f]) => [f.label, key]));
    const next = {};
    for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim())
            continue;
        const colon = line.indexOf(':');
        if (colon < 0)
            throw new StatusParseError('Status line has no colon');
        const key = labels.get(line.slice(0, colon).trim());
        if (!key)
            continue;
        if (Object.hasOwn(next, key))
            throw new StatusParseError(`Duplicate ${FIELDS[key].label}`, key);
        const text = line.slice(colon + 1).trim();
        const type = FIELDS[key].type;
        let value;
        if (type === 'boolean') {
            if (!['on', 'off'].includes(text))
                throw new StatusParseError(`Invalid ${FIELDS[key].label}`, key);
            value = text === 'on';
        } else if (type === 'percent') {
            if (!/^\d+%$/.test(text))
                throw new StatusParseError(`Invalid ${FIELDS[key].label} percentage`, key);
            value = Number(text.slice(0, -1));
        } else {
            value = text;
        }
        try {
            next[key] = validateValue(type, value);
        } catch {
            throw new StatusParseError(`Invalid ${FIELDS[key].label} value`, key);
        }
    }
    for (const key of Object.keys(FIELDS)) {
        if (!Object.hasOwn(next, key))
            throw new StatusParseError(`Missing ${FIELDS[key].label}`, key);
    }
    return Object.freeze(next);
}
