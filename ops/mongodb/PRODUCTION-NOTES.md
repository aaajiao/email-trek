# Production memory and acceptance notes

The copy migrator's memory limits are rehearsal limits, not production defaults.
On a small mixed web/database host, use an explicit `--wiredTigerCacheSizeGB 0.256`
for each MongoDB instance. This limits WiredTiger's internal cache, not all MongoDB
RSS, page cache, allocator or connection memory. Two instances can therefore use
substantially more than twice this amount. A 1 GiB host must pass measured tests;
a successful larger local rehearsal does not establish its capacity.

For a conservative first activation, keep existing production container resource
settings unless a separate reviewed plan changes them. Do not silently copy the
rehearsal `--memory`, `--memory-swap`, `--noauth` or `ttlMonitorEnabled=false` flags.
An arbitrary tight hard RSS limit can kill a healthy database during a temporary
peak. Start the new databases serially, verify authentication and normal TTL, then
start applications while observing host memory available, PSI, swap-in/out, OOM
counters, database RSS and cgroup peaks. Include the largest supported bounded
export, a normal upload and restart/recovery in resource acceptance; mail sending
must stay disabled unless separately authorized.

Keep existing swap on a mixed host; MongoDB recommends vm.swappiness=1. Treat that
as a separately reviewed host change, not an automatic action in these tools.
For MongoDB8, retain/enable THP according to the version8 instructions; old advice
to disable THP applies to version7 and earlier. Review actual startup warnings
for max_map_count, allocator/rseq and file limits before changing host settings.
An operator can use MemAvailable below roughly100 MiB, sustained nonzero full PSI,
ongoing swap I/O, or any OOM event as investigation/rollback gates; these are
conservative operational thresholds, not vendor sizing guarantees. If both
applications cannot pass with stable headroom, expand RAM before accepting writes.
Do not drop caches or clear swap to make a point-in-time reading look better.

Official references:
- https://www.mongodb.com/docs/v8.0/core/wiredtiger/
- https://www.mongodb.com/docs/v8.0/administration/production-notes/
- https://www.mongodb.com/docs/v8.0/administration/tcmalloc-performance/

Rollback retains exactly one untouched original data/runtime/configuration
pair until acceptance. Do not run old and upgraded writers concurrently against
the same data, and do not restore stale mail-budget or one-shot state.
