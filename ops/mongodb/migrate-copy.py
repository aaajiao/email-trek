#!/usr/bin/env python3
"""Copy-only MongoDB rehearsal. Default checks metadata and prints a dry run.

--apply creates a NEW target, copies selected db/configdb trees from a read-only
source, and serially migrates the target. No production Compose edits, host ports,
public network, SMTP or cleanup of source data. Failed targets remain for review.
"""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import time
import uuid

VERSIONS = ['4.4.2', '4.4.30', '5.0.33', '6.0.28', '7.0.45', '8.0.34']
IMAGE_IDS = [
    'sha256:3068f6bb852ef596c20ca7ccbcd34df94f02d6035a2d83aea1e20e1781ba19b8',
    'sha256:0010f63d26952bd3960fac5513c64a1cf7d6299f31fa7b54ac1b36633ee04333',
    'sha256:bb3fe45d68c169ff186e84350f64261e263a555b75257219fd375312591d1cb2',
    'sha256:43d1024ae43f157265eb749e962bd318f015b2f8c0ea4e027b217f82d22da8f5',
    'sha256:72404c1083af5306608b7487184154a199b7d183f4ef250339f3c1a0b72e2523',
    'sha256:09f940d01e0c09abbfd246a2b10965cbf86a87c9c1dad86b374f925a084976c8']
LABEL = 'codex.mongodb-copy-migration'
# MongoDB r6.0.28 set_feature_compatibility_version_command.cpp:739-743
# creates this namespace at FCV6. Its create_collection.cpp:748-763 selects
# legacy clustered _id storage. These are hashes computed by the fixed verifier
# from {clusteredIndex:true} and the sole unique clustered {_id:1}, name _id_, v2.
PREIMAGES = 'config.system.preimages'
PREIMAGES_OPTIONS_SHA256 = 'e567883d282199117b4c9c6b52fb90bd3fb0aec232af2c2b369a8e3997ef1ad9'
PREIMAGES_INDEXES_SHA256 = 'd21bdfdc381a9b217c7917e4af14bc7275eb54b668b93eb6a9a8c73a1a1f285a'
EMPTY_SHA256 = hashlib.sha256(b'').hexdigest()


def run(args, data=None, timeout=60):
    return subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)


def checked(args, data=None, timeout=60):
    result = run(args, data, timeout)
    assert result.returncode == 0, 'Command failed: ' + args[0] + '; raw output withheld'
    return result.stdout


def js(args, data=None, timeout=60):
    return json.loads(checked(args, data, timeout))


