#!/usr/bin/env python3
"""Read-only host checks; Python 3.5+, no environment/config secrets or logs printed."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def command(args):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    return result.returncode, result.stdout.decode('utf-8', 'replace').strip()


def main():
    base = Path(__file__).resolve().parent
    manifest = json.loads((base / 'manifest.json').read_text())
    checks = []
    for item in manifest['files']:
        target = item.get('installPath')
        if not target:
            continue
        path = Path(target)
        passed = path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == item['sha256']
        checks.append({'check': 'installed-file', 'path': target, 'passed': passed})
    for unit in ['archive-port-guard.service', 'archive-cert-renew.timer', 'longview-logrotate.timer']:
        active_exit, active = command(['systemctl', 'is-active', unit])
        enabled_exit, enabled = command(['systemctl', 'is-enabled', unit])
        checks.append({'check': 'unit', 'unit': unit, 'active': active, 'enabled': enabled,
                       'passed': active_exit == 0 and enabled_exit == 0})
    for name in ['bot_crazyplayer_1', 'bot_mongodb_1', 'emailtrek_emailtrek_1', 'emailtrek_mongodb_1']:
        code, raw = command(['docker', 'inspect', name])
        if code:
            checks.append({'check': 'container-config', 'name': name, 'passed': False, 'reason': 'unavailable'})
            continue
        data = json.loads(raw)[0]
        logging = data['HostConfig']['LogConfig']
        bindings = data['HostConfig']['PortBindings'] or {}
        loopback = all(binding['HostIp'] in ['127.0.0.1', '::1'] for values in bindings.values() for binding in (values or []))
        bounded = logging == {'Type': 'json-file', 'Config': {'max-size': '10m', 'max-file': '3'}}
        checks.append({'check': 'container-config', 'name': name, 'loopbackBindings': loopback,
                       'boundedLogs': bounded, 'passed': loopback and bounded})
    source = Path('/opt/linode/longview/Linode/Longview/DataGetter/Processes.pm')
    patched = source.is_file() and hashlib.sha256(source.read_bytes()).hexdigest() == manifest['longviewPatch']['afterSha256']
    checks.append({'check': 'longview-uid-fallback', 'passed': patched})
    print(json.dumps({'readOnly': True, 'passed': all(item['passed'] for item in checks), 'checks': checks}, indent=2))
    return 0 if all(item['passed'] for item in checks) else 1


if __name__ == '__main__':
    sys.exit(main())
