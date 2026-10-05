#!/usr/bin/python3
"""Recoverably move only the installed local Momentum extension for a later update.

Run only after disabling the extension. Never run during ordinary packaging/tests.
"""
import argparse
import configparser
import csv
import datetime
import json
import os
import pwd
import shlex
import stat
import subprocess
import tempfile
import uuid
from pathlib import Path
from urllib.parse import unquote, urlsplit

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--reason', required=True)
parser.add_argument('--log', type=Path, required=True, help='Append-only TSV removal log')
args = parser.parse_args()
home = Path.home()
data = Path(os.environ.get('XDG_DATA_HOME', str(home / '.local/share')))
if not data.is_absolute() or not args.log.is_absolute() or any(c in str(data) + args.reason for c in '\t\r\n\x00'):
    parser.error('Use absolute data and log paths and a plain single-line reason')
target = Path(os.path.abspath(data / 'gnome-shell/extensions/momentum4@ijaz-miks.github.io'))
if any(c in str(target) for c in '$*?[]{}'):
    parser.error('Unresolved variables or glob syntax are not allowed')
before = target.lstat()  # Never dereference the final symbolic link.
if not (stat.S_ISDIR(before.st_mode) or stat.S_ISLNK(before.st_mode)):
    parser.error('Expected an extension directory or final symbolic link')
mount = json.loads(subprocess.check_output(['findmnt', '--json', '--target', str(target.parent),
                                          '--output', 'TARGET,SOURCE,FSTYPE'], text=True))['filesystems'][0]
mount_root = Path(mount['target'])
if target in [Path('/'), Path('/home'), home, mount_root] or os.path.ismount(target):
    parser.error('Refusing a broad, critical or mount-root target')
kind = 'symbolic-link' if stat.S_ISLNK(before.st_mode) else 'directory'
transaction = uuid.uuid4().hex
retained = Path(tempfile.mkdtemp(prefix='momentumctl-trash-inspection-'))
inspection = {'original_path': str(target), 'type': kind, 'uid': before.st_uid,
              'owner': pwd.getpwuid(before.st_uid).pw_name, 'size': before.st_size,
              'filesystem': mount, 'transaction': transaction, 'reason': args.reason}
with (retained / 'inspection.json').open('x') as stream:
    json.dump(inspection, stream, indent=2)
print(f'Moving {target} to Trash because: {args.reason}', flush=True)
print(json.dumps(inspection, indent=2), flush=True)
log = args.log
uri = ''
metadata = ''

def record(phase, outcome):
    row = [datetime.datetime.now().astimezone().isoformat(), transaction, phase, 'trash', str(target),
           kind, f"{mount['source']} ({mount['fstype']}, device {before.st_dev})", str(mount_root),
           uri, metadata, args.reason, outcome]
    with log.open('a', newline='') as stream:
        csv.writer(stream, delimiter='\t', lineterminator='\n').writerow(row)
        stream.flush()
        os.fsync(stream.fileno())

def listing():
    return subprocess.check_output(['/usr/bin/gio', 'trash', '--list'], text=True).splitlines()

record('planned', f'planned; owner/size inspection: {retained}/inspection.json')
try:
    snapshot = listing()  # Abort if Trash is unavailable, before moving anything.
    with (retained / 'trash-before.txt').open('x') as stream:
        stream.write('\n'.join(snapshot))
    now = target.lstat()
    if (now.st_dev, now.st_ino) != (before.st_dev, before.st_ino):
        raise RuntimeError('Target changed during inspection')
    subprocess.run(['/usr/bin/gio', 'trash', '--', str(target)], check=True)
    if os.path.lexists(target):
        raise RuntimeError('Original lexical path still exists')
    after = listing()
    with (retained / 'trash-after.txt').open('x') as stream:
        stream.write('\n'.join(after))
    matches = []
    for line in after:
        if line in snapshot:
            continue
        candidate, separator, original = line.partition('\t')
        if separator and candidate.startswith('trash:///') and original == str(target):
            matches.append(candidate)
    if len(matches) != 1:
        raise RuntimeError('Could not identify one new Trash URI with the exact original path')
    uri = matches[0]
    basename = unquote(urlsplit(uri).path).lstrip('/')
    if '/' in basename or basename in ['', '.', '..']:
        raise RuntimeError('Unexpected Trash URI')
    info_roots = [data / 'Trash/info', mount_root / '.Trash' / str(os.getuid()) / 'info',
                  mount_root / f'.Trash-{os.getuid()}' / 'info']
    candidates = []
    for info_root in info_roots:
        info = info_root / f'{basename}.trashinfo'
        if not info.is_file():
            continue
        config = configparser.ConfigParser(interpolation=None)
        config.read(info)
        original = Path(unquote(config['Trash Info']['Path']))
        if not original.is_absolute():
            original = mount_root / original
        if os.path.abspath(original) == str(target):
            candidates.append(info)
    if len(candidates) != 1:
        raise RuntimeError('Recovery metadata was not uniquely verified')
    metadata = str(candidates[0])
    record('completed', 'verified')
except Exception as error:
    record('failed', str(error).replace('\n', ' '))
    parser.exit(1, f'Trash step failed: {error}. Stop and decide how to proceed. No permanent-deletion fallback. Retained inspection: {retained}\n')
print(f'Original path: {target}\nTrash URI: {uri}\nRecovery metadata: {metadata}\nReason: {args.reason}')
print(f'Recovery command: /usr/bin/gio trash --restore -- {shlex.quote(uri)}')
