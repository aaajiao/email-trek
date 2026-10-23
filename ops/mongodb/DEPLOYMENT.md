# Deployment acceptance: 2026-10-23

Both production databases completed the reviewed six-stage migration on fresh
isolated copies and are running MongoDB8.0.34 with FCV8.0. All original business
BSON, natural order, collection options, UUIDs, indexes and authentication metadata
passed the preserved-baseline comparisons. The original data directories were verified unchanged during the migration
and subsequently retired after acceptance as recorded below. Correct-password authentication succeeded; wrong-password and anonymous
authentication were rejected.

Application and public acceptance passed:

- Bot: real login, 7 projects, 83 items and 7 players passed readback checks with
  matching data hashes. The retained front end is served by the updated runtime.
- Email Trek: the recent-detail window contains 100,000 records. At the cutover
  audit, permanent cumulative statistics totalled 99,249,437. The first and last
  2,000-record pages retained their full stored addresses; only aggregate/hash
  evidence is published, never those addresses.
- The original 57 UI/static files were unchanged. Independent public acceptance
  passed 17/17 serial GET checks covering HTML, TLS, selected original static bytes,
  anonymous 401 denial and HTTP-to-HTTPS redirects.
- This migration's tests sent zero SMTP messages. Existing durable mail budgets
  and one-shot state were retained, and automatic sending remains disabled.

The public GET suite did not execute browser JavaScript, open Socket.IO, log in,
submit forms or send mail. Authenticated application checks were performed
separately by the operator. Detailed private data and deployment receipts remain
outside Git. Both MongoDB healthchecks now run every 60 seconds instead of every
10 seconds; their commands, timeouts, retry counts and startup grace periods were
preserved. The database containers were recreated one at a time with the same
MongoDB8 image and upgraded data directories. Both became healthy, with zero
automatic restarts observed. The final 64-second observation recorded no OOM
events or swap-out activity, a median CPU idle time of 97%, and 263 MiB of
available memory at its end. All four application/database containers remained
running with zero automatic restarts. Reviewed intermediate database/verifier
images and transfer archives were removed, reclaiming approximately 3.06 GB and
leaving approximately 7.02 GB free. Active data and the previous recovery generation
were retained at the migration handoff; the owner subsequently approved the
limited retirement below.

The tools here are generic. They do not include the private production cutover
wrapper, database contents, credentials, private Compose files or host paths.
A rehearsal copy is not interchangeable with the final stopped-writer snapshot.

## Owner-approved retirement after acceptance

On 2026-10-23 the owner explicitly requested removal of the inactive original
databases after the successful upgrade. Both original MongoDB4.4 data directories
and the unreferenced MongoDB4.4.2 image were removed. Before deletion, their hashes
matched the frozen migration baseline; all container mounts, Compose entries,
process file references and nested mounts were checked to exclude active use.

The cleanup did not stop or recreate a service. The active MongoDB8 data and
application configuration were preserved, and the container identities stayed
unchanged. This additional cleanup reclaimed approximately 1.55 GB, leaving
approximately 8.57 GB free. Migration audit records and existing Linode backups were preserved; no new
database backup was made. Final host housekeeping subsequently retired the
remaining old runtime/cold-data staging copies and duplicate media backup; see
[the shared-host record](../shared-host/README.md#completed-staging-cleanup).
The original uncompressed data directories are no longer available for rollback.

Post-cleanup real login, all 7 Bot projects/83 items/7 player responses and the
first/last 2,000-record Email Trek exports passed with unchanged content hashes.
Keep current mail budgets and new business writes intact in any future recovery;
never point an older MongoDB binary at the active upgraded database directories.
