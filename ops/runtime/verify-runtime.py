#!/usr/bin/env python3
"""Manual, read-only runtime metadata verification; no deployment or scheduler."""
from __future__ import print_function
import argparse
import datetime
import json
import subprocess
import sys

EXPECTED = 'v24.22.1'
PACKAGES = {
    'email': ['express', 'mongodb', 'nodemailer', 'socket.io', 'pinyin', 'email-verify'],
    'bot': ['connect', 'express', 'jsonwebtoken', 'express-jwt', 'mongoose', 'nuxt', 'webpack'],
}

def probe(role, target, live):
    javascript = r'''
const fs = require('fs');
const packages = {};
for (const name of NAMES) {
  try { packages[name] = JSON.parse(fs.readFileSync('/app/node_modules/' + name + '/package.json','utf8')).version; }
  catch (error) { packages[name] = null; }
}
const pm2 = '/usr/local/lib/node_modules/pm2/package.json';
console.log(JSON.stringify({node:process.version,openssl:process.versions.openssl,
  platform:process.platform,architecture:process.arch,packages,
  pm2:fs.existsSync(pm2)?JSON.parse(fs.readFileSync(pm2,'utf8')).version:null,
  flockPresent:fs.existsSync('/usr/bin/flock')}));
'''.replace('NAMES', json.dumps(PACKAGES[role]))
    if live:
        command = ['docker', 'exec', '-w', '/app', target, 'node', '--max-old-space-size=32', '-e', javascript]
    else:
        command = ['docker', 'run', '--rm', '--network', 'none', '--read-only',
                   '--workdir', '/app', '--entrypoint', 'node', target,
                   '--max-old-space-size=32', '-e', javascript]
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            universal_newlines=True, timeout=30)
    if result.returncode:
        return {'role': role, 'target': target, 'success': False,
                'exit_code': result.returncode, 'stderr_bytes': len(result.stderr)}
    metadata = json.loads(result.stdout)
    metadata.update({'role': role, 'target': target,
                     'runtime_patch_baseline_matches': metadata['node'] == EXPECTED,
                     'success': metadata['node'] == EXPECTED and all(metadata['packages'].values())})
    return metadata

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true', help='Read named running containers instead of images.')
    parser.add_argument('--email', help='Email image tag or, with --live, container name.')
    parser.add_argument('--bot', help='Bot image tag or, with --live, container name.')
    args = parser.parse_args()
    targets = {'email': args.email or ('emailtrek_emailtrek_1' if args.live else 'archive-local/emailtrek-node24-compat:20261022'),
               'bot': args.bot or ('bot_crazyplayer_1' if args.live else 'archive-local/bot-node24-compat:20261022')}
    # Serial by design: the existing host has very little spare RAM.
    results = [probe(role, targets[role], args.live) for role in ['email', 'bot']]
    print(json.dumps({'checked_utc': datetime.datetime.utcnow().isoformat() + 'Z',
                      'expected_node': EXPECTED, 'live': args.live, 'results': results,
                      'scope': 'Runtime patch baseline only; no assertion that EOL application/database/host dependencies are secure.'}, indent=2))
    return 0 if all(item['success'] for item in results) else 1

if __name__ == '__main__':
    sys.exit(main())
