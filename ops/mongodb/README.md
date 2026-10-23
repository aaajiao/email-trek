# Offline MongoDB copy migration

This operator tool rehearses an existing standalone WiredTiger database on a new
copy. It does not deploy production configuration. Default execution is a dry run;
`--apply` is required to create or modify the new target. No original source is
mounted writable. There is no automatic schedule, public port or SMTP operation.

The reviewed amd64 chain is **4.4.2 → 4.4.30 → 5.0.33 → 6.0.28 → 7.0.45 → 8.0.34**.
The original 4.4.2 binary establishes the content baseline before any patch or major
upgrade. `image-chain.json` records exact registry references and local image IDs.
The script uses the checked image IDs with `--pull never`; acquire and verify these
images separately. The EOL intermediates are temporary isolated steps, not supported
long-term production targets. MongoDB8.0 has published support through October2029.

## Preconditions

- A verified private **cold** backup from cleanly stopped MongoDB instances, including
  `db` and `configdb`. Copying live WiredTiger files is not a consistent backup.
- A Docker29+ engine and amd64-capable execution. On ARM Macs, test the exact amd64
  binaries under the installed emulator before using real copies. Rehearsal does
  not prove production memory or kernel compatibility.
- One immutable source volume or source bind directory, plus a new target volume or
  target bind directory. The script rejects an existing target and running writers
  to the source. Source subpaths must be relative and contain no traversal.
- Enough RAM and disk for one working database copy, the original archive, an
  optional clean checkpoint and the current image. Only one migration `mongod`
  runs at a time. Do not run extra databases alongside a full1GB production host.
- A fixed verifier image built from this directory. It contains no application
  configuration, recipient, account, password or production data.

Build the verifier with the pinned official Node24.22.1 base and npm lockfile:

```sh
docker build --platform linux/amd64 -t mongo-copy-verifier:reviewed verifier-build
docker run --rm --network none --read-only mongo-copy-verifier:reviewed --self-test
docker image inspect mongo-copy-verifier:reviewed --format '{{.Id}}'
```

The build uses `npm ci --ignore-scripts`; MongoDB driver7.7.0 is fixed. Pass the
reported full `sha256:` image ID to the operator. Use a private Linux named volume
for active WiredTiger files, rather than a macOS shared folder. Private backups can
be streamed into the source volume without exposing filesystem paths to containers.

## Run and inspect

Replace the example names and subpaths with the verified private backup layout.
The audit directory must be an absolute private path which does not yet exist.

```sh
python3 migrate-copy.py \
  --source-volume private-cold-source \
  --source-subpath project/mongo/db \
  --source-config-subpath project/mongo/configdb \
  --target-volume codex-mongo-project-rehearsal-v1 \
  --audit /private/rehearsal/project-v1 \
  --verifier-image sha256:REVIEWED_VERIFIER_IMAGE_ID
```

This first command only checks metadata. After reviewing its output, add
`--apply --stop-after 4.4.2` to copy and inspect the original-version baseline.
Review its collection counts, hashes and clean shutdown, then repeat the same
parameters with `--apply --resume` to continue the remaining stages. `--copy-only`
creates and verifies a copy without starting a database. `--source-bind` and
`--target-bind` are alternatives for Linux host directories. Never bind a live
production data directory as a target.

Each stage runs with `--network none`, loopback binding, no published port and
`--noauth`. This is only for the isolated private copy. The verifier joins that
container's network namespace and connects solely to127.0.0.1. Final production
must retain its original authentication and application credentials; this tool
never disables production authentication. Legacy `mongo` reads its script through
stdin; `mongosh` uses its stdin file mode. Credentials, if a future reviewed caller
uses the helper's auth argument, stay off process arguments, environment and disk.

The clone disables its TTL monitor to prevent background expiration while comparing
data. It does not change stored TTL definitions. Invalid TTL values and invalid
`system.buckets.*` namespace structure fail verification. Production restoration
must use the reviewed normal TTL setting, not inherit rehearsal-only flags blindly.