def atomic(path, data):
    path = Path(path)
    assert not path.is_symlink(), 'Refuse symlink audit file'
    temp = path.with_name(path.name + '.tmp-' + str(os.getpid()))
    fd = os.open(str(temp), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(data, stream, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(str(temp), str(path))
    finally:
        if temp.exists():
            temp.unlink()


def relative_path(value):
    p = PurePosixPath(value)
    assert value and not p.is_absolute() and all(x not in ['', '.', '..'] for x in value.split('/')), 'Invalid source subpath'
    assert ',' not in value and '\x00' not in value, 'Invalid mount subpath'
    return str(p)


def volume_name(value):
    assert re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', value), 'Invalid volume name'
    return value


def bind_path(value, existing):
    p = Path(value)
    assert p.is_absolute() and ',' not in value and not p.is_symlink(), 'Use an absolute nonsymlink bind path'
    assert str(p.resolve()) == str(p), 'Bind path must be canonical'
    if existing:
        assert p.is_dir(), 'Source bind is not a directory'
    return str(p)


def storage_spec(args):
    if args.source_volume:
        source = {'type': 'volume', 'value': volume_name(args.source_volume)}
    else:
        source = {'type': 'bind', 'value': bind_path(args.source_bind, True)}
    if args.target_volume:
        assert args.target_volume.startswith('codex-mongo-'), 'New target volume must start codex-mongo-'
        target = {'type': 'volume', 'value': volume_name(args.target_volume)}
    else:
        target = {'type': 'bind', 'value': bind_path(args.target_bind, False)}
    assert source != target, 'Source and target must differ'
    if source['type'] == target['type'] == 'bind':
        a, b = Path(source['value']), Path(target['value'])
        assert a not in b.parents and b not in a.parents, 'Source/target paths overlap'
    db = relative_path(args.source_subpath)
    config = relative_path(args.source_config_subpath)
    assert db != config and PurePosixPath(db) not in PurePosixPath(config).parents and PurePosixPath(config) not in PurePosixPath(db).parents, 'Source db/configdb trees overlap'
    return {'source': source, 'target': target, 'dbSource': db, 'configSource': config}


def mount(spec, destination, readonly=False, subpath=None):
    source = spec['value']
    suffix = ''
    if subpath:
        if spec['type'] == 'volume':
            suffix = ',volume-subpath=' + subpath
        else:
            source = str(Path(source) / subpath)
    result = 'type=' + spec['type'] + ',src=' + source + ',dst=' + destination + suffix
    return result + (',readonly' if readonly else '')


def assert_no_source_writer(source):
    ids = checked(['docker', 'ps', '-q']).decode().splitlines()
    if not ids:
        return
    # Inspect is processed only in memory; Config/Env never enter reports.
    for container in js(['docker', 'inspect'] + ids):
        for item in container.get('Mounts', []):
            if not item.get('RW'):
                continue
            if source['type'] == 'volume':
                assert item.get('Name') != source['value'], 'A running container can write the source volume'
            elif item.get('Type') == 'bind':
                a, b = Path(source['value']), Path(item['Source'])
                assert a != b and a not in b.parents and b not in a.parents, 'A running container can write the source bind tree'


def image_check(image_id, version=None):
    assert re.fullmatch(r'sha256:[0-9a-f]{64}', image_id), 'Use an exact local image ID'
    image = js(['docker', 'image', 'inspect', image_id])[0]
    assert image['Id'] == image_id and image['Architecture'] == 'amd64' and image['Os'] == 'linux', 'Wrong image platform or ID'
    if version:
        assert 'MONGO_VERSION=' + version in image['Config'].get('Env', []), 'Wrong configured MongoDB image version'
    return {'id': image_id, 'platform': 'linux/amd64', 'version': version, 'bytes': image.get('Size')}


def preflight(args):
    spec = storage_spec(args)
    engine = js(['docker', 'info', '--format', '{{json .}}'])
    assert int(engine['ServerVersion'].split('.')[0]) >= 29, 'Reviewed Docker29+ engine required'
    if engine['MemTotal'] < 2 * 1024**3:
        assert args.small_host_reviewed, 'Small host: operator must first review stopped workloads and memory budget'
        assert args.db_memory_mib <= 512, 'Small-host mongod limit must be <=512MiB'
    assert 384 <= args.db_memory_mib <= 2048, 'Unexpected database memory limit'
    chain = json.loads(args.chain.read_text())['stages']
    assert [s['version'] for s in chain] == VERSIONS and [s['image_id'] for s in chain] == IMAGE_IDS, 'Pinned image chain changed'
    images = [image_check(s['image_id'], s['version']) for s in chain]
    image_check(args.verifier_image)
    if spec['source']['type'] == 'volume':
        volume = js(['docker', 'volume', 'inspect', spec['source']['value']])[0]
        assert volume['Driver'] == 'local' and not volume.get('Options'), 'Source must be an ordinary local volume'
    assert_no_source_writer(spec['source'])
    if not args.resume:
        if spec['target']['type'] == 'volume':
            assert run(['docker', 'volume', 'inspect', spec['target']['value']]).returncode != 0, 'Target volume already exists'
        else:
            assert not Path(spec['target']['value']).exists() and Path(spec['target']['value']).parent.is_dir(), 'Target bind must be new with an existing parent'
        assert not args.audit.exists(), 'Audit directory exists; do not overwrite a prior attempt'
    else:
        assert args.audit.is_dir() and not args.audit.is_symlink(), 'Resume needs existing private audit'
    return spec, chain, images


def create_copy(args, spec, transaction):
    target = spec['target']
    if target['type'] == 'volume':
        checked(['docker', 'volume', 'create', '--label', LABEL + '=' + transaction['id'], target['value']])
    else:
        Path(target['value']).mkdir(mode=0o700, exist_ok=False)
    name = 'codex-mongo-copy-' + transaction['id']
    transaction['copy_container'] = name
    atomic(args.audit / 'transaction.json', transaction)
    command = ['docker', 'run', '--rm', '--name', name, '--label', LABEL + '=' + transaction['id'],
               '--pull', 'never', '--platform', 'linux/amd64', '--network', 'none', '--read-only',
               '--user', '0', '--memory', '256m', '--pids-limit', '64', '--interactive',
               '--mount', mount(spec['source'], '/source', True), '--mount', mount(target, '/target'),
               '--entrypoint', 'node', args.verifier_image, '/opt/verifier/copy-data.js', '--copy-new-target']
    report = js(command, json.dumps({'dbSource': spec['dbSource'], 'configSource': spec['configSource']}).encode(), timeout=900)
    assert report.get('passed') and report.get('sourceUnchanged'), 'Source copy verification failed'
    atomic(args.audit / 'copy-verification.json', report)
    transaction.update(phase='copied', copy=report, copy_container=None)
    atomic(args.audit / 'transaction.json', transaction)


def verify_source_unchanged(args, spec, transaction):
    assert_no_source_writer(spec['source'])
    command = ['docker', 'run', '--rm', '--pull', 'never', '--platform', 'linux/amd64',
               '--network', 'none', '--read-only', '--user', '0', '--memory', '256m',
               '--pids-limit', '64', '--interactive', '--mount', mount(spec['source'], '/source', True),
               '--entrypoint', 'node', args.verifier_image, '/opt/verifier/copy-data.js', '--inspect-source']
    report = js(command, json.dumps({'dbSource': spec['dbSource'], 'configSource': spec['configSource']}).encode(), timeout=900)
    assert report.get('passed') and report.get('readOnly'), 'Final source inspection failed'
    assert report['trees'] == transaction['copy']['trees'], 'Original source manifest changed'
    atomic(args.audit / 'source-final-verification.json', report)
    return True


def shell_command(name, shell, command, auth=None, timeout=180):
    # No URI credentials, env secret, command-line secret, history or raw output.
    options = {'command': command, 'auth': auth}
    script = ('var cfg = ' + json.dumps(options, ensure_ascii=True) + ';\n'
              'try { var connection = new Mongo("mongodb://127.0.0.1:27017");'
              'var admin = connection.getDB("admin");'
              'if(cfg.auth){var authdb=connection.getDB(cfg.auth.authDatabase||"admin");'
              'if(!authdb.auth(cfg.auth.username,cfg.auth.password)){throw new Error("AUTH");}}'
              'var result=admin.runCommand(cfg.command);'
              'var f=result.featureCompatibilityVersion;'
              'print("__CODEX_RESULT__"+JSON.stringify({ok:result.ok,version:f&&f.version,targetVersion:f&&f.targetVersion}));'
              '}catch(error){print("__CODEX_RESULT__"+JSON.stringify({ok:0}));quit(2);}quit(0);\n')
    # Legacy mongo reads a pipe directly but has no --file option. Mongosh uses
    # its explicit stdin file mode. Both keep AUTH values off argv and disk.
    command_line = ['docker', 'exec', '--interactive', name, shell, '--quiet', '--norc', '--nodb']
    if shell == 'mongosh':
        command_line += ['--file', '/dev/stdin']
    else:
        assert shell == 'mongo', 'Unreviewed shell'
    process = run(command_line, script.encode(), timeout=timeout)
    rows = [line.split('__CODEX_RESULT__', 1)[1] for line in process.stdout.decode(errors='replace').splitlines() if '__CODEX_RESULT__' in line]
    assert process.returncode == 0 and len(rows) == 1, 'Mongo shell command failed or marker was not unique; raw diagnostics withheld'
    result = json.loads(rows[0])
    assert result.get('ok') == 1, 'Mongo command was not successful'
    return result


def start_database(args, spec, stage, transaction):
    assert_no_source_writer(spec['target'])
    name = 'codex-mongo-stage-' + transaction['id'] + '-' + stage['version'].replace('.', '-')
    assert run(['docker', 'container', 'inspect', name]).returncode != 0, 'Stage container already exists'
    command = ['docker', 'run', '--detach', '--name', name, '--label', LABEL + '=' + transaction['id'],
               '--pull', 'never', '--platform', 'linux/amd64', '--network', 'none', '--restart', 'no',
               '--memory', str(args.db_memory_mib) + 'm', '--memory-swap', str(args.db_memory_mib + 256) + 'm',
               '--pids-limit', '256', '--stop-timeout', '120', '--log-driver', 'json-file',
               '--log-opt', 'max-size=10m', '--log-opt', 'max-file=2',
               '--mount', mount(spec['target'], '/data/db', subpath='db'),
               '--mount', mount(spec['target'], '/data/configdb', subpath='configdb'), stage['image_id'],
               'mongod', '--dbpath', '/data/db', '--bind_ip', '127.0.0.1', '--port', '27017', '--noauth',
               '--wiredTigerCacheSizeGB', '0.256', '--setParameter', 'ttlMonitorEnabled=false']
    # Persist the intended name BEFORE docker run: the CLI can time out after
    # the daemon has already created/started the container.
    transaction.update(phase='starting', active_container=name, active_version=stage['version'])
    atomic(args.audit / 'transaction.json', transaction)
    checked(command, timeout=60)
    transaction['phase'] = 'running'
    atomic(args.audit / 'transaction.json', transaction)
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        current = js(['docker', 'inspect', '--format', '{{json .State}}', name])
        assert current['Running'] and not current['OOMKilled'], 'Stage database exited or OOM killed'
        try:
            shell_command(name, stage['shell'], {'ping': 1}, timeout=10)
            return name
        except (AssertionError, subprocess.TimeoutExpired):
            time.sleep(1)
    raise AssertionError('Stage readiness deadline exceeded')


def verify(args, name):
    command = ['docker', 'run', '--rm', '--pull', 'never', '--platform', 'linux/amd64',
               '--network', 'container:' + name, '--read-only', '--cap-drop', 'ALL',
               '--security-opt', 'no-new-privileges:true', '--memory', '320m', '--pids-limit', '64',
               '--interactive', args.verifier_image]
    report = js(command, b'{"maxDocumentsPerCollection":500000}', timeout=600)
    assert report.get('passed') is True and report.get('driver') == '7.7.0', 'Fixed verifier failed'
    return report


def compare_content(baseline, current):
    old_names, new_names = set(baseline['collections']), set(current['collections'])
    assert not old_names - new_names, 'Business collection was removed'
    introduced = new_names - old_names
    if introduced:
        assert introduced == {PREIMAGES}, 'Business collection set changed'
        assert current.get('serverVersion') in VERSIONS[3:] and current.get('fcv') in ['6.0', '7.0', '8.0'], 'Pre-images introduction outside reviewed Mongo6+ transition'
        row = current['collections'][PREIMAGES]
        expected = {'type': 'collection', 'optionsSha256': PREIMAGES_OPTIONS_SHA256,
                    'indexesSha256': PREIMAGES_INDEXES_SHA256, 'indexCount': 1,
                    'capped': False, 'cappedMax': None, 'cappedBytes': None,
                    'count': 0, 'rawBsonBytes': 0, 'contentSha256': EMPTY_SHA256,
                    'naturalSha256': EMPTY_SHA256, 'validation': {'valid': True, 'warningCount': 0}}
        assert all(key in row and row[key] == value for key, value in expected.items()), 'New pre-images collection is not the exact empty internal shape'
        assert isinstance(row.get('uuidSha256'), str) and re.fullmatch(r'[0-9a-f]{64}', row['uuidSha256']), 'New pre-images collection has no UUID hash'
    for namespace, old in baseline['collections'].items():
        new = current['collections'][namespace]
        for key in ['type', 'optionsSha256', 'uuidSha256', 'capped', 'cappedMax', 'cappedBytes',
                    'indexCount', 'indexesSha256', 'count', 'rawBsonBytes', 'contentSha256', 'naturalSha256']:
            assert old.get(key) == new.get(key), 'Collection invariant changed: ' + namespace + ':' + key
        if 'validation' in new:
            assert new['validation']['valid'] and new['validation']['warningCount'] == 0, 'Validation requires review: ' + namespace
    assert baseline['usersRoles'] == current['usersRoles'], 'Authentication users/roles changed'
    return sorted(introduced)


def stop_database(name):
    checked(['docker', 'stop', '--time', '120', name], timeout=150)
    state = js(['docker', 'inspect', '--format', '{{json .State}}', name])
    assert not state['Running'] and state['ExitCode'] == 0 and not state['OOMKilled'], 'Database did not shut down cleanly'
    return {'clean': True, 'exitCode': state['ExitCode'], 'oomKilled': state['OOMKilled']}


def restart_after_fcv(args, spec, stage, transaction, name):
    """Recover the same clone using the same binary after a settled FCV write.

    This is a normal clean shutdown/restart, never repair or index rebuilding.
    The intermediate receipt is persisted before removing the stopped container.
    start_database records the name before creation, including on CLI timeouts.
    """
    assert stage['entry_fcv'] != stage['exit_fcv'], 'Mid-FCV restart is only for an actual FCV upgrade'
    receipt = {'required': True, 'image_id': stage['image_id'], 'version': stage['version'],
               'targetFCV': stage['exit_fcv'], 'shutdown': stop_database(name),
               'sameTarget': True, 'sameBinary': True, 'repairUsed': False}
    atomic(args.audit / ('stage-' + stage['version'] + '-mid-fcv-restart.json'), receipt)
    checked(['docker', 'rm', name])
    transaction.update(phase='restarting-after-fcv', active_container=None)
    atomic(args.audit / 'transaction.json', transaction)
    restarted = start_database(args, spec, stage, transaction)
    assert restarted == name, 'Unexpected replacement container name'
    fcv = shell_command(restarted, stage['shell'], {'getParameter': 1, 'featureCompatibilityVersion': 1})
    assert fcv.get('version') == stage['exit_fcv'] and not fcv.get('targetVersion'), 'FCV did not survive normal restart'
    receipt.update(restarted=True, recoveredFCV=fcv)
    atomic(args.audit / ('stage-' + stage['version'] + '-mid-fcv-restart.json'), receipt)
    return restarted, receipt


def main():
    p = argparse.ArgumentParser(description=__doc__)
    source = p.add_mutually_exclusive_group(required=True)
    source.add_argument('--source-volume'); source.add_argument('--source-bind')
    target = p.add_mutually_exclusive_group(required=True)
    target.add_argument('--target-volume'); target.add_argument('--target-bind')
    p.add_argument('--source-subpath', required=True); p.add_argument('--source-config-subpath', required=True)
    p.add_argument('--audit', type=Path, required=True)
    p.add_argument('--verifier-image', required=True)
    p.add_argument('--chain', type=Path, default=Path(__file__).with_name('image-chain.json'))
    p.add_argument('--db-memory-mib', type=int, default=768)
    p.add_argument('--small-host-reviewed', action='store_true')
    p.add_argument('--apply', action='store_true'); p.add_argument('--resume', action='store_true')
    p.add_argument('--copy-only', action='store_true')
    p.add_argument('--stop-after', choices=VERSIONS)
    args = p.parse_args(); os.umask(0o077)
    assert args.audit.is_absolute() and not args.audit.is_symlink(), 'Private audit path must be absolute and nonsymlink'
    spec, chain, images = preflight(args)
    if not args.apply:
        print(json.dumps({'passed': True, 'dryRun': True, 'source': spec['source'], 'target': spec['target'],
                          'sourceSubpaths': [spec['dbSource'], spec['configSource']], 'stages': images,
                          'noPublishedPorts': True, 'network': 'none', 'originalNeverWritable': True,
                          'maximumConcurrentMigrationMongod': 1, 'verifierImage': args.verifier_image}, indent=2))
        return 0
    if args.resume:
        state = json.loads((args.audit / 'transaction.json').read_text())
        assert state['phase'] in ['copied', 'paused'], 'Only clean copied/paused state can resume; failed targets need review and a fresh copy'
        assert state['storage'] == spec and state['verifier_image'] == args.verifier_image and state['image_ids'] == IMAGE_IDS, 'Resume inputs differ'
    else:
        args.audit.mkdir(mode=0o700, parents=True, exist_ok=False)
        state = {'schema': 1, 'id': uuid.uuid4().hex[:12], 'createdUTC': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                 'phase': 'preparing', 'storage': spec, 'verifier_image': args.verifier_image,
                 'image_ids': IMAGE_IDS, 'completed': [], 'productionConfigurationChanged': False}
        atomic(args.audit / 'transaction.json', state)
    lock = open(str(args.audit / 'operator.lock'), 'a')
    fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    active = None
    try:
        if state['phase'] == 'preparing':
            create_copy(args, spec, state)
        if args.copy_only:
            print(json.dumps({'passed': True, 'phase': state['phase'], 'audit': str(args.audit)})); return 0
        baseline_path = args.audit / 'baseline-content.json'
        baseline = json.loads(baseline_path.read_text()) if baseline_path.exists() else None
        for stage in chain[len(state['completed']):]:
            print(json.dumps({'event': 'stage-start', 'version': stage['version']}), flush=True)
            active = start_database(args, spec, stage, state)
            initial_fcv = shell_command(active, stage['shell'], {'getParameter': 1, 'featureCompatibilityVersion': 1})
            assert initial_fcv.get('version') == stage['entry_fcv'] and not initial_fcv.get('targetVersion'), 'Unexpected entering FCV'
            before = verify(args, active)
            atomic(args.audit / ('stage-' + stage['version'] + '-before-fcv.json'), before)
            assert before['serverVersion'] == stage['version'] and before['fcv'] == stage['entry_fcv'], 'Wrong running binary or FCV'
            if baseline is None:
                baseline = before
                atomic(baseline_path, baseline)
            before_introduced = compare_content(baseline, before)
            if stage['exit_fcv'] != stage['entry_fcv']:
                command = {'setFeatureCompatibilityVersion': stage['exit_fcv']}
                if int(stage['exit_fcv'].split('.')[0]) >= 7:
                    command['confirm'] = True
                shell_command(active, stage['shell'], command)
            final_fcv = shell_command(active, stage['shell'], {'getParameter': 1, 'featureCompatibilityVersion': 1})
            assert final_fcv.get('version') == stage['exit_fcv'] and not final_fcv.get('targetVersion'), 'FCV did not settle'
            mid_fcv_restart = {'required': False}
            if stage['exit_fcv'] != stage['entry_fcv']:
                active, mid_fcv_restart = restart_after_fcv(args, spec, stage, state, active)
            after = verify(args, active)
            atomic(args.audit / ('stage-' + stage['version'] + '-after-fcv.json'), after)
            assert after['fcv'] == stage['exit_fcv'] and after['serverVersion'] == stage['version'], 'Post-FCV version mismatch'
            after_introduced = compare_content(baseline, after)
            shutdown = stop_database(active)
            report = {'passed': True, 'version': stage['version'], 'image_id': stage['image_id'],
                      'enterFCV': initial_fcv, 'exitFCV': final_fcv, 'shutdown': shutdown,
                      'verified': after, 'allBaselineInvariantsPreserved': True,
                      'midFCVRestart': mid_fcv_restart,
                      'reviewedEmptyInternalAdditions': {'beforeFCV': before_introduced, 'afterFCV': after_introduced}}
            atomic(args.audit / ('stage-' + stage['version'] + '.json'), report)
            checked(['docker', 'rm', active]); active = None
            state['completed'].append(stage['version'])
            state.update(phase='paused', active_container=None, active_version=None)
            atomic(args.audit / 'transaction.json', state)
            print(json.dumps({'event': 'stage-complete', 'version': stage['version'], 'cleanShutdown': True}), flush=True)
            if args.stop_after == stage['version']:
                break
        if state['completed'] == VERSIONS:
            state['phase'] = 'complete'
        state['source_manifest_unchanged'] = verify_source_unchanged(args, spec, state)
        atomic(args.audit / 'transaction.json', state)
        print(json.dumps({'passed': True, 'phase': state['phase'], 'completed': state['completed'],
                          'audit': str(args.audit), 'productionChanged': False,
                          'targetNotActivatedForProduction': True}, indent=2))
        return 0
    except Exception as error:
        # Never remove a failed target or original. Best effort stops only our stage.
        name = active or state.get('active_container') or state.get('copy_container')
        if name:
            try:
                state['failure_shutdown'] = stop_database(name)
            except Exception:
                state['failure_shutdown'] = {'clean': False, 'requiresOperatorReview': True}
        state['phase'] = 'failed'
        state['error'] = str(error) if isinstance(error, AssertionError) else type(error).__name__
        atomic(args.audit / 'transaction.json', state)
        print(json.dumps({'passed': False, 'phase': 'failed', 'audit': str(args.audit),
                          'sourceReadOnlyByTool': True, 'failedTargetRetained': True,
                          'error': state['error']}))
        return 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({'passed': False, 'error': str(error) if isinstance(error, AssertionError) else type(error).__name__,
                          'rawDiagnosticsWithheld': True}))
        raise SystemExit(1)
