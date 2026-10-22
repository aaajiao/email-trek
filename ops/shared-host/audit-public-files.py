#!/usr/bin/env python3
"""Conservative local publication scan. No network and no matched values printed."""
import hashlib
import json
from pathlib import Path
import re
import sys


def scan(base):
    rules = {
        'private-key-block': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----'),
        'aws-access-key': re.compile(r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'),
        'github-token': re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b'),
        'jwt-value': re.compile(r'\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{10,}\b'),
        'url-user-password': re.compile(r'(?:mongodb(?:\+srv)?|https?|smtps?)://[^\s/:@]+:[^\s/@]+@'),
        'credential-literal': re.compile(r'''(?i)(?:api[_-]?key|password|passwd|jwt[_-]?secret|access[_-]?token)\s*[:=]\s*["'][^"'\n]{8,}["']'''),
        'email-address-value': re.compile(r'(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')
    }
    findings = []
    checked = []
    for path in sorted(base.rglob('*')):
        if not path.is_file() or path.name in ['sensitive-content-scan.json']:
            continue
        relative = str(path.relative_to(base))
        if path.is_symlink():
            findings.append({'path': relative, 'rule': 'symlink-not-permitted'})
            continue
        data = path.read_bytes()
        try:
            content = data.decode('utf-8')
        except UnicodeDecodeError:
            findings.append({'path': relative, 'rule': 'unexpected-binary'})
            continue
        if path.name in ['.env', 'config.js', 'id_rsa', 'id_ed25519'] or path.suffix.lower() in ['.pem', '.key', '.log', '.gz', '.sql', '.bson']:
            findings.append({'path': relative, 'rule': 'private-artifact-name'})
        for rule, expression in rules.items():
            for match in expression.finditer(content):
                findings.append({'path': relative, 'rule': rule, 'line': content.count('\n', 0, match.start()) + 1})
        checked.append({'path': relative, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
    return {'passed': not findings, 'matchedValuesPrinted': False, 'filesChecked': checked,
            'findings': findings, 'limits': 'Pattern scan plus manual source review; not a proof that every possible secret encoding is absent.'}


if __name__ == '__main__':
    result = scan(Path(__file__).resolve().parent)
    print(json.dumps(result, indent=2))
    sys.exit(0 if result['passed'] else 1)
