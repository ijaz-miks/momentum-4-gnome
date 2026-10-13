import Gio from 'gi://Gio';
import {parseInspection} from '../lib/inspectionParser.js';
import {buildConnectionArgs, buildSetArgs} from '../lib/commands.js';
import {assert, equal, throws} from './assert.js';
function fixture() {
    const [, bytes] = Gio.File.new_for_path('tests/fixtures/inspection.json').load_contents(null);
    return JSON.parse(new TextDecoder().decode(bytes));
}
export function run() {
    const data = fixture();
    const parsed = parseInspection(JSON.stringify(data));
    assert(parsed.multipoint && parsed._connections.peers[0].connected);
    assert(Object.isFrozen(parsed._connections.peers) && Object.isFrozen(parsed._connections.peers[0]));
    equal(buildConnectionArgs('switch', parsed._connections.peers[2]),
        ['connections','switch','2','--expect-name','Windows PC']);
    equal(buildSetArgs('eq0', -15), ['set','eq','0','-1.5']);
    equal(buildSetArgs('multipoint', false), ['set','multipoint','off']);
    for (const mutate of [
        value => { value.schemaVersion = 2; },
        value => { value.settings.multipoint = 'on'; },
        value => { value.connections.ownIndex = 9; },
        value => { value.connections.peers[0].connected = false; },
        value => { value.connections.peers[2].index = 1; },
        value => { value.settings.eq0 = 100; value.equalizer.gains[0] = 100; },
        value => { value.device.address = 'not an address'; },
        value => { delete value.settings.promptMode; },
        value => { value.connections.capacity = 1; },
    ]) {
        const value = fixture(); mutate(value);
        throws(() => parseInspection(JSON.stringify(value)));
    }
    const unsupported = fixture();
    unsupported.settings.touchLock = null;
    unsupported.unsupported.touchLock = 'not supported';
    assert(parseInspection(JSON.stringify(unsupported)).touchLock === null);
    throws(() => buildSetArgs('sidetone', 6));
    throws(() => buildSetArgs('name', '\ninvalid'));
    throws(() => buildConnectionArgs('delete', {index:1,name:'Phone'}));
}
