# Shared host maintenance for Bot Gluttony and Email Trek

This directory belongs in **both repositories at the same revision**, for example `ops/shared-host/`. The two projects share one Nginx/Docker host. These files have one host-level owner and are installed **once per host**, regardless of which repository supplies them. Keep both copies byte-identical and compare `manifest.json` hashes when updating either repository. Each project remains responsible for its own app image, private configuration, persistent data, and application-specific security changes.

This package records the maintenance performed on 2026-10-22–23. Packaging it made no server changes. It adds no alert recipients, email notifications, monitoring service, or recurring Codex task. The timers here perform certificate renewal and log rotation; the APT policy schedules package metadata refresh and eligible Ubuntu unattended updates. Vendor package upgrades use a tested maintenance window. Existing Longview monitoring remains in place; its account/API configuration is deliberately excluded. Root SSH login and the SSH configuration are outside this package.

## Contents and installed behavior

| Area | Files | Behavior |
| --- | --- | --- |
| HTTPS | `files/usr/local/sbin/archive-cert-renew`, matching service/timer | Reuses the existing `archive-projects` certificate/account in private `/etc/letsencrypt`; pinned Certbot image; file lock prevents overlapping renewals. Checks at 03:15 and 15:15 in the host timezone, with up to one hour randomized delay. Successful renewal leaves a marker, then the host validates and reloads Nginx. No new account registration is performed by the script. |
| Public ports | `archive-port-guard`, service, Docker drop-in | Host-specific `eth0` IPv4/IPv6 rules protect FTP 21, app 4000/4001 and Mongo 35017/35018. Forward rules cover translated container ports 27017/3000/4000; established forwarded connections return. Guard is re-applied after Docker starts. HTTP/HTTPS and SSH are not blocked by these rules. |
| Container logs | `docker/compose-logging.*.yaml` | All four app/Mongo containers use `json-file`, `max-size: 10m`, `max-file: 3`. Limits take effect when each container is recreated with its original image/config/data mounts. |
| Host Docker default | `docker/daemon-logging.fragment.json` | Existing host fallback is `json-file`, `50m`, three files. This is a JSON fragment to merge, never a replacement for the complete daemon configuration. Per-container 10m settings take precedence. |
| Host and Nginx logs | `archive-logrotate`, matching service/timer, global/rsyslog/Nginx rules and daily cron entry | The hourly timer and daily cron use one `flock` and `/var/lib/logrotate/status`. Nginx rotates daily or above 10MiB when checked, retaining fourteen files; selected system logs use 20MiB checks. Compression is retained; the Nginx hook uses its native log-reopen command while the service is active. These are periodic checks, not continuous hard size caps. |
| Longview UID handling | `longview/unmapped-uid.patch` | Preserves process metrics for container UIDs absent from host passwd: `uid-NNN`; missing UID becomes `unknown`. The historical source hash is pinned below. No Longview account setting changes. |
| Longview logs | Dedicated configuration and service/timer | Hourly check; rotate daily or above 10MiB at check time, seven rotated files, compression, copytruncate, separate state. This is not a strict continuous size cap or guaranteed seven-day retention. The configuration is outside `/etc/logrotate.d` to avoid duplicate daily handling. |
| System journal | `files/etc/systemd/journald.conf.d/30-archive-limits.conf` | Runtime storage target 32MiB, persistent storage target 128MiB, bounded individual files and seven-day retention. Effective after the coordinated host reboot; existing journald storage mode is preserved. |
| Package maintenance | `20auto-upgrades`, vendor sources/keyrings/pins and `99archive-vendor-maintenance` | Daily package-index refresh and eligible Ubuntu unattended-upgrade checks; cache cleanup every seven days. Automatic reboot and unused-dependency removal are disabled. Vendor package upgrades are excluded from unattended installation and require a tested maintenance window. |
| Docker daemon | `files/etc/docker/daemon.json` | Reviewed host settings: classic `overlay2`, containerd image snapshotter disabled, iptables firewall backend, default bridge `172.17.0.1/16`, bounded fallback logs. Preserve project networks and loopback published ports. |

## Installation / adoption

On the already-maintained host, run the read-only verification first and leave matching files in place. Do not rerun the historical cleanup script.

For a reviewed restoration or a new matching host:

