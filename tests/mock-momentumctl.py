#!/usr/bin/python3
"""Test-only CLI. No Bluetooth libraries or unmanaged child processes."""
import json
import os
import signal
import sys
import time
from pathlib import Path

root = Path(os.environ['MOMENTUMCTL_MOCK_DIR'])
mode = os.environ.get('MOMENTUMCTL_MOCK_MODE', 'stateful')
control = root / 'mode'
if control.exists():
    mode = control.read_text().strip()
log = root / 'events.jsonl'

def event(phase):
    overlap = []
    if phase == 'start' and log.exists():
        events = [json.loads(line) for line in log.read_text().splitlines()]
        active = set()
        for previous in events:
            if previous['phase'] == 'start':
                active.add(previous['pid'])
            else:
                active.discard(previous['pid'])
        for pid in active:
            if Path(f'/proc/{pid}').exists():
                overlap.append(pid)
    with log.open('a') as stream:
        stream.write(json.dumps({'phase': phase, 'pid': os.getpid(), 'time': time.monotonic(),
                                 'args': sys.argv[1:], 'locale': os.environ.get('LC_ALL'), 'overlap': overlap}) + '\n')

event('start')
try:
    if mode == 'hang' or (mode == 'set-hang' and sys.argv[1] == 'set'):
        time.sleep(60)
    if mode == 'delay':
        time.sleep(0.12)
    if mode == 'signal':
        os.kill(os.getpid(), signal.SIGTERM)
    if mode == 'invalid-utf8':
        sys.stdout.buffer.write(b'\xff\xfe\n')
        sys.exit(0)
    if mode == 'overflow':
        sys.stdout.write('x' * 100000)
        sys.exit(0)
    if mode == 'unavailable':
        print('no device found', file=sys.stderr)
        sys.exit(1)
    if mode == 'error' or (mode == 'set-error' and sys.argv[1] == 'set'):
        print('mock protocol failure', file=sys.stderr)
        sys.exit(7)
    if mode == 'rust-log':
        print(os.environ.get('RUST_LOG', 'missing'))
        sys.exit(0)
    if mode == 'locale':
        print(os.environ.get('LC_ALL', 'missing'))
        sys.exit(0)
    state_file = root / 'state.json'
    state = {'adaptive': 'off', 'anc': 'on', 'anti-wind': 'auto', 'auto-answer': 'off',
             'battery': 82, 'comfort-call': 'off', 'on-head-detection': 'on',
             'smart-pause': 'on', 'transparency': 35}
    if state_file.exists():
        state = json.loads(state_file.read_text())
    if sys.argv[1:] == ['status']:
        for key, label in [('adaptive', 'Adaptive'), ('anc', 'ANC'), ('anti-wind', 'Anti-wind'),
                           ('auto-answer', 'Auto-answer'), ('battery', 'Battery'),
                           ('comfort-call', 'Comfort call'), ('on-head-detection', 'On-head detection'),
                           ('smart-pause', 'Smart pause'), ('transparency', 'Transparency')]:
            if mode == 'malformed' and key == 'battery':
                continue
            value = state[key]
            print(f'{label}: {value}' + ('%' if key in ['battery', 'transparency'] else ''))
    elif len(sys.argv) == 4 and sys.argv[1] == 'set' and sys.argv[2] in state and sys.argv[2] != 'battery':
        if mode != 'mismatch':
            state[sys.argv[2]] = int(sys.argv[3]) if sys.argv[2] == 'transparency' else sys.argv[3]
            state_file.write_text(json.dumps(state))
    else:
        print('unsupported mock argv', file=sys.stderr)
        sys.exit(2)
finally:
    event('exit')
