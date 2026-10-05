#!/usr/bin/python3
"""Verify bundle contents and installer refusal, retaining every test file."""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
sys.dont_write_bytecode = True
source = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(source / 'scripts'))
from bundle import RUNTIME, UUID, validate

bundle_path = Path(sys.argv[1]).absolute()
root = Path(tempfile.mkdtemp(prefix='momentumctl-package-tests-'))
print(f'Retained package tests: {root}')
with ZipFile(bundle_path) as bundle:
    validate(bundle)
    assert RUNTIME <= set(bundle.namelist())
    content = {n: bundle.read(n) for n in bundle.namelist()}
env = dict(os.environ, XDG_DATA_HOME=str(root / 'data'))
install = [sys.executable, str(source / 'scripts/install-local.py')]
subprocess.run(install + [str(bundle_path)], env=env, check=True, capture_output=True)
dest = root / 'data/gnome-shell/extensions' / UUID
assert all((dest / n).read_bytes() == data for n, data in content.items())
second = subprocess.run(install + [str(bundle_path)], env=env, capture_output=True)
assert second.returncode and b'Destination already exists' in second.stderr
# A compiled translation in the expected location is accepted.
translated = root / 'translated.zip'
with ZipFile(translated, 'x', compression=ZIP_DEFLATED) as bundle:
    for name, data in content.items():
        bundle.writestr(name, data)
    bundle.writestr('locale/de/LC_MESSAGES/momentum4.mo', b'')
subprocess.run(install + [str(translated)], env=dict(env, XDG_DATA_HOME=str(root / 'translated')), check=True, capture_output=True)
for case in ['traversal', 'absolute', 'symlink', 'wrong-uuid', 'missing-module', 'duplicate', 'bad-locale']:
    malicious = root / f'{case}.zip'
    with ZipFile(malicious, 'x', compression=ZIP_DEFLATED) as bundle:
        for name, data in content.items():
            if case == 'missing-module' and name == 'ui/indicator.js':
                continue
            if case == 'wrong-uuid' and name == 'metadata.json':
                value = json.loads(data)
                value['uuid'] = 'other@invalid'
                data = json.dumps(value).encode()
            if case == 'symlink' and name == 'extension.js':
                from zipfile import ZipInfo
                entry = ZipInfo(name)
                entry.external_attr = (0o120777 << 16)
                bundle.writestr(entry, b'/tmp/other')
            else:
                bundle.writestr(name, data)
        if case == 'traversal':
            bundle.writestr('../outside', 'invalid')
        if case == 'absolute':
            bundle.writestr('/tmp/outside', 'invalid')
        if case == 'bad-locale':
            bundle.writestr('locale/de/LC_MESSAGES/other.mo', b'')
        if case == 'duplicate':
            bundle.writestr('metadata.json', content['metadata.json'])
    test_data = root / case
    rejected = subprocess.run(install + [str(malicious)], env=dict(env, XDG_DATA_HOME=str(test_data)), capture_output=True)
    assert rejected.returncode and not test_data.exists(), case
print('PASS exact runtime contents, translation entries, successful retained install, refusal to replace, hostile archive rejection')
