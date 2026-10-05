#!/usr/bin/python3
"""Translation tooling without GNU gettext: extract a .pot and compile .po files.

    python3 scripts/i18n.py pot          # rewrite po/momentum4.pot from the sources
    python3 scripts/i18n.py check        # fail if po/momentum4.pot is out of date

Strings are marked with _('...') or N_('...') using single-quoted literals.
Translators copy po/momentum4.pot to po/<language>.po; package.py compiles it.
"""
import re
import struct
import sys
from pathlib import Path

DOMAIN = 'momentum4'
ROOT = Path(__file__).resolve().parent.parent
SOURCES = ['extension.js', 'prefs.js', 'lib', 'ui']
MARK = re.compile(r"\bN?_\(\s*'((?:[^'\\\n]|\\.)*)'\s*[,)]")


def unescape(text):
    return re.sub(r'\\(.)', lambda m: {'n': '\n', 't': '\t'}.get(m.group(1), m.group(1)), text)


def po_quote(text):
    return '"' + text.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n').replace('\t', '\\t') + '"'


def extract():
    """Return {msgid: [file:line, ...]} in first-seen order."""
    messages = {}
    files = []
    for entry in SOURCES:
        path = ROOT / entry
        files.extend(sorted(path.rglob('*.js')) if path.is_dir() else [path])
    for path in files:
        for number, line in enumerate(path.read_text().splitlines(), 1):
            for match in MARK.finditer(line):
                messages.setdefault(unescape(match.group(1)), []).append(f'{path.relative_to(ROOT)}:{number}')
    return messages


def pot_text():
    lines = ['# Translations for Momentum 4 Controls.', '# This file is distributed under the same license as the project.',
             'msgid ""', 'msgstr ""', '"Content-Type: text/plain; charset=UTF-8\\n"', '']
    for msgid, refs in extract().items():
        lines += [f'#: {" ".join(refs)}', f'msgid {po_quote(msgid)}', 'msgstr ""', '']
    return '\n'.join(lines)


def parse_po(text):
    """Parse simple .po files (no plurals or contexts). Returns {msgid: msgstr}."""
    catalog, key, current, fuzzy = {}, None, {}, False

    def commit():
        if 'msgid' in current and 'msgstr' in current and not fuzzy:
            if current['msgstr'] or current['msgid'] == '':
                catalog[current['msgid']] = current['msgstr']

    for raw in text.splitlines() + ['']:
        line = raw.strip()
        if not line:
            commit(); current, key, fuzzy = {}, None, False
        elif line.startswith('#,') and 'fuzzy' in line:
            fuzzy = True
        elif line.startswith('#'):
            continue
        elif line.startswith(('msgid_plural', 'msgctxt', 'msgstr[')):
            raise ValueError(f'Unsupported .po syntax: {line}')
        elif line.startswith(('msgid ', 'msgstr ')):
            if line.startswith('msgid ') and 'msgstr' in current:
                commit(); current, fuzzy = {}, False
            key, value = line.split(' ', 1)
            current[key] = unescape(value[1:-1])
        elif line.startswith('"') and key:
            current[key] += unescape(line[1:-1])
        else:
            raise ValueError(f'Malformed .po line: {raw}')
    return catalog


def compile_mo(catalog):
    """Write a GNU .mo catalog (little endian, revision 0)."""
    items = sorted((k.encode(), v.encode()) for k, v in catalog.items())
    count = len(items)
    key_table, value_table = 28, 28 + count * 8
    data = 28 + count * 16
    ids = b''.join(k + b'\0' for k, _ in items)
    strs = b''.join(v + b'\0' for _, v in items)
    keys, values, offset = [], [], data
    for key, _ in items:
        keys += [len(key), offset]; offset += len(key) + 1
    for _, value in items:
        values += [len(value), offset]; offset += len(value) + 1
    header = struct.pack('<7I', 0x950412de, 0, count, key_table, value_table, 0, 0)
    return header + struct.pack(f'<{len(keys)}I', *keys) + struct.pack(f'<{len(values)}I', *values) + ids + strs


def translations():
    """Yield (language, .mo bytes) for every po/<language>.po."""
    for po in sorted((ROOT / 'po').glob('*.po')):
        if not re.fullmatch(r'[A-Za-z]{2,3}(_[A-Za-z]{2})?(@[A-Za-z]+)?', po.stem):
            raise ValueError(f'Unexpected translation file name: {po.name}')
        yield po.stem, compile_mo(parse_po(po.read_text()))


if __name__ == '__main__':
    command = sys.argv[1] if len(sys.argv) > 1 else ''
    target = ROOT / 'po' / f'{DOMAIN}.pot'
    if command == 'pot':
        target.parent.mkdir(exist_ok=True)
        target.write_text(pot_text())
        print(target)
    elif command == 'check':
        # Compare messages only, so unrelated edits that move lines do not fail.
        current = set(parse_po(target.read_text().replace('msgstr ""', 'msgstr "x"'))) - {''} if target.exists() else set()
        if current != set(extract()):
            sys.exit('po/momentum4.pot is out of date. Run: python3 scripts/i18n.py pot')
        print('PASS translation template is current')
    else:
        sys.exit(__doc__)
