"""Run remotely with Python3.5; modifies only the approved Longview files."""
import datetime
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

ROOT = Path('/root/maintenance-archives/2026-10-22/bot-emailtrek-host-logs')
SOURCE = Path('/opt/linode/longview/Linode/Longview/DataGetter/Processes.pm')
LOG = Path('/var/log/linode/longview.log')
ROTATE = Path('/etc/logrotate-longview.conf')
SERVICE = Path('/etc/systemd/system/longview-logrotate.service')
TIMER = Path('/etc/systemd/system/longview-logrotate.timer')
STATE = Path('/var/lib/logrotate/longview.status')


def run(args, timeout=30):
    p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       universal_newlines=True, timeout=timeout)
    return {'argv': args, 'exit_code': p.returncode,
            'stdout': p.stdout.strip(), 'stderr': p.stderr.strip()}


def required(args, timeout=30):
    r = run(args, timeout)
    if r['exit_code']:
        raise RuntimeError('Command failed: ' + ' '.join(args) + '\n' + r['stderr'])
    return r


def stats(path):
    s = path.stat()
    return {'bytes': s.st_size, 'allocated_bytes': s.st_blocks * 512, 'inode': s.st_ino,
            'mode': oct(s.st_mode & 0o777), 'uid': s.st_uid, 'gid': s.st_gid}


def private_write(path, text):
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(text)