## What is preserved

The fixed verifier reads raw BSON in bounded batches. It checks all material
collections for exact document count, raw-byte count, a duplicate-preserving content
hash and a natural-order hash. Capped collection limits and order, indexes, options,
UUIDs and user/role system collection hashes are compared before and after every
FCV step. Full collection validation must succeed without warnings. The exact
official WiredTiger table-busy transient warning permits at most three full
validation attempts with short delays; other warnings are neither retried nor
ignored. Retry counts and initial warning hashes are retained. See
`validation-transient-evidence.json` for the exact scope and official source.

Index comparison ignores only the historical namespace field after checking it and
the boolean background-build scheduling flag. Compound-index key order is retained.
The FCV document alone is excluded from `admin.system.version`; `authSchema` and
other records remain hashed. Explicitly excluded ephemeral data is `local.*`,
`config.system.sessions` and profiling records. No business collection is excluded
by database name. User/role documents and credentials are never printed.

One narrowly checked addition is permitted: MongoDB6's FCV upgrade creates
`config.system.preimages` with its internal clustered `_id` index. If this namespace
was absent from the original baseline, the reviewed6/7/8 stages may contain it only
when empty, noncapped, fully valid without warnings, and with the exact expected
options and sole index hashes. Other added collections fail. If it existed in the
source, its original data and metadata remain subject to all strict comparisons.
The official creation code and independently calculated expected hashes are in
`preimages-compatibility-evidence.json`. Before/after-FCV verifier reports are saved
before comparing so a failed check can be investigated without reopening the copy.

Before each next major, the prior FCV is required. Version7/8 FCV commands include
`confirm:true`. After each actual FCV increase settles, the same copy is cleanly
stopped and reopened with the same pinned binary before final validation. The
recovered FCV must equal the target and a `midFCVRestart` receipt records this check.
This does not run repair, rebuild indexes or alter FCV again. It is an operator
recovery check, not a mandatory vendor upgrade step; see
`mid-fcv-restart-evidence.json`. Each stage must finish with the intended FCV and a clean exit0 before
its container is removed. MongoDB startup warning categories are recorded without
raw message content. No host sysctl, THP or memory-policy setting is changed.

The source's selected file manifests are checked during copy and again after the
completed or intentionally paused run. Audits contain counts, hashes and safe
status metadata, not raw business records. Keep the entire audit private anyway.

## Failure and rollback boundary

The intended container name is recorded before creation, so a Docker CLI timeout
does not hide a possibly started database. Failure handling stops only that stage
and retains the target and audit. A failed target cannot be automatically resumed:
review it and create another new copy. Clean copied/paused states can resume with
identical storage, image and verifier inputs.

Never point an older binary at upgraded data files. The rollback is the untouched
original data/runtime pair, not an unsupported binary downgrade. Before accepting
new production writes that pair can be restored. After accepting writes, reverting
to an older cold backup loses data and requires a separate reconciliation plan.
Durable mail budgets, consumed one-shot run IDs, authentication revocations and
application state must not be reset during a rollback.

Perform the final production copy and cutover through a separate reviewed private
operator wrapper, after stopping writers and taking a fresh consistent backup.
Do not activate an older rehearsal copy after production has continued receiving
writes. Database users/roles, application credentials, media, permanent totals and
bounded detail-window metadata all remain part of final acceptance.

Local validation is documented separately from real migration results. Passing
unit tests or a dry run alone does not establish a successful database upgrade.

## Retain one rollback generation

Keep the freshly captured original data, its exact original runtime image, private
Compose/configuration snapshot, and verification audit as one rollback generation
until the new database and both applications pass acceptance. Do not overwrite it
with a newer rehearsal. Temporary intermediate images and failed copy volumes can
be removed later only by an operator after checking exact names and references;
this tool has no prune command or automatic retention job. Retaining that one
generation does not justify resetting application budgets or losing later writes.
