import {_, N_, format, setTranslator} from '../lib/i18n.js';
import {FIELDS} from '../lib/commands.js';
import {equal} from './assert.js';

export function run() {
    equal(_('Refresh'), 'Refresh');
    equal(N_('Off'), 'Off');
    equal(format('%s · Battery %s', 'Momentum', '82%'), 'Momentum · Battery 82%');
    const german = {'Refresh': 'Aktualisieren', 'Could not update %s': 'Konnte %s nicht aktualisieren', 'Noise cancellation': 'Geräuschunterdrückung'};
    setTranslator(text => german[text] ?? text);
    try {
        equal(_('Refresh'), 'Aktualisieren');
        // Field titles are marked with N_ and translated where they are shown.
        equal(format(_('Could not update %s'), _(FIELDS.anc.title)), 'Konnte Geräuschunterdrückung nicht aktualisieren');
        equal(FIELDS.anc.title, 'Noise cancellation');
    } finally { setTranslator(null); }
    equal(_('Refresh'), 'Refresh');
}
