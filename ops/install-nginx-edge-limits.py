#!/usr/bin/env python3
"""Root-only, scoped Nginx config installer. Plan by default; --apply reloads.
No daemon restart; creates a private rollback bundle and restores on failure.
Compatible with Python3.5 and Nginx1.10 syntax. No credentials are embedded.
"""
import argparse, datetime, hashlib, json, os, pathlib, re, shutil, subprocess

ROOT=pathlib.Path('/etc/nginx/conf.d')
ZONE=ROOT/'00-archive-edge-limits.conf'
BEGIN='    # BEGIN managed archive POST edge limits'
END='    # END managed archive POST edge limits'
ZONES='''# Scoped POST-only rate limits for the two archival applications.
# Empty keys are not accounted, so GET/HEAD and other methods stay unchanged.
map $request_method $archive_post_limit_key {
    default "";
    POST $binary_remote_addr;
}
limit_req_zone $archive_post_limit_key zone=archive_bot_login:1m rate=20r/m;
limit_req_zone $archive_post_limit_key zone=archive_email_send:1m rate=1r/s;
limit_req_zone $archive_post_limit_key zone=archive_email_data:1m rate=10r/s;
'''
TARGETS=[
 ('bot-gluttony.com.conf','4001',[('/api/auth/login','archive_bot_login',5,'8k')]),
 ('email-trek.t-h-e-s-p-a-c-e.com.conf','4000',[('/mail-you-send','archive_email_send',4,'4k'),('/get-data','archive_email_data',60,'4k')]),
]
def digest(data):return hashlib.sha256(data).hexdigest()
def run(command):
    r=subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,universal_newlines=True)
    if r.returncode:raise RuntimeError('Command failed: '+command[0]+'; '+r.stdout.strip())
    return r.stdout.strip()
def atomic(path,data,mode=0o644,uid=0,gid=0):
    temp=path.with_name(path.name+'.maintenance-new')
    with temp.open('xb') as f:f.write(data);f.flush();os.fsync(f.fileno())
    os.chmod(str(temp),mode);os.chown(str(temp),uid,gid);os.replace(str(temp),str(path))
def plan():
    result={ZONE:ZONES.encode()}
    if ZONE.exists() and ZONE.read_text()!=ZONES:raise RuntimeError('Existing zone file differs; refuse to overwrite')
    for filename,port,rules in TARGETS:
        path=ROOT/filename;source=path.read_text()
        source=re.sub(r'(?ms)^'+re.escape(BEGIN)+r'\n.*?^'+re.escape(END)+r'\n','',source)
        candidates=list(re.finditer(r'(?m)^    location / \{\n(?P<body>(?:        [^\n]*\n)+)    \}',source))
        matches=[m for m in candidates if 'proxy_pass http://127.0.0.1:'+port+';' in m.group('body')]
        if len(matches)!=1:raise RuntimeError('Expected one unmodified proxy block in '+filename)
        match=matches[0];body=match.group('body')
        required=['proxy_set_header Host $host;','proxy_set_header X-Real-IP $remote_addr;','proxy_set_header X-Forwarded-Proto $scheme;']
        if not all(item in body for item in required):raise RuntimeError('Required existing proxy headers missing')
        blocks=[BEGIN]
        for uri,zone,burst,size in rules:
            if re.search(r'location\s*=\s*'+re.escape(uri)+r'\s*\{',source):raise RuntimeError('Unmanaged exact location already exists')
            blocks.extend(['    location = '+uri+' {','        client_max_body_size '+size+';',
                '        limit_req zone='+zone+' burst='+str(burst)+' nodelay;',
                '        limit_req_status 429;',body.rstrip('\n'),'    }'])
        blocks.extend([END,''])
        result[path]=(source[:match.start()]+'\n'.join(blocks)+source[match.start():]).encode()
    return result
def restore(backup,manifest):
    for item in manifest['files']:
        path=pathlib.Path(item['path'])
        if path not in [ZONE]+[ROOT/x[0] for x in TARGETS]:raise RuntimeError('Unexpected rollback path')
        if item['existed']:
            data=(backup/item['backup_name']).read_bytes()
            if digest(data)!=item['before_sha256']:raise RuntimeError('Rollback checksum mismatch')
            atomic(path,data,item['mode'],item['uid'],item['gid'])
        elif path.exists():path.unlink()
def main():
    p=argparse.ArgumentParser();p.add_argument('--apply',action='store_true');p.add_argument('--rollback',type=pathlib.Path);args=p.parse_args()
    if os.geteuid()!=0:raise RuntimeError('Run as root on the host')
    if args.rollback:
        manifest=json.loads((args.rollback/'manifest.json').read_text());restore(args.rollback,manifest);run(['nginx','-t']);run(['systemctl','reload','nginx']);print(json.dumps({'rolled_back':True}));return
    desired=plan();summary={'plan_only':not args.apply,'files':[{'path':str(path),'sha256':digest(data)} for path,data in desired.items()]}
    if not args.apply:print(json.dumps(summary));return
    os.umask(0o077)
    stamp=datetime.datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')
    day=datetime.datetime.utcnow().strftime('%Y-%m-%d')
    backup=pathlib.Path('/root/maintenance-archives')/day/('bot-emailtrek-edge-limits-'+stamp)
    backup.mkdir(mode=0o700,parents=True);manifest={'files':[],'created_at_utc':stamp}
    for path,data in desired.items():
        item={'path':str(path),'existed':path.exists(),'after_sha256':digest(data)}
        if path.exists():
            st=path.stat();raw=path.read_bytes();name=path.name+'.before'
            (backup/name).write_bytes(raw);os.chmod(str(backup/name),0o600)
            item.update({'backup_name':name,'before_sha256':digest(raw),'mode':st.st_mode&0o777,'uid':st.st_uid,'gid':st.st_gid})
        manifest['files'].append(item)
    (backup/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    try:
        for path,data in desired.items():
            old=next(x for x in manifest['files'] if x['path']==str(path))
            if old['existed'] and digest(path.read_bytes())!=old['before_sha256']:raise RuntimeError('Config changed concurrently')
            atomic(path,data,old.get('mode',0o644),old.get('uid',0),old.get('gid',0))
        syntax=run(['nginx','-t']);run(['systemctl','reload','nginx']);active=run(['systemctl','is-active','nginx'])
        summary.update({'applied':True,'backup_directory':str(backup),'syntax_test':syntax,'service':active,'action':'reload only'})
        (backup/'result.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary))
    except Exception:
        restore(backup,manifest);run(['nginx','-t']);run(['systemctl','reload','nginx']);raise
if __name__=='__main__':main()
