#!/usr/bin/python3
"""Install only into an absent user Applications destination. Never replace or remove."""
import argparse
import os
import plistlib
import platform
import shutil
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('app', type=Path)
parser.add_argument('--launch', action='store_true')
parser.add_argument('--name', default='Momentum 4 Controls.app', help='A fresh .app name within your Applications folder')
args = parser.parse_args()
if platform.system() != 'Darwin':
    parser.error('Install on macOS')
source = args.app.absolute()
with (source / 'Contents/Info.plist').open('rb') as stream:
    info = plistlib.load(stream)
if info.get('CFBundleIdentifier') != 'io.github.ijaz-miks.momentum4controls' or info.get('CFBundleExecutable') != 'MomentumMenu':
    parser.error('Unexpected application bundle')
subprocess.run(['codesign', '--verify', '--deep', '--strict', str(source)], check=True)
if Path(args.name).name != args.name or not args.name.endswith('.app') or args.name in ['.app', '..app']:
    parser.error('Choose a single application filename ending in .app')
destination = Path.home() / 'Applications' / args.name
if os.path.lexists(destination):
    parser.error('The app already exists. Preserve the existing app with the verified desktop Trash procedure before updating.')
destination.parent.mkdir(parents=True, exist_ok=True)
shutil.copytree(source, destination, symlinks=True)
subprocess.run(['codesign', '--verify', '--deep', '--strict', str(destination)], check=True)
# Register only this fresh bundle so privacy and login services can identify it.
subprocess.run(['/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
                '-f', str(destination)], check=True)
print(f'Installed: {destination}')
if args.launch:
    subprocess.run(['open', str(destination)], check=True)
