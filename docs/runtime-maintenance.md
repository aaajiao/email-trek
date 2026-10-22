# Node runtime maintenance

This maintenance changes the Node runtime while preserving the installed application dependency versions and existing build artifacts. The baseline is official Node 24.22.1 Alpine, pinned to `sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53`. The [21 October 2026 Node security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases) identifies 24.22.1 as a patched release, including the Brotli decoder RCE fix. This statement concerns that runtime patch baseline; it does not certify the old application packages, MongoDB, Docker, or host OS as secure.

## Two different build claims

`Dockerfile.email-runtime` and `Dockerfile.bot-runtime` are retained-server-image migration recipes. They require the original private image to exist locally. They copy its installed `/app` tree, including `node_modules` and the Bot's already-built Nuxt artifacts, onto the new official runtime. They do not install or upgrade application packages. The Email recipe removes two unrelated public installers in the intermediate legacy stage before copying the final app: `public/js/robo3t-1.4.2-darwin-x86_64-8650949.dmg` and `public/js/Secure-SHell-0.8.0.alfredworkflow`. No other public asset is removed; the installers are therefore absent from the final app layer rather than merely hidden by a later deletion layer. The repository recipe additionally removes unused `lib/mailBlue.js`, an unreferenced old Sendinblue demo. That additional deletion is a future-rebuild cleanup; the already-tested runtime image was not rebuilt just for it, and the production application does not load that module. Email also preserves its existing global PM2 4.5.0 and its command. Bot had no PM2. Its original `npm start` → `nuxt start` CLI uses an esm3 configuration hook that fails on Node24. The tracked `nuxt-node24.cjs start` entrypoint loads configuration through native CommonJS and uses Nuxt’s already-installed jiti loader for ESM-style modules; it retains the existing Nuxt server and build artifacts. HOST/PORT overrides remain supported and the default listener is 0.0.0.0:3000.

These retained-image recipes and the separately tested fresh-source recipes are distinct artifacts. The source-build verification installed frozen-lockfile production Email dependencies and rebuilt Bot on official Node24.22.1 on macOS. That separate result is not inferred from copying an existing image. A source build needs the matching application source, package manifest, lockfile, environment contract, and independent installation/build verification. The server's Mongo-based Email Trek source differs from the older RethinkDB code previously in GitHub; use the captured current source baseline and reviewed patches, not that older runtime.

The Bot repository supplies `ops/runtime/Dockerfile.bot-runtime` plus its exact non-secret `nuxt-node24.cjs` context dependency. The Email repository supplies `ops/runtime/Dockerfile.email-runtime`. Run each command from that project’s own `ops/runtime/` directory on the authorized server, after verifying the original private image ID and the pinned Node base are already available locally. Bot’s `.dockerignore` allows only its wrapper; Email’s excludes all local context. These are private retained-image migration recipes, not standalone public source-build images:

```sh
docker build --network none --pull=false -f Dockerfile.email-runtime -t archive-local/emailtrek-node24:reviewed .
docker build --network none --pull=false -f Dockerfile.bot-runtime -t archive-local/bot-node24:reviewed .
```

An alternate local image may be supplied with `--build-arg LEGACY_IMAGE=...`, but its dependency versions and source hashes must be checked first. The reviewed application patch files are tracked separately in the deployment manifest and are mounted or copied explicitly. No unmanaged `node_modules` patch mount is required.

## Private configuration and data

The retained `/app` tree may include original configuration or `.env` files. The resulting compatibility images remain private on the existing server. Do not push them to a public image registry, export them into Git, or commit configuration, uploads, database samples, archive files, JWT/SMTP secrets, or maintenance-state files. The Dockerfiles themselves contain no credentials. A future source-built image should take private configuration through controlled environment variables or read-only secret mounts, with state on dedicated persistent mounts.

