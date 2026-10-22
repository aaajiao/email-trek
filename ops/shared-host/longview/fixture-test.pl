
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
