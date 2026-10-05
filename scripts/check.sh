#!/usr/bin/bash
set -eu
cd -- "$(dirname -- "$0")/.."
gjs -m tests/run.js
glib-compile-schemas --strict --dry-run schemas
python3 - <<'PY'
import ast
import json
import re
import subprocess
from pathlib import Path
root = Path.cwd()
metadata = json.loads((root / 'metadata.json').read_text())
assert metadata['shell-version'] == ['50']
for path in sorted(root.rglob('*.js')):
    if 'builds' in path.parts:
        continue
    source = path.read_text()
    subprocess.run(['node', '--input-type=module', '--check'], input=source, text=True, check=True)
    for relative in re.findall(r"(?:from\s+|import\s*)['\"](\.[^'\"]+)['\"]", source):
        assert (path.parent / relative).is_file(), (path, relative)
    if path.name in ['extension.js'] or path.parent.name in ['ui', 'lib']:
        assert 'gi://Gtk' not in source and 'gi://Adw' not in source
    if path.name == 'prefs.js':
        assert 'headsetController' not in source and 'Subprocess' not in source
for path in root.rglob('*.py'):
    ast.parse(path.read_text(), filename=str(path))
print('PASS syntax, import closure, schema and process separation')
PY
