#!/usr/bin/python3
"""Translation tooling: literal-only markers, .po parsing and .mo output."""
import gettext
import io
import re
import sys
from pathlib import Path
sys.dont_write_bytecode = True
root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root / 'scripts'))
import i18n

# Every _() call must be extractable: a literal, or a value marked with N_().
allowed = re.compile(r"_\((\s*'|FIELDS\[[^\]]+\]\.title\)|MODE_LABELS\[[^\]]+\]\))")
for entry in i18n.SOURCES:
    path = root / entry
    for source in (sorted(path.rglob('*.js')) if path.is_dir() else [path]):
        for number, line in enumerate(source.read_text().splitlines(), 1):
            if re.search(r'function N?_\(', line) or line.lstrip().startswith(('//', '/*', '*')):
                continue  # Definitions in lib/i18n.js and comments.
            for match in re.finditer(r'\bN?_\(', line):
                assert allowed.match(line, match.start() + (1 if line[match.start()] == 'N' else 0)), f'{source}:{number}: {line.strip()}'
messages = i18n.extract()
for expected in ['Refresh', 'Could not update %s', 'Noise cancellation', 'Off', 'Transparency: %s']:
    assert expected in messages, expected

po = r'''
msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\n"

#: ui/indicator.js:1
msgid "Refresh"
msgstr "Aktualisieren"

msgid "Could not update %s"
msgstr ""
"Konnte %s nicht "
"aktualisieren"

#, fuzzy
msgid "Off"
msgstr "Aus"

msgid "Untranslated"
msgstr ""

msgid "Quote \"and\" newline\n"
msgstr "Zitat \"und\" Zeile\n"
'''
catalog = i18n.parse_po(po)
assert catalog['Refresh'] == 'Aktualisieren'
assert catalog['Could not update %s'] == 'Konnte %s nicht aktualisieren'
assert 'Off' not in catalog and 'Untranslated' not in catalog, 'Fuzzy or empty entries were compiled'
translation = gettext.GNUTranslations(io.BytesIO(i18n.compile_mo(catalog)))
assert translation.gettext('Refresh') == 'Aktualisieren'
assert translation.gettext('Quote "and" newline\n') == 'Zitat "und" Zeile\n'
assert translation.gettext('Off') == 'Off'
for bad in ['msgid "a"\nmsgid_plural "b"\n', 'garbage\n']:
    try:
        i18n.parse_po(bad)
    except ValueError:
        continue
    raise AssertionError(f'Accepted unsupported .po: {bad!r}')
print('PASS translation markers, .po parsing and .mo compatibility with Python gettext')
