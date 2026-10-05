#!/usr/bin/python3
"""Create an installable bundle in a fresh, retained output directory."""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
sys.dont_write_bytecode = True
from bundle import RUNTIME, UUID, validate
from i18n import DOMAIN, translations

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
source = Path(__file__).resolve().parent.parent
output = args.output_dir.absolute()
output.mkdir(parents=True, exist_ok=False)
stage = output / 'staging'
stage.mkdir()
for name in sorted(RUNTIME - {'schemas/gschemas.compiled'}):
    target = stage / name
    target.parent.mkdir(parents=True, exist_ok=True)
    with (source / name).open('rb') as inp, target.open('xb') as dest:
        shutil.copyfileobj(inp, dest)
subprocess.run(['glib-compile-schemas', '--strict', str(stage / 'schemas')], check=True)
files = set(RUNTIME)
for language, mo in translations():
    name = f'locale/{language}/LC_MESSAGES/{DOMAIN}.mo'
    (stage / name).parent.mkdir(parents=True, exist_ok=True)
    with (stage / name).open('xb') as stream:
        stream.write(mo)
    files.add(name)
archive = output / f'{UUID}.shell-extension.zip'
with ZipFile(archive, 'x', compression=ZIP_DEFLATED) as bundle:
    for name in sorted(files):
        bundle.write(stage / name, name)
with ZipFile(archive) as bundle:
    validate(bundle)
manifest = {name: hashlib.sha256((stage / name).read_bytes()).hexdigest() for name in sorted(files)}
with (output / 'sha256.json').open('x') as stream:
    json.dump(manifest, stream, indent=2)
print(archive)
print(f'Retained staging: {stage}')
