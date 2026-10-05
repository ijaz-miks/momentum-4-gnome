import {buildSetArgs} from '../lib/commands.js';
import {equal, throws} from './assert.js';
export function run() {
    for (const [key, command] of [['anc', 'anc'], ['adaptive', 'adaptive'], ['smartPause', 'smart-pause'],
        ['onHeadDetection', 'on-head-detection'], ['autoAnswer', 'auto-answer'], ['comfortCall', 'comfort-call']]) {
        equal(buildSetArgs(key, true), ['set', command, 'on']);
        equal(buildSetArgs(key, false), ['set', command, 'off']);
        throws(() => buildSetArgs(key, 'on'));
    }
    for (const n of [0, 35, 100])
        equal(buildSetArgs('transparency', n), ['set', 'transparency', String(n)]);
    for (const n of [-1, 101, 1.5, NaN, '35'])
        throws(() => buildSetArgs('transparency', n));
    for (const mode of ['off', 'auto', 'max'])
        equal(buildSetArgs('antiWind', mode), ['set', 'anti-wind', mode]);
    for (const key of ['battery', 'reset', '__proto__'])
        throws(() => buildSetArgs(key, 0));
    throws(() => buildSetArgs('antiWind', 'high'));
}
