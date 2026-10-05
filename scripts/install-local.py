#!/usr/bin/python3
"""Install a validated bundle only into an absent local UUID directory. Never enable."""
import argparse
import os
import subprocess
import sys
from pathlib import Path
from zipfile import ZipFile
sys.dont_write_bytecode = True
from bundle import UUID, validate

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('bundle', type=Path)
args = parser.parse_args()
data = Path(os.environ.get('XDG_DATA_HOME', str(Path.home() / '.local/share')))
if not data.is_absolute():
    parser.error('XDG_DATA_HOME must be absolute')
destination = data / 'gnome-shell/extensions' / UUID
with ZipFile(args.bundle) as bundle:
    validate(bundle)
    if os.path.lexists(destination):
        parser.error(f'Destination already exists: {destination}. Disable and use the mandated verified Trash workflow before updating.')
    destination.mkdir(parents=True, exist_ok=False)
    for name in sorted(bundle.namelist()):
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as stream:
            stream.write(bundle.read(name))
subprocess.run(['glib-compile-schemas', '--strict', '--dry-run', str(destination / 'schemas')], check=True)
print(f'Installed, not enabled: {destination}')
print(f'Enable explicitly in the intended session: gnome-extensions enable {UUID}')
