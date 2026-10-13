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
        stream.write(json.dumps({'phase': phase, 'pid': os.getpid(), 'ppid': os.getppid(), 'time': time.monotonic(),
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
    args = sys.argv[1:]
    if args[:1] == ['--device']:
        args = args[2:]
    def inspection():
        data = json.loads((Path(__file__).parent / 'fixtures/inspection.json').read_text())
        mapping = {'adaptive':'adaptive', 'anc':'anc', 'antiWind':'anti-wind', 'autoAnswer':'auto-answer',
                   'battery':'battery', 'comfortCall':'comfort-call', 'onHeadDetection':'on-head-detection',
                   'smartPause':'smart-pause', 'transparency':'transparency'}
        for key, legacy in mapping.items():
            value = state[legacy]
            data['settings'][key] = value == 'on' if value in ['on', 'off'] and key != 'antiWind' else value
        data['settings'].update(state.get('_extra', {}))
        data['device']['name'] = state.get('_name', data['device']['name'])
        data['connections']['peers'] = state.get('_peers', data['connections']['peers'])
        data['connections']['capacity'] = 2 if data['settings']['multipoint'] else 1
        data['equalizer']['gains'] = [data['settings'][f'eq{i}'] for i in range(5)]
        return data
    def persist(data):
        state['_extra'] = {key:value for key,value in data['settings'].items() if key not in [
            'adaptive','anc','antiWind','autoAnswer','battery','comfortCall','onHeadDetection','smartPause','transparency']}
        state['_peers'] = data['connections']['peers']
        state['_name'] = data['device']['name']
        state_file.write_text(json.dumps(state))
    if args == ['inspect', '--json']:
        data = inspection()
        if mode == 'malformed':
            del data['connections']['ownIndex']
        print(json.dumps(data))
    elif args == ['reconnect']:
        pass
    elif args[:2] == ['connections', 'list']:
        print(json.dumps(inspection()['connections']))
    elif len(args) == 5 and args[0] == 'connections' and args[1] in ['connect','switch','disconnect'] and args[3] == '--expect-name':
        data = inspection()
        index = int(args[2])
        peers = data['connections']['peers']
        if index == 0 or index >= len(peers) or peers[index]['name'] != args[4]:
            print('peer identity or control-host guard failed', file=sys.stderr); sys.exit(1)
        want = args[1] != 'disconnect'
        if want and data['connections']['capacity'] < 2:
            print('enable multipoint first', file=sys.stderr); sys.exit(1)
        if mode == 'switch-failure':
            print('switch failed; restored previous source', file=sys.stderr); sys.exit(1)
        if mode != 'mismatch':
            if want and args[1] == 'switch':
                for peer in peers:
                    if peer['index'] not in [0,index]: peer['connected'] = False
            peers[index]['connected'] = want
            persist(data)
    elif args[:2] == ['set', 'eq-preset'] and len(args) == 7:
        data = inspection()
        gains = [round(float(value) * 10) for value in args[2:]]
        if any(not -60 <= gain <= 60 for gain in gains): sys.exit(2)
        if mode != 'mismatch':
            for band,gain in enumerate(gains): data['settings'][f'eq{band}'] = gain
            data['settings']['soundMode'] = 1
            persist(data)
    elif args[:2] == ['set', 'eq'] and len(args) == 4:
        data = inspection(); band = int(args[2]); gain = round(float(args[3]) * 10)
        if not 0 <= band < 5 or not -60 <= gain <= 60: sys.exit(2)
        if mode != 'mismatch':
            data['settings'][f'eq{band}'] = gain; persist(data)
    elif len(args) == 3 and args[0] == 'set' and args[1] in [
            'multipoint','bass-boost','sidetone','sound-mode','auto-power-off','prompt-mode','touch-lock','low-latency','audio-priority','name']:
        data = inspection()
        if mode != 'mismatch':
            if args[1] == 'name': data['device']['name'] = args[2]
            else:
                key = {'bass-boost':'bassBoost','sound-mode':'soundMode','auto-power-off':'autoPowerOff',
                       'prompt-mode':'promptMode','touch-lock':'touchLock','low-latency':'lowLatency','audio-priority':'audioPriority'}.get(args[1],args[1])
                data['settings'][key] = args[2] == 'on' if args[1] in ['multipoint','bass-boost','touch-lock','low-latency'] else int(args[2])
                if key == 'multipoint' and not data['settings'][key]:
                    for peer in data['connections']['peers']:
                        if peer['index'] != 0: peer['connected'] = False
            persist(data)
    elif args == ['status']:
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
