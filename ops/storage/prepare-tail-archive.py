#!/usr/bin/env python3
"""Archive only the exact small tail; default is plan-only. No server mutation."""
import argparse, gzip, hashlib, json, os, pathlib, re, subprocess

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--execute', action='store_true')
    p.add_argument('--writers-stopped', action='store_true')
    p.add_argument('--archive-dir', type=pathlib.Path)
    p.add_argument('--container', default='emailtrek_emailtrek_1')
    p.add_argument('--max-records', type=int, default=10000)
    args = p.parse_args()
    if not args.execute:
        print(json.dumps({'plan_only': True, 'requires': 'Only legacy writer stopped; maintenance container has original Node14/config read-only and database network.',
            'supports': '--container NAME --archive-dir PRIVATE_BASELINE_ARCHIVE --writers-stopped', 'maximum_records': args.max_records}, indent=2)); return
    if not args.writers_stopped or not args.archive_dir or not args.archive_dir.is_absolute():
        p.error('Execution requires --writers-stopped and absolute --archive-dir')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', args.container) or not 1 <= args.max_records <= 100000:
        p.error('Invalid container name or tail bound')
    base = args.archive_dir
    manifest = json.loads((base/'manifest.json').read_text())
    statistics_bytes = (base/'statistics.json').read_bytes()
    if hashlib.sha256(statistics_bytes).hexdigest() != manifest['files']['statistics.json']['sha256']:
        raise RuntimeError('Baseline statistics checksum mismatch')
    baseline = json.loads(statistics_bytes)
    os.umask(0o077)
    output = base/'tail-before-migration'
    output.mkdir(mode=0o700, exist_ok=False)
    script = pathlib.Path(__file__).with_name('archive-tail.js').read_bytes()
    options = {'cutoff': baseline['cutoff'], 'writersStopped': True, 'maxRecords': args.max_records}
    payload = ('process.env.EMAIL_TAIL_EXECUTE="1";process.env.EMAIL_TAIL_OPTIONS='+json.dumps(json.dumps(options))+';\n').encode()+script+b'\nmodule.exports.main().catch(e=>{process.stderr.write(JSON.stringify({failed:true,name:e.name,code:e.code||null})+"\\n");process.exitCode=1});\n'
    partial=output/'tail-result.partial.json'
    with partial.open('xb') as capture:
        r = subprocess.run(['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','linode-bot-emailtrek',
            'docker exec -i -w /app '+args.container+' node'], input=payload, stdout=capture, stderr=subprocess.PIPE, timeout=150)
        capture.flush();os.fsync(capture.fileno())
    if r.returncode:
        (output/'FAILED.json').write_text(json.dumps({'success':False,'remote_exit_code':r.returncode,'stderr_bytes':len(r.stderr)})+'\n')
        raise RuntimeError('Tail extraction refused/failed; private partial retained; source unchanged')
    if not partial.stat().st_size:raise RuntimeError('Tail returned no output; private partial retained')
    envelope=json.loads(partial.read_bytes()); tail=envelope['statistics']
    assert tail['cutoff']==baseline['cutoff']
    assert tail['recordCount']==len(envelope['records'])
    assert sum(tail['counts'].values())+tail['unknownStatusCount']==tail['recordCount']
    assert baseline['recordCount']+tail['recordCount']==tail['sourceMetadataCount'], 'Baseline plus exact tail differs from source count'
    tail['baselineStatisticsSha256']=hashlib.sha256(statistics_bytes).hexdigest()
    tail['combinedCounts']={key:baseline['counts'][key]+tail['counts'][key] for key in baseline['counts']}
    tail['combinedUnknownStatusCount']=baseline['unknownStatusCount']+tail['unknownStatusCount']
    (output/'tail-statistics.json').write_text(json.dumps(tail,indent=2)+'\n')
    with gzip.open(output/'tail-records.json.gz','wt',encoding='utf-8') as f:json.dump(envelope['records'],f,separators=(',',':'));f.write('\n')
    files={}
    for name in ['tail-statistics.json','tail-records.json.gz']:
        target=output/name;os.chmod(target,0o600);files[name]={'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'bytes':target.stat().st_size}
    (output/'manifest.json').write_text(json.dumps({'version':1,'source_modified':False,'sourceLastId':tail['sourceLastId'],
        'baselineStatisticsSha256':tail['baselineStatisticsSha256'],'files':files,'script_sha256':hashlib.sha256(script).hexdigest()},indent=2)+'\n')
    with gzip.open(output/'tail-records.json.gz','rt',encoding='utf-8') as f:assert json.load(f)==envelope['records']
    partial.unlink()
    print(json.dumps({'success':True,'output_dir':str(output),'tail_records':tail['recordCount'],
        'source_count':tail['sourceMetadataCount'],'combined_counts':tail['combinedCounts'],
        'unknown_status':tail['combinedUnknownStatusCount'],'source_modified':False}))

if __name__=='__main__':main()
