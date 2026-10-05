"""Shared strict bundle validation, used before any installation write."""
import json
import stat
from pathlib import PurePosixPath

UUID = 'momentum4@ijaz-miks.github.io'
RUNTIME = {'metadata.json', 'extension.js', 'prefs.js', 'stylesheet.css', 'NOTICE', 'LICENSE',
           'lib/commands.js', 'lib/statusParser.js', 'lib/executableResolver.js',
           'lib/cliExecutor.js', 'lib/headsetController.js', 'lib/scheduler.js',
           'ui/indicator.js', 'ui/transparencyRow.js',
           'schemas/org.gnome.shell.extensions.momentumctl.gschema.xml',
           'schemas/gschemas.compiled'}

def validate(bundle):
    entries = bundle.infolist()
    names = [e.filename for e in entries]
    if len(names) != len(set(names)) or set(names) != RUNTIME:
        raise ValueError('Bundle must contain exactly the expected production files')
    for entry in entries:
        path = PurePosixPath(entry.filename)
        mode = entry.external_attr >> 16
        if path.is_absolute() or '..' in path.parts or '\\' in entry.filename:
            raise ValueError('Unsafe archive path')
        if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in [0, stat.S_IFREG]):
            raise ValueError('Unexpected archive entry type')
        if entry.file_size > 1_000_000 or entry.flag_bits & 1:
            raise ValueError('Oversized or encrypted entry')
    metadata = json.loads(bundle.read('metadata.json'))
    if metadata['uuid'] != UUID or metadata['shell-version'] != ['50'] or metadata['settings-schema'] != 'org.gnome.shell.extensions.momentumctl':
        raise ValueError('Unexpected metadata or supported Shell versions')
    if bundle.testzip() is not None:
        raise ValueError('Archive CRC failed')
    for name in names:
        if name.endswith('.js'):
            bundle.read(name).decode('utf-8')
    return metadata
