# Deployment acceptance: 2026-10-23

Both production databases completed the reviewed six-stage migration on fresh
isolated copies and are running MongoDB8.0.34 with FCV8.0. All original business
BSON, natural order, collection options, UUIDs, indexes and authentication metadata
passed the preserved-baseline comparisons. The original data directories remain
unchanged. Correct-password authentication succeeded; wrong-password and anonymous
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
were retained.

The tools here are generic. They do not include the private production cutover
wrapper, database contents, credentials, private Compose files or host paths.
A rehearsal copy is not interchangeable with the final stopped-writer snapshot.

Keep one rollback generation: the untouched original databases, their matching
old database image, the corresponding application/runtime and private configuration
snapshot, plus the migration verification records. Keep these outside Git. Never
start an old MongoDB binary against the upgraded data directories, and never allow
old and new writers to use the same directory.

Public service has resumed. Reverting to the old snapshot would discard subsequent
writes; a reviewed reconciliation/recovery plan is required instead. Mail budgets, consumed
one-shot run IDs and other durable application state must remain current through
any rollback. Remove excess failed rehearsals and intermediate images only after
acceptance and an exact reference check; keep the one approved rollback generation.