1. Back up existing configuration and unit files privately, preserving ownership and permissions. Verify the external interface really is `eth0`, the Docker service names/ports match this package, and Nginx serves the existing ACME webroot `/var/www/acme`. Do not copy this host-specific firewall blindly to a different network layout.
2. Install the reviewed files from `files/` at their corresponding absolute paths, except `files/etc/docker/daemon.json`: that complete host capture is a reference, not an instruction to overwrite an existing daemon configuration. Merge its appropriate settings in step 5 and validate them before a coordinated restart. Use root ownership, mode 0750 for `archive-cert-renew` and `archive-port-guard`, mode 0755 for `archive-logrotate` and `/etc/cron.daily/logrotate`, and mode 0644 for the remaining configurations and units. The manifest records the captured mode and owner for installed files. Do not copy private certificates, renewal-account data, or log contents into Git. The existing certificate/account and webroot must be restored separately from private backup.
3. Validate shell syntax with `bash -n` / `sh -n`, Nginx with `nginx -t`, and the unit files with `systemd-analyze verify`. Validate rotation without rotating logs using `logrotate --debug --state /var/lib/logrotate/longview.status /etc/logrotate-longview.conf` and `logrotate --debug --state /var/lib/logrotate/status /etc/logrotate.conf`. The global configuration deliberately has no stray root-owned path entry that an older parser could mistake for a logfile rule.
4. After review, disable/stop the distribution `logrotate.timer` so the global hourly scheduler has one owner. Run `systemctl daemon-reload`, enable/start `archive-port-guard.service`, `archive-cert-renew.timer`, `archive-logrotate.timer`, and `longview-logrotate.timer`. Do not restart Docker merely to load its drop-in: the live guard can be applied independently, and the drop-in governs the next Docker start. Keep existing app services running during adoption.
5. Merge the Docker **logging mappings** into the existing Compose services. Preserve all image IDs, environment, networks, volumes, restart policy, and data. Edit each existing `ports` list to its loopback-only binding below; do not add a second Compose override port entry, which can retain the old public binding. Container recreation belongs to an approved app deployment with rollback, not to this file-copy step. Likewise, merge the daemon JSON fragment without replacing unrelated keys; loading daemon defaults needs a separately coordinated Docker restart and does not retrofit existing containers.

| Existing container | Required host-to-container binding |
| --- | --- |
| `bot_crazyplayer_1` | `127.0.0.1:4001:3000` |
| `bot_mongodb_1` | `127.0.0.1:35018:27017` |
| `emailtrek_emailtrek_1` | `127.0.0.1:4000:4000` |
| `emailtrek_mongodb_1` | `127.0.0.1:35017:27017` |

Email Trek's PM2 configuration directs its internal `out_file` and `error_file` to `/dev/null`, while pm2-runtime still streams events into Docker's bounded log. Preserve that application-side setting. PM2 file watching is disabled: apply reviewed production source changes by controlled container recreation instead of watching the dependency tree. Do not set `disable_logs: true`, which would also suppress its event stream. Never logrotate Docker-managed JSON log files independently.

## Current operating system and support

The final maintained host is Ubuntu 22.04 after the verified staged transition from 16.04 through 18.04 and 20.04. Ubuntu Pro is not attached. Eligible Ubuntu distribution updates come from the configured Jammy repositories; the APT schedule does not create an extended security entitlement.

Verified runtime packages: Nginx 1.30.6, Docker 29.9.2, containerd 2.4.2. Intermediate package holds were compatibility measures for the OS transition, not a recommendation to retain old dependency versions indefinitely. Maintained dependency versions and necessary source compatibility fixes remain the preferred policy.

## Longview source patch and historical cleanup

The patch targets `/opt/linode/longview/Linode/Longview/DataGetter/Processes.pm`:

- Original SHA256: `5410ff1174a92328357b56d2cf4931bedb97b370b106b67ce219a70935772375`.
- Patched SHA256: `f5e0396b595c087396b02c870534dc91e4b8d933aaec9da9110ab9919531f948`.

If the patched hash is already installed, do nothing. If the original hash matches, first save a private backup, then run `patch --dry-run -d /opt/linode/longview -p1 < longview/unmapped-uid.patch`. Apply the same patch only after the dry run succeeds. Any other hash requires reviewing the installed version; do not force it. Check `perl -I/opt/linode/longview -c /opt/linode/longview/Linode/Longview/DataGetter/Processes.pm` and run the included fixture with that source path. The fixture uses a mocked `/proc` reader and makes no network requests. Its `uid-999` case assumes UID999 has no host passwd entry, as on the maintained host; adapt the fixture UID if validating a different host. Restart only Longview after a successful source/fixture check, and restore the private backup on failure. Keep the active Longview log private (0600); no log sample is included here.

