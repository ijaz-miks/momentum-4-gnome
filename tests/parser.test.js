import GLib from 'gi://GLib';
import {parseStatus} from '../lib/statusParser.js';
import {assert, equal, throws} from './assert.js';

export function run() {
    const [, bytes] = GLib.file_get_contents(`${GLib.get_current_dir()}/tests/fixtures/status.txt`);
    const text = new TextDecoder().decode(bytes);
    const expected = {adaptive: false, anc: true, antiWind: 'auto', autoAnswer: false, battery: 82,
        comfortCall: false, onHeadDetection: true, smartPause: true, transparency: 35};
    equal(parseStatus(text), expected);
    assert(Object.isFrozen(parseStatus(text)));
    const reordered = text.trim().split('\n').reverse().map(l => `  ${l.replace(':', ' : ')}  `).join('\r\n');
    assert(parseStatus(`\n${reordered}\nFuture: value:detail\n`).battery === 82);
    for (const n of [0, 100])
        assert(parseStatus(text.replace('82%', `${n}%`)).battery === n);
    for (const key of ['Adaptive', 'ANC', 'Anti-wind', 'Auto-answer', 'Battery', 'Comfort call', 'On-head detection', 'Smart pause', 'Transparency']) {
        throws(() => parseStatus(text.split('\n').filter(l => !l.startsWith(`${key}:`)).join('\n')));
        throws(() => parseStatus(`${text}\n${text.split('\n').find(l => l.startsWith(`${key}:`))}`));
    }
    for (const bad of ['', '-1%', '+1%', '101%', '999999999999999999999%', '1.5%', 'NaN%', '35', '35%junk', '3e1%', '1 %'])
        throws(() => parseStatus(text.replace('35%', bad)));
    for (const bad of ['ON', 'true', '0', ''])
        throws(() => parseStatus(text.replace('ANC:               on', `ANC: ${bad}`)));
    throws(() => parseStatus(text.replace('auto', 'high')));
    throws(() => parseStatus(`${text}\ngarbage`));
    throws(() => parseStatus(null));
}
