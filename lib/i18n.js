// Translation hooks with no Shell or GTK imports, so lib/ stays testable with
// plain gjs. extension.js and prefs.js install the extension's gettext.
let translate = text => text;

export function setTranslator(fn) {
    translate = fn ?? (text => text);
}

/** Translate a literal. scripts/i18n.py extracts _('...') and N_('...'). */
export function _(text) {
    return translate(text);
}

/** Mark a literal for extraction; translate it later with _(). */
export function N_(text) {
    return text;
}

/** Replace each %s in a translated template, in order. */
export function format(template, ...values) {
    let index = 0;
    return template.replace(/%s/g, () => String(values[index++] ?? ''));
}