TEST = r'''
use strict;
use warnings;
use JSON::PP qw(encode_json);
BEGIN {
    package Linode::Longview::Util;
    use Exporter 'import';
    our $PROCFS = '/fixture/';
    our $TICKS = 100;
    our $logger = bless {}, 'TestLogger';
    our $TEST_UID;
    our @EXPORT_OK = qw(slurp_file $PROCFS $logger $TICKS);
    our %EXPORT_TAGS = (BASIC => [qw(slurp_file $PROCFS $logger)]);
    sub slurp_file {
        my $path = shift;
        if ($path =~ m{/status$}) {
            return ('Name: fixture', 'Pid: 123', 'PPid: 1',
                (defined $TEST_UID ? "Uid: $TEST_UID\t$TEST_UID\t$TEST_UID\t$TEST_UID" : ()),
                'VmRSS: 16 kB');
        }
        if ($path =~ m{/stat$}) {
            my @v = (0) x 24; @v[13,14,21] = (10,5,100); return join(' ', @v);
        }
        return "fixture\0" if $path =~ m{/cmdline$};
        return ('read_bytes: 1024', 'write_bytes: 2048') if $path =~ m{/io$};
        return '10000 10000' if $path =~ m{/uptime$};
        die 'Unexpected fixture request';
    }
    $INC{'Linode/Longview/Util.pm'} = 1;
}
{ package TestLogger; sub trace {} }
my $file = shift @ARGV;
require $file;
my @results;
for my $case ([0, 'root'], [999, 'uid-999'], [undef, 'unknown']) {
    local $Linode::Longview::Util::TEST_UID = $case->[0];
    my $ok = eval {
        local $SIG{__WARN__} = sub { die @_ };
        my %info = Linode::Longview::DataGetter::Processes::process_info(123);
        die 'Wrong user label' unless defined $info{user} && $info{user} eq $case->[1];
        no warnings 'redefine';
        local *Linode::Longview::DataGetter::Processes::process_list = sub { return (123) };
        my $data = {LONGTERM => {}, INSTANT => {}};
        Linode::Longview::DataGetter::Processes::get(undef, $data);
        die 'Missing process metric' unless $data->{LONGTERM}->{"Processes.fixture.$case->[1].count"} == 1;
        1;
    };
    push @results, {label => $case->[1], passed => $ok ? JSON::PP::true : JSON::PP::false,
                   error => $ok ? '' : "$@"};
}
print encode_json(\@results), "\n";
exit(grep(!$_->{passed}, @results) ? 1 : 0);
'''


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    os.chmod(str(ROOT), 0o700)
    if (ROOT / 'before.json').exists():
        raise RuntimeError('Existing maintenance record: inspect before rerunning')
    for p in [ROTATE, SERVICE, TIMER, STATE]:
        if p.exists():
            raise RuntimeError('Refusing to overwrite existing ' + str(p))
    original = SOURCE.read_text()
    needle = '\t$proc{user}  = ( getpwuid( $proc{uid} ) )[0];'
    if original.count(needle) != 1:
        raise RuntimeError('Expected source line does not match')
    replacement = (
        '\t# Container UIDs may have no passwd entry on the host; retain their metrics.\n'
        '\t$proc{user} = defined($proc{uid}) ? ( getpwuid( $proc{uid} ) )[0] : undef;\n'
        "\t$proc{user} = defined($proc{uid}) ? 'uid-' . $proc{uid} : 'unknown'\n"
        '\t\tunless defined($proc{user});')
    result = {'started_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'backup_directory': str(ROOT), 'log_before': stats(LOG),
              'source_before_sha256': hashlib.sha256(original.encode()).hexdigest(),
              'source_mode_before': stats(SOURCE),
              'new_files': [str(p) for p in [ROTATE, SERVICE, TIMER]],
              'service_before': run(['systemctl', 'is-active', 'longview'])}
    private_write(ROOT / 'before.json', json.dumps(result, indent=2) + '\n')
    private_write(ROOT / 'Processes.pm.original', original)
    private_write(ROOT / 'fixture-test.pl', TEST)
    before_test = run(['perl', str(ROOT / 'fixture-test.pl'), str(SOURCE)])
    result['fixture_before'] = json.loads(before_test['stdout'])
    if result['fixture_before'][0]['passed'] is not True or result['fixture_before'][1]['passed'] is not False:
        raise RuntimeError('Expected baseline known UID pass / unmapped UID failure not reproduced')
    patched = original.replace(needle, replacement)
    SOURCE.write_text(patched)
    os.chmod(str(SOURCE), int(result['source_mode_before']['mode'], 8))
    try:
        after_test = required(['perl', str(ROOT / 'fixture-test.pl'), str(SOURCE)])
        result['fixture_after'] = json.loads(after_test['stdout'])
        result['syntax'] = required(['perl', '-I/opt/linode/longview', '-c', str(SOURCE)])
    except Exception:
        SOURCE.write_text(original)
        raise

    ROTATE.write_text('''/var/log/linode/longview.log {
    daily
    maxsize 10M
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
''')
    SERVICE.write_text('''[Unit]
Description=Rotate only the Longview monitoring log

[Service]
Type=oneshot
UMask=0077
ExecStart=/usr/sbin/logrotate --state /var/lib/logrotate/longview.status /etc/logrotate-longview.conf
''')
    TIMER.write_text('''[Unit]
Description=Check Longview log rotation hourly

[Timer]
OnCalendar=hourly
AccuracySec=1min
Persistent=true
Unit=longview-logrotate.service

[Install]
WantedBy=timers.target
''')
    for p in [ROTATE, SERVICE, TIMER]:
        os.chmod(str(p), 0o644)
    result['logrotate_debug'] = required(['logrotate', '--debug', '--state', str(STATE), str(ROTATE)])
    result['unit_validation'] = required(['systemd-analyze', 'verify', str(SERVICE), str(TIMER)])

    # Only the monitoring agent is stopped. Preserve this log inode and a small complete-line tail.
    pid_file = Path('/var/run/longview.pid')
    previous_pid = int(pid_file.read_text().strip())
    result['agent_pid_before'] = previous_pid
    result['stop'] = required(['systemctl', 'stop', 'longview'], timeout=40)
    if run(['systemctl', 'is-active', 'longview'])['stdout'] != 'inactive':
        raise RuntimeError('Longview did not stop; refusing to truncate')
    for attempt in range(140):
        if not Path('/proc/' + str(previous_pid)).exists():
            break
        time.sleep(0.25)
    else:
        raise RuntimeError('Previous Longview PID still exists; refusing to truncate')
    try:
        with LOG.open('rb') as f:
            f.seek(max(0, LOG.stat().st_size - 1024 * 1024))
            sample = f.read()
        sample = sample.split(b'\n', 1)[-1]
        sample_path = ROOT / 'longview-tail-before.log.gz'
        fd = os.open(str(sample_path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as f:
            f.write(gzip.compress(sample, compresslevel=6))
        tail = sample[-65536:]
        tail = tail.split(b'\n', 1)[-1]
        with LOG.open('r+b') as f:
            f.seek(0)
            f.write(tail)
            f.truncate()
            f.flush()
            os.fsync(f.fileno())
        result['log_after_compaction'] = stats(LOG)
        result['inode_preserved'] = result['log_before']['inode'] == LOG.stat().st_ino
        result['compressed_sample'] = stats(sample_path)
        # Force only the now-small retained tail, never the original multi-gigabyte log.
        result['bounded_forced_rotation'] = required(
            ['logrotate', '--force', '--state', str(STATE), str(ROTATE)])
    finally:
        result['start'] = required(['systemctl', 'start', 'longview'], timeout=40)

    required(['systemctl', 'daemon-reload'])
    required(['systemctl', 'enable', 'longview-logrotate.timer'])
    required(['systemctl', 'start', 'longview-logrotate.timer'])
    result['service_after'] = required(['systemctl', 'is-active', 'longview'])
    result['timer_after'] = required(['systemctl', 'show', 'longview-logrotate.timer', '-p', 'ActiveState',
                                      '-p', 'NextElapseUSecRealtime', '-p', 'TimersCalendar'])
    result['source_after_sha256'] = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
    result['log_after'] = stats(LOG)
    result['rotated_logs'] = {str(p): stats(p) for p in LOG.parent.glob('longview.log.*') if p.is_file()}
    retained_allocated = result['log_after']['allocated_bytes'] + sum(
        v['allocated_bytes'] for v in result['rotated_logs'].values()) + result['compressed_sample']['allocated_bytes']
    result['log_allocated_bytes_reclaimed_net_of_sample_and_rotations'] = result['log_before']['allocated_bytes'] - retained_allocated
    result['sample_start_utc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    result['sample_start_log_size'] = LOG.stat().st_size
    result['sample_start_log_inode'] = LOG.stat().st_ino
    result['retention_note'] = 'Hourly check; rotate daily or above10MiB when checked; seven rotated files, not necessarily seven days. copytruncate preserves the active log inode. No duplicate daily-global logrotate configuration.'
    private_write(ROOT / 'result.json', json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