`historical/fix-longview-host-logs-20261022.py` is the exact original one-time maintenance script, retained to account for the work. It patches the source, creates rotation files, briefly stops Longview, saves a private compressed tail, compacts the large historical log, and starts the agent. It is not an idempotent installer, refuses an existing maintenance record/configuration, and must not be run by CI, systemd, or routine upgrades. The original host needed a bounded rotation-fixture/manual continuation after an old logrotate debug quirk; this script alone is not a promise that replaying the historical migration on another host will succeed. Use the declarative files and source patch for normal restoration.

## Network migration follow-up (2026-10-22)

The first boot after the interface migration restored the applications, TLS and database checks, but `networking.service` failed: three residual hooks from the already-removed `ubuntu-fan` package called the missing `fanctl` command. After checking that no active fan configuration remained and backing up the exact files, the residual package configuration was selected for removal with `dpkg --purge ubuntu-fan`. Interface definitions and runtime interface state were not edited, and the failed state was not cleared merely to make the check pass.

Validate this cleanup on the next normal boot: confirm the hooks are absent, `networking.service` succeeds, no units have failed, addresses and the default route are correct, and the existing application/TLS/database health checks pass. The first boot is not evidence that this follow-up boot has passed; that result must be recorded separately.

## Verification and rollback

`sudo python3 verify-installed.py` is read-only and Python3.5-compatible. It verifies installed hashes, timer/guard activation, the four containers' log settings and loopback bindings, and the Longview source hash. It prints no environment, private config, tokens, mail records, or log lines. It does not send HTTP business requests or contact SMTP/Mongo. Exact-source hash mismatch may reflect a later legitimate package update and needs review rather than automatic overwrite.

Also inspect `systemctl list-timers archive-cert-renew.timer archive-logrotate.timer longview-logrotate.timer`, `nginx -t`, and the public HTTPS certificates. A controlled `/usr/local/sbin/archive-cert-renew --dry-run` checks the ACME challenge using the existing renewal setup; this does contact ACME and is not part of the read-only verifier. A live deploy-hook/reload is separate from a dry run. Test public port closure from an external host, while confirming HTTPS and SSH remain reachable. Do not read or publish container environment or certificate private-key files as evidence.

The final post-reboot ACME dry run completed successfully for `bot-gluttony.com` and `email-trek.t-h-e-s-p-a-c-e.com` using the existing renewal configuration. Both names passed simulated renewal against the staging service; no production certificate was replaced. This validates the renewal challenge path without claiming a new production issuance.

Rollback restores the private file backups, then reloads systemd and reapplies only the affected guard/units. Restore container logging/port changes through the original Compose configuration and retained images/data mounts. Never delete volumes or certificate/account state. Do not remove the port guard merely because an app deployment rolls back. No new notification or alerting mechanism is enabled by these files.

## Final Jammy host configuration

Global `/etc/logrotate.conf` includes the distribution snippets without defining wtmp/btmp again. Their reviewed policies are retained in `/etc/logrotate.d/wtmp` and `/etc/logrotate.d/btmp`. The distribution `logrotate.timer` is disabled; `archive-logrotate.timer` supplies the hourly check, with the daily cron path sharing its lock and state. Longview keeps its independent rotation configuration. Validate the complete global configuration, not isolated fragments.

Five obsolete SSH directives that were already ignored were commented out. At the Ubuntu 18.04 compatibility step, the effective `sshd -T` output was byte-identical before and after that cleanup; existing root SSH login and authentication settings were preserved. Validate the installed SSH configuration and service before restarting; this package does not replace sshd_config.

## Current versions and vendor update policy

| Component | Installed checkpoint |
| --- | --- |
| Ubuntu | 22.04.5 LTS |
| Nginx | 1.30.6 |
| Docker Engine | 29.9.2 |
| containerd | 2.4.2 |
| Docker Compose plugin | 5.6.1 |
| Buildx plugin | 0.38.1 |
| Application Node runtime | 24.22.1 |
| MongoDB | 8.0.34, FCV 8.0 |

The host migration initially preserved MongoDB4.4. A separately tested and accepted database upgrade subsequently moved both projects to MongoDB8.0.34 with driver7.7.0 (Bot uses Mongoose9.11.3). See the [database deployment record](../mongodb/DEPLOYMENT.md) for data checks and the final retirement decision.

