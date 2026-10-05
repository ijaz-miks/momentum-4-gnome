#!/usr/bin/python3
"""Run the packaged extension in a private headless GNOME session with an explicit mock."""
import argparse
import configparser
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('bundle', type=Path)
parser.add_argument('--output-dir', type=Path, required=True)
parser.add_argument('--scale', type=int, choices=[1, 2], default=1)
parser.add_argument('--font-scale', type=float, default=1.0)
parser.add_argument('--theme', choices=['default', 'prefer-dark', 'prefer-light'], default='default')
args = parser.parse_args()
source = Path(__file__).resolve().parent.parent
root = args.output_dir.absolute()
root.mkdir(parents=True, exist_ok=False)
for name in ['data', 'config', 'cache', 'runtime', 'mock']:
    (root / name).mkdir(mode=0o700)
runtime = Path(tempfile.mkdtemp(prefix='m4-shell-runtime-'))
mock = root / 'mock/momentumctl'
with (source / 'tests/mock-momentumctl.py').open('rb') as inp, mock.open('xb') as out:
    shutil.copyfileobj(inp, out)
mock.chmod(0o755)
env = dict(os.environ)
env.update(XDG_DATA_HOME=str(root / 'data'), XDG_CONFIG_HOME=str(root / 'config'),
           XDG_CACHE_HOME=str(root / 'cache'), XDG_RUNTIME_DIR=str(runtime),
           GSETTINGS_BACKEND='keyfile', GNOME_SHELL_SESSION_MODE='user',
           MOMENTUMCTL_MOCK_DIR=str(root / 'mock'), MOMENTUMCTL_TEST_MOCK=str(mock),
           MOMENTUMCTL_TEST_OUTPUT=str(root), WAYLAND_DISPLAY='momentumctl-test-display',
           LIBGL_ALWAYS_SOFTWARE='1', NO_AT_BRIDGE='1', GIO_USE_VFS='local', GTK_USE_PORTAL='0')
env.pop('DBUS_SESSION_BUS_ADDRESS', None)
subprocess.run([sys.executable, str(source / 'scripts/install-local.py'), str(args.bundle.absolute())], env=env, check=True)
config = configparser.ConfigParser()
config['org/gnome/shell'] = {'enabled-extensions': "['momentum4@ijaz-miks.github.io']", 'disable-user-extensions': 'false'}
config['org/gnome/shell/extensions/momentumctl'] = {'cli-path': repr(str(mock)), 'show-battery-percentage': 'true'}
config['org/gnome/desktop/interface'] = {'enable-animations': 'false', 'scaling-factor': str(args.scale),
                                      'text-scaling-factor': str(args.font_scale), 'color-scheme': repr(args.theme)}
config['org/gnome/desktop/session'] = {'idle-delay': 'uint32 0'}
settings = root / 'config/glib-2.0/settings'
settings.mkdir(parents=True)
with (settings / 'keyfile').open('x') as stream:
    config.write(stream)
command = ['dbus-run-session', '--', '/usr/bin/gnome-shell', '--headless', '--no-x11',
           '--virtual-monitor', f'{1280 * args.scale}x{1024 * args.scale}', '--wayland-display', 'momentumctl-test-display',
           '--mode', 'user', '--automation-script', str(source / 'tests/shell-smoke.js')]
print(f'Retained isolated Shell files: {root}', flush=True)
print(f'Retained short socket directory: {runtime}', flush=True)
with (root / 'shell.log').open('x') as log:
    process = subprocess.Popen(command, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        code = process.wait(timeout=90)
    except (subprocess.TimeoutExpired, KeyboardInterrupt):
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        print('Shell test interrupted or exceeded 90 seconds. Files retained.', file=sys.stderr)
        sys.exit(1)
    finally:
        # Stop any test-session services that outlived the compositor/session bus.
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
result = root / 'result.json'
if code or not result.exists():
    print((root / 'shell.log').read_text()[-16000:], file=sys.stderr)
    sys.exit(code or 1)
report = json.loads(result.read_text())
if not report.get('passed'):
    print(report, file=sys.stderr)
    sys.exit(1)
log_text = (root / 'shell.log').read_text()
for forbidden in ['JS ERROR', 'already disposed', 'not in the stage', 'Clutter-CRITICAL', 'St-CRITICAL']:
    if forbidden in log_text:
        print(f'Shell log failed acceptance: {forbidden}\n{log_text[-12000:]}', file=sys.stderr)
        sys.exit(1)
print(json.dumps(report, indent=2))
