import {FIELDS, EXTRA_FIELDS, validateValue} from './commands.js';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function require(ok, message) { if (!ok) throw new Error(`Invalid headset snapshot: ${message}`); }
function integer(value, minimum, maximum) {
    return Number.isInteger(value) && value >= minimum && value <= maximum;
}
function text(value, maximum = 255) {
    return typeof value === 'string' && value.length > 0 && new TextEncoder().encode(value).length <= maximum &&
        !/[\x00-\x1f\x7f]/.test(value);
}
export function parseInspection(stdout) {
    const root = JSON.parse(stdout);
    require(object(root) && root.schemaVersion === 1, 'unsupported schema version');
    require(object(root.settings) && object(root.device) && object(root.connections) && object(root.unsupported), 'missing sections');
    const settings = {};
    for (const [key, field] of Object.entries(FIELDS)) {
        require(Object.hasOwn(root.settings, key), `missing ${key}`);
        settings[key] = validateValue(field.type, root.settings[key]);
    }
    for (const [key, field] of Object.entries(EXTRA_FIELDS)) {
        if (key === 'name' || field.type === 'gain') continue;
        require(Object.hasOwn(root.settings, key), `missing ${key}`);
        const value = root.settings[key];
        settings[key] = value === null ? null : validateValue(field.type, value);
    }
    const device = root.device;
    require(/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(device.address), 'invalid Bluetooth address');
    require(text(device.name) && typeof device.firmware === 'string' && /^\d+\.\d+\.\d+$/.test(device.firmware), 'invalid device information');
    require(integer(device.codec, 0, 255), 'invalid codec');
    for (const [key, max] of [['wearState', 3], ['promptLanguage', 7], ['personalizationState', 3]])
        require(device[key] === null || integer(device[key], 0, max), `invalid ${key}`);
    require(device.availablePromptLanguages === null || (Array.isArray(device.availablePromptLanguages) &&
        device.availablePromptLanguages.every(value => integer(value, 0, 7))), 'invalid prompt languages');
    const {capacity, ownIndex, peers} = root.connections;
    require(integer(capacity, 1, 2) && Array.isArray(peers) && peers.length >= 1 && peers.length <= 16, 'invalid connections');
    require(integer(ownIndex, 0, peers.length - 1), 'invalid control host');
    const nextPeers = peers.map((peer, position) => {
        require(object(peer) && peer.index === position && integer(peer.priority, 0, 15) &&
            typeof peer.connected === 'boolean' && text(peer.name), 'invalid paired device');
        return Object.freeze({index: peer.index, priority: peer.priority, connected: peer.connected, name: peer.name});
    });
    require(nextPeers[ownIndex].connected && nextPeers.filter(peer => peer.connected).length <= capacity, 'inconsistent active connections');
    let equalizer = null;
    if (root.equalizer !== null) {
        const eq = root.equalizer;
        require(object(eq) && integer(eq.minGain, -128, 127) && integer(eq.maxGain, -128, 127) &&
            eq.minGain < eq.maxGain && Array.isArray(eq.gains) && eq.gains.length > 0 && eq.gains.length <= 16, 'invalid equalizer');
        eq.gains.forEach((gain, band) => {
            require(integer(gain, eq.minGain, eq.maxGain) && root.settings[`eq${band}`] === gain, 'invalid EQ gain');
            settings[`eq${band}`] = gain;
        });
        equalizer = Object.freeze({minGain: eq.minGain, maxGain: eq.maxGain, gains: Object.freeze([...eq.gains])});
    }
    settings.name = device.name;
    return Object.freeze({...settings, _extended: true,
        _device: Object.freeze({...device, availablePromptLanguages: device.availablePromptLanguages === null
            ? null : Object.freeze([...device.availablePromptLanguages])}),
        _connections: Object.freeze({capacity, ownIndex, peers: Object.freeze(nextPeers)}),
        _equalizer: equalizer, _unsupported: Object.freeze({...root.unsupported})});
}