The six vendor-policy files use official Docker/Nginx Jammy repositories with per-source `Signed-By` keyrings. Version pins permit Nginx `1.30.*`, Docker Engine `29.*`, containerd `2.*`, Compose `5.*` and Buildx `0.*`; rejecting fallback pins prevent an unreviewed branch change. Review these limits before their branches cease to receive relevant fixes. Ubuntu Pro is not attached. This policy does not create ESM entitlement or certify all legacy application dependencies.

`99archive-vendor-maintenance` leaves Ubuntu security origins in place, excludes the named vendor packages from unattended installation, and explicitly disables automatic reboot. Signed index refresh, candidate policies and an unattended-upgrade dry run were checked after installation. Vendor updates require an operator-run maintenance window and compatibility checks.

Use the plugin command `docker compose` (for example `docker compose version` or a reviewed `docker compose -p <project> -f <private-file> config --quiet`). Keep the complete deployment Compose files and environments private: a normal rendered `config` output can contain credentials. The public `docker/compose-logging.*.yaml` files are logging fragments, not complete deployable projects.

Docker 29 used fresh container metadata and recreated exactly four containers from the existing image IDs and private configuration, with their existing application/data bind mounts, network addresses and log bounds. The reviewed security-setting change is limited to those four containers: cgroup namespace mode changed from `host` to `private`; the other collected security fields stayed equal. This retains the more isolated cgroup v2 default documented by [Docker](https://docs.docker.com/engine/containers/runmetrics/#running-docker-on-cgroup-v2). Old-engine metadata and cold backup staging were retained through validation and retired during final cleanup; small configuration and audit records remain private. A new container ID is expected; altered image/configuration/data is not. Never import an old engine's internal container metadata blindly into a new daemon.

The exact reviewed daemon settings are included as a host reference. Merge only appropriate settings into another existing daemon configuration, validate it with `dockerd --validate --config-file=...`, and coordinate any daemon restart. The default bridge address and iptables backend are host-specific; do not overwrite unrelated networking or authentication settings.

The final controlled reboot passed 410 reviewed application/data/configuration comparisons and 37 installed-configuration/service checks, including all 27 captured host files. The original strict result was retained: its only differences were the four explicitly approved cgroup namespace changes. Application state, data counts and the persistent sending/revocation controls were preserved; no email or Socket.IO session was initiated by the acceptance checks.

After reviewed backups, 194 explicitly selected obsolete packages were removed, recovering 1,890,033,664 bytes without changing protected application configuration or the four running containers. The valid Ubuntu 5.15 fallback kernel links and the Linode 7.2 boot-kernel configuration were retained.

## Final daily-maintenance acceptance

The final check on 2026-10-23 confirmed certificate-renewal, log-rotation and Ubuntu
security-update timers, service autostart, the port guard and time synchronization.
No failed system units, incomplete package transactions or pending upgrades were
reported, and no reboot was required. Existing Longview remains the monitoring
channel; no new Codex alerts, mailing recipients or backup scheduler were added.

The nginx.org package does not implement the old init-script `rotate` action.
The Nginx postrotate hook now runs `nginx -s reopen` while the service is active.
A controlled real rotation, using the shared lock and state file, confirmed that
all log descriptors moved to the new files and a subsequent HTTPS GET was logged.
Master/worker processes and application containers were not restarted.

Fail2Ban retained its one-day history policy and existing ban records. A one-time
SQLite compaction reclaimed free pages (129,550,336 to 658,432 bytes); integrity
checks and the running service passed. The obsolete dated database backup and
the temporary safety copy were removed after validation. No recurring VACUUM job
was introduced. Application PM2 file logging remains disabled in favor of the
bounded container logs.

## Completed staging cleanup

After successful upgrade acceptance, the owner requested retirement of the old
local copies. The inactive original MongoDB4.4 directories/image, old Docker and
containerd metadata, the cold business-data staging archive, downloaded installer
packages, and the duplicate media staging tree were removed after exact reference
and identity checks. Active data, media, current runtime and private configuration
were preserved. The live media tree's full hash and file count matched before and
after cleanup. The final free disk space was approximately 13.83 GB.

Small configuration/audit records and provider-managed Linode backups remain;
no recurring local backup generations accumulate. The retired local copies are
no longer recovery sources. Any future recovery must preserve current mail budgets
and reconcile writes made after the selected backup, using compatible database
and application versions.
