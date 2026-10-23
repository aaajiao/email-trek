# MongoDB driver compatibility

The source pins `mongodb@7.7.0` on Node 24.22.1. The production server upgrade to MongoDB **8.0.34**, feature compatibility **8.0**, completed on 2026-10-23. Socket.IO, Nodemailer, Express, the UI and other unrelated dependencies retain their existing lockfile versions. Only MongoDB and its required dependency subtree changed.

The [official driver upgrade guide](https://www.mongodb.com/docs/drivers/node/current/reference/upgrade/) documents the removed connection options and the document-or-null compound-operation result. Driver 7.6 and later require MongoDB 4.4 or newer; the [7.7.0 package metadata](https://registry.npmjs.org/mongodb/7.7.0) requires Node 20.19 or newer. These minimums do not replace application tests or the server's required sequential major-version/feature-compatibility upgrade procedure.

## Application changes

- `lib/mongo.js` removes the obsolete `Logger`, `useNewUrlParser` and `useUnifiedTopology` APIs. The client explicitly retains a five-connection pool. Debug command monitoring logs command names only, not stored addresses or command bodies.
- `lib/boundedStore.js` uses `returnDocument: 'after'` and `includeResultMetadata: false`; a null result still rejects a lost atomic commit. Counter increments and the pending detail remain one atomic operation.
- Durability is explicitly nested as `writeConcern: { w: 1, journal: true }`. Driver 7 ignores the old top-level `w`/`j` options. Actual commands must still send `{ w: 1, j: true }` to the server.
- The maintenance CLIs use supported connection options with one connection. ObjectId checks use the exported class rather than an old BSON type-name string. The historical retirement guard, expected hashes and explicit execution requirements are not relaxed; it will refuse a source baseline it was not pinned to.

There is no collection/schema migration in this patch. `mail_recent_v1` remains capped at 100,000 records and 128 MiB; newest-first exports remain sorted by `_id`. Permanent counts and `newCounts` remain separate from retention. A committed pending record is replayed by `$setOnInsert` upsert, checked for identity, then cleared with journal acknowledgement. This avoids evicting another capped row on duplicate replay. This design supports one application writer process, not multiple independent PM2 writers or a cluster. Arbitrary client retries of a completed `insertOne` are not deduplicated; the recovery guarantee concerns the persisted pending event.

The source does not change SMTP behavior, status meaning, the automatic-send switch, quota files or consumed test-run identities. Preserve the existing private configuration and state mounts byte for byte during any deployment. Never restart the legacy writer or reset counters/budgets to make validation pass.

## Verification

On official Node 24.22.1/macOS arm64, the following passed with synthetic records and no real mail calls:

- 24 existing application regressions, including API, queue, SVG/full-address output, ASCII masking and migration behavior.
- 22 existing pacing/budget cases. These portable tests inject the lock operation; the previous Linux real-flock verification remains separate historical evidence.
- 10 new offline driver cases using the actual 7.7 parser and command builder: durability encoding, atomic update/result semantics, null rejection, pending replay/conflict, 100 concurrent calls and masked ASCII.
- 12 real-database cases on local official amd64 MongoDB **4.4.30** and **8.0.34** containers. Each run checked 100 concurrent calls, six before/after crash boundaries, recovery in a separate Node process, no-match rejection, all 100,000 capped records, natural-order retention, non-evicting pending replay and the final 2,000-record SVG page. Each observed 332 application write commands with `{w:1,j:true}`; fixture databases were removed afterwards.

The 4.4 fixture used 4.4.30, not the earlier production patch 4.4.2. No production database or SMTP connection was made by these tests. They do not certify historical data migration, authentication against production, disk/RAM headroom or a server restart; those remain operator checks with backups and comparisons.

The final private Linux amd64 candidate image also passed all 80 cases above (24 + 22 + 10 + 12 + 12), with the pacing suite using the real kernel flock. Its driver was freshly installed from the frozen lockfile; the five-connection setting, global PM2 version and inherited runtime configuration were checked, and the 19 bundled public files were byte-identical to the source image. All five baked manifest/lock/source files matched the candidate hashes. Installation omitted optional dependencies and lifecycle scripts; the installed lifecycle hooks were core-js funding banners, while the optional nodejieba addon is not used by the application's pinyin paths. Non-segmenting pinyin was exercised in the final image. The existing production source mounts must still be retained or updated as described below: a retained image alone does not include all currently mounted patches.

`yarn test` runs the offline suites. The real-database test is explicitly separate and rejects non-loopback URLs, credentials, arbitrary database names and missing write opt-in:

```sh
EMAILTREK_TEST_MONGO_URI=mongodb://127.0.0.1:37080 \
EMAILTREK_TEST_MONGO_ALLOW_WRITES=fixture-only \
EMAILTREK_TEST_MONGO_VERSION=8.0.34 \
yarn test:mongodb:integration
```

It checks that a random `emailtrek_driver_fixture_*` database does not already exist, creates it, writes only synthetic records and drops only that database afterwards. Cleanup requires the current process's successful creation marker; a name collision or ambiguous creation failure is preserved for review. Run it only against a dedicated disposable local MongoDB server. It never loads `config.js`, starts the application, opens Socket.IO or calls SMTP.

## Deployment boundary

The tested private retained-image recipe is [Dockerfile.database-upgrade](../ops/runtime/Dockerfile.database-upgrade). It preserves the original app/PM2/static tree and installs only the new frozen production dependencies in a separate stage, then replaces the three reviewed source files. Its companion Dockerfile-specific ignore file admits only the manifest, lock and those three sources; private config, environment files, state, Git history and database files are excluded from the build context. Run from this repository's root only after the exact retained private source image has been verified locally:

```sh
docker tag sha256:ae47f20666fe103a1e0bc98ff9b785aee07aac97cde8f93212fba5d9cfab3139 archive-local/emailtrek-node24-retained:ae47f20666fe
docker build --platform linux/amd64 --pull=false \
  -f ops/runtime/Dockerfile.database-upgrade \
  -t archive-local/emailtrek-driver7:mongodb-7.7.0-candidate .
```

This is not a standalone public source-build image: the base and output can contain historical private configuration inside existing layers. Keep both private and never push them to a public registry. The normal runtime command, global PM2 installation and other image configuration are inherited unchanged.

The live application needs the matching `lib/mongo.js`, `lib/boundedStore.js` and a dependency image rebuilt from the matching `package.json`/`yarn.lock`; changing only the manifest or source files is insufficient. `lib/migrate-storage.js` is also an existing mounted source and must be updated to match the image/repository, without running its migration commands. Validate the installed driver version and hash every source mount before recreating only the authorized application container. The historical `ops/storage/` CLI changes and tests/docs do not need to be loaded by the live process. Existing bind mounts can override files baked into an image, so review their exact paths rather than assuming a new image changes the running source.

Keep the old immutable application image, source mounts and cold database backup for the reviewed rollback boundary. Do not attach a database already upgraded to a new incompatible format to an old server binary. Production readiness requires a separate receipt for the final server version/FCV, credentials and topology, capped options, counters/pending state, record hashes/order, application pages/exports, automatic-send-off state and unchanged persistent budgets. This document's local test pass is not that deployment receipt.

## Production verification on 2026-10-23

The operator migrated fresh cold copies through each required server/feature-compatibility step, retained the original data, and checked the final database against the captured baseline before reopening public access. Original application credentials were verified; anonymous and wrong-password access were rejected. Collection content, natural order, indexes and UUIDs were compared, together with the capped window, permanent counters and pending state. The first and last 2,000-record export pages retained the complete stored addresses. Matching dependency and source hashes were checked in the running application.

After public service resumed, fixed serial HTTPS checks passed for the homepage, Mail You and SVG pages, their unchanged JavaScript/CSS assets, valid certificates and HTTP redirects preserving paths and query strings. These checks did not execute JavaScript, open Socket.IO, submit a Mail You request or send mail. Automatic delivery stayed disabled and existing private configuration, SMTP budgets and consumed one-shot markers were preserved. Public access now permits legitimate new activity, so reverting to the old database snapshot is no longer an automatic rollback option; any later recovery must account for new writes.

The owner subsequently approved removal of the inactive original database directories and the unused MongoDB4.4.2 image after acceptance. Active MongoDB8 data was preserved. See [the deployment retirement record](../ops/mongodb/DEPLOYMENT.md#owner-approved-retirement-after-acceptance) for the current recovery boundary.
