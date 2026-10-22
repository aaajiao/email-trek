#!/usr/bin/env python3
"""Default is a plan. --execute performs one read-only scan plus bounded samples.
Raw samples are never printed. Destination is private and must not already exist.
"""
import argparse, datetime, gzip, hashlib, json, os, pathlib, subprocess, sys

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--execute', action='store_true')
    p.add_argument('--output-dir', type=pathlib.Path)
    p.add_argument('--cutoff', help='Required with execute: ObjectId cutoff coordinated after stopping/draining the legacy writer')
    args = p.parse_args()
    if not args.execute:
        print(json.dumps({'plan_only': True, 'database_writes': False, 'full_scans': 1,
            'grouping': 'original created_at UTC month/status', 'bounded_mongo_sample': 10000,
            'destination_parent': 'Use an explicitly selected private local archive directory',
            'needs': 'Root coordinates one quiet append-only baseline, then supplies statistics.json to migration prepare. No scan is running.'}, indent=2))
        return
    if not args.output_dir or not args.output_dir.is_absolute():
        p.error('--execute requires an absolute --output-dir')
    if not args.cutoff or len(args.cutoff) != 24 or any(c not in '0123456789abcdefABCDEF' for c in args.cutoff):
        p.error('--execute requires an explicitly coordinated --cutoff of24hex characters')
    if args.output_dir.exists():
        p.error('Destination exists; choose a new dated directory to preserve old files')
    os.umask(0o077)
    args.output_dir.mkdir(mode=0o700, parents=True, exist_ok=False)
    script = pathlib.Path(__file__).with_name('archive-history.js').read_bytes()
    options = {'sampleSize': 10000, 'maxTimeMS': 1800000}
    options['cutoff'] = args.cutoff
    payload = ('process.env.EMAIL_ARCHIVE_EXECUTE="1";process.env.EMAIL_ARCHIVE_OPTIONS=' +
               json.dumps(json.dumps(options)) + ';\n').encode() + script + b'\nmodule.exports.main().catch(e=>{process.stderr.write(JSON.stringify({failed:true,name:e.name,code:e.code||null})+"\\n");process.exitCode=1});\n'
    partial = args.output_dir / 'extraction-result.partial.json'
    with partial.open('xb') as capture:
        result = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
            'linode-bot-emailtrek', 'docker exec -i -w /app emailtrek_emailtrek_1 node'],
            input=payload, stdout=capture, stderr=subprocess.PIPE, timeout=1980)
        capture.flush(); os.fsync(capture.fileno())
    if result.returncode:
        failure = {'success': False, 'remote_exit_code': result.returncode,
            'stderr_bytes': len(result.stderr), 'partial_output_saved': True,
            'partial_bytes': partial.stat().st_size}
        (args.output_dir / 'FAILED.json').write_text(json.dumps(failure, indent=2)+'\n')
        raise RuntimeError('Read-only extraction failed; source untouched; inspect sanitized failure marker')
    if not partial.stat().st_size:
        (args.output_dir / 'FAILED.json').write_text(json.dumps({'success':False,'reason':'empty_stdout','partial_output_saved':True})+'\n')
        raise RuntimeError('Extraction returned no data; private partial retained, do not assume scan ran')
    try:
        envelope = json.loads(partial.read_bytes())
    except (json.JSONDecodeError, UnicodeDecodeError):
        (args.output_dir / 'FAILED.json').write_text(json.dumps({'success':False,'reason':'invalid_output','partial_output_saved':True,'partial_bytes':partial.stat().st_size})+'\n')
        raise RuntimeError('Extraction output could not be parsed; private partial retained; do not automatically repeat scan') from None
    summary = envelope['statistics']; sample = envelope['sampleArchive']
    assert summary['recordCount'] == sum(summary['counts'].values()) + summary['unknownStatusCount']
    assert summary['recordCount'] == sum(g['count'] for g in summary['groups'])
    assert len(sample['records']) == sample['sampling']['uniqueRecords']
    assert sample['sampling']['requestedMongoSample'] <= 10000
    (args.output_dir / 'statistics.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2)+'\n')
    with gzip.open(args.output_dir / 'history-samples.json.gz', 'wt', encoding='utf-8') as f:
        json.dump(sample, f, ensure_ascii=False, separators=(',', ':')); f.write('\n')
    with gzip.open(args.output_dir / 'history-samples.json.gz', 'rt', encoding='utf-8') as f:
        assert json.load(f) == sample
    manifest = {'version': 1, 'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'full_database_backup': False, 'raw_samples_private': True,
        'record_count_at_cutoff': summary['recordCount'], 'cutoff': summary['cutoff'],
        'counts': summary['counts'], 'sample_count': len(sample['records']),
        'source_collection_modified': False, 'extraction_script_sha256': hashlib.sha256(script).hexdigest(),
        'files': {}}
    for name in ('statistics.json', 'history-samples.json.gz'):
        file = args.output_dir/name
        os.chmod(file, 0o600)
        manifest['files'][name] = {'bytes': file.stat().st_size, 'sha256': hashlib.sha256(file.read_bytes()).hexdigest()}
    (args.output_dir/'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n')
    (args.output_dir/'README.txt').write_text('Email Trek 代表性历史档案\n\nstatistics.json 保存按原 created_at 月份和旧状态分组的完整截止统计，可供迁移复用。\nhistory-samples.json.gz 保存分组边界及有界抽样记录，含私人邮箱字段，请保持本目录私有。\n这不是全库备份，未入样本的明细无法从累计统计还原。verified 是旧程序分类，不代表已证实的真实邮箱或送达结果。\n来源未被修改或删除；后续迁移须独立核验并由主任务执行。\n')
    partial.unlink()  # Only after both permanent artifacts and gzip round-trip exist.
    print(json.dumps({'success': True, 'output_dir': str(args.output_dir),
        'record_count': summary['recordCount'], 'samples': len(sample['records']),
        'unknown_status': summary['unknownStatusCount'], 'invalid_ids': summary['invalidIdCount'],
        'source_modified': False}, ensure_ascii=False))

if __name__ == '__main__':
    main()
