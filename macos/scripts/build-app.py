#!/usr/bin/python3
"""Build and ad-hoc sign a native app in a fresh output directory. Retain all outputs."""
import argparse
import os
import platform
import shutil
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output-dir', type=Path, required=True)
parser.add_argument('--configuration', choices=['debug', 'release'], default='release')
args = parser.parse_args()
if platform.system() != 'Darwin':
    parser.error('Build on macOS with the macOS 26 or newer SDK and Swift tools')
root = Path(__file__).resolve().parent.parent
output = args.output_dir.absolute()
output.mkdir(parents=True, exist_ok=False)
subprocess.run(['xcrun', 'swift', 'build', '--package-path', str(root), '-c', args.configuration,
                '--product', 'MomentumMenu'], check=True)
binary_dir = Path(subprocess.check_output(['xcrun', 'swift', 'build', '--package-path', str(root),
    '-c', args.configuration, '--show-bin-path'], text=True).strip())
app = output / 'Momentum 4 Controls.app'
(app / 'Contents/MacOS').mkdir(parents=True)
(app / 'Contents/Resources').mkdir()
with (binary_dir / 'MomentumMenu').open('rb') as inp, (app / 'Contents/MacOS/MomentumMenu').open('xb') as out:
    shutil.copyfileobj(inp, out)
    out.flush()
    os.fsync(out.fileno())
(app / 'Contents/MacOS/MomentumMenu').chmod(0o755)
with (root / 'Resources/Info.plist').open('rb') as inp, (app / 'Contents/Info.plist').open('xb') as out:
    shutil.copyfileobj(inp, out)
subprocess.run(['xcrun', 'swift', str(root / 'scripts/make-icon.swift'), str(app / 'Contents/Resources/AppIcon.icns')], check=True)
# The arm64 linker pre-signs the generated executable. Re-sign only this new bundle.
subprocess.run(['codesign', '--force', '--sign', '-', '--identifier', 'io.github.ijaz-miks.momentum4controls', str(app)], check=True)
subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
print(f'Built native app: {app}')
print('Local ad-hoc signature. No Developer ID credentials or notarization service were used.')