Keep the existing Mongo data volume. Keep `/app/maintenance-state` on a dedicated host mount with directory mode 0700 and state/key files 0600. Email's PM2 watch configuration excludes that directory. Bot's revocation store uses `/usr/bin/flock -x 3`; the tested Alpine image already supplies that command via BusyBox, so no extra package was installed.

## Compatibility boundaries

On this server, official Bookworm's basic Node process failed to create a thread under the existing Docker default seccomp policy. Alpine's Node 24.22.1 process and Worker both started successfully without a security-policy override. Alpine uses musl, as described by the [official image documentation](https://github.com/nodejs/docker-node/blob/main/README.md#nodealpine). No `seccomp=unconfined`, daemon change, host upgrade, or production restart was used to obtain the successful probe.

Email's pinyin 2.9.1 default conversion works on the new runtime. Its old nodejieba 2.5.1 native binary is optional and loaded only when segmentation is requested; the existing address generator does not request segmentation. That unused binary has not been declared portable. The separate fresh-source production install passed with Yarn1.22.22 `--frozen-lockfile --ignore-optional`, and its default pinyin path plus 1000 synthetic generated addresses passed with network attempts blocked.

The retained Bot runtime preserves Nuxt 2.14.12, Webpack 4.44.2 and the existing build. The independent clean source build required Webpack 4.47.0, the compatible patch in the same major version, to avoid old MD4 hashing errors under modern OpenSSL. The CommonJS wrapper also provides a build-only compatibility path for two old package metadata exports. That clean build and seven offline build-contract checks passed. No legacy OpenSSL provider or broader runtime crypto mode is enabled.

## Verification and rollout

Run `verify-runtime.py` manually to record the actual image/runtime/dependency versions without loading application configuration, opening database connections, or sending mail. Its default image probes use no network and a read-only filesystem. `--live` reads the same metadata inside named running containers after deployment. The script does not deploy, update, schedule monitoring, or claim application-level safety.

Before switching production, run the Email queue, quota, SMTP, API and migration fixtures and the Bot authentication/revocation fixtures on the selected runtime. Then perform one complete isolated Nuxt startup and an Email PM2 process test. Serialize these operations: the host has about 1 GB RAM, and the historical database scan must finish before starting another full application. Match every deployed patch hash to its manifest.

After switching, verify actual running Node versions, process health, website assets, public views, authentication, authorized editing, Socket events, SVG export and Mail You response behavior. A successful build or a container listed as running is not that verification. Preserve the old image and application files for rollback. Never restart the legacy Email writer against its old collection after new writes have begun without reconciling the new records and cumulative statistics.

## Current evidence

Private maintenance evidence records the selected immutable images and completed tests; it is intentionally kept outside the public repositories. The official Alpine base, Worker startup, Email pinyin and PM2 version, and Bot's existing JWT signing/verification and core module loading were verified. Email’s integrated 24-test suite has passed on Node24 using both fresh Mac dependencies and the retained-dependency Linux image. Email’s actual entrypoint starts under PM2 4.5.0 and serves the fixture API. Bot passed 57 authentication/revocation checks, and the new repository `test/auth-hardening.js` independently passed all 57 on the final Linux image. A complete Nuxt startup with its retained build also passed: homepage, login page and a built JS asset returned 200; synthetic login, authorized user and logout returned 200; replay after logout returned 401. All these Linux tests used network-none isolation and no production database or SMTP calls. No production deployment was performed by this compatibility preparation.

## Runtime switching and shared operations

The runtime switch is a separate reviewed operator action after the storage and source migrations. A retained-image build or fixture success is not a claim that production has switched. Preserve original private Compose bytes and image IDs, require source/state mounts, keep effective application settings and all data volumes, and verify runtime versions plus the unchanged peer/database containers after any switch. Do not run the legacy Email writer after the new store has accepted writes. The final operator tool and its deployment result must be reviewed separately before use.

Shared certificate renewal, port guards, Docker log limits, Nginx/Longview rotation and the Longview UID patch are mirrored in both repositories under `ops/shared-host/`. Install them only once on their common host. These files do not add alerting or scheduled monitoring.
