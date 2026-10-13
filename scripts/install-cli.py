#!/usr/bin/python3
"""Install a locally built momentumctl only when its user destination is absent."""
import argparse
import os
import shutil
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('binary', type=Path)
args = parser.parse_args()
source = args.binary.absolute()
if not source.is_file():
    parser.error('The built momentumctl binary does not exist')
with source.open('rb') as stream:
    if stream.read(4) != b'\x7fELF':
        parser.error('Expected a locally built Linux ELF executable')
target = Path.home() / '.cargo/bin/momentumctl'
if os.path.lexists(target):
    parser.error(f'Destination already exists: {target}. Disable the extension and preserve the existing binary with the verified Trash workflow before updating.')
target.parent.mkdir(parents=True, exist_ok=True)
with source.open('rb') as inp, target.open('xb') as out:
    shutil.copyfileobj(inp, out)
    out.flush()
    os.fsync(out.fileno())
target.chmod(0o755)
print(f'Installed: {target}')
