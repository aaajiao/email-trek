# Shared host maintenance for Bot Gluttony and Email Trek

This directory belongs in **both repositories at the same revision**, for example `ops/shared-host/`. The two projects share one Nginx/Docker host. These files have one host-level owner and are installed **once per host**, regardless of which repository supplies them. Keep both copies byte-identical and compare `manifest.json` hashes when updating either repository. Each project remains responsible for its own app image, private configuration, persistent data, and application-specific security changes.

This package records the maintenance performed on 2026-10-22. Packaging it made no server changes. It adds no alert recipients, email notifications, monitoring service, or recurring Codex task. The only timers here perform certificate renewal and Longview log rotation. Existing Longview monitoring remains in place; its account/API configuration is deliberately excluded. Root SSH login and the SSH configuration are outside this package.

## Contents and installed behavior

| Area | Files | Behavior |
| --- | --- | --- |
| HTTPS | `files/usr/local/sbin/archive-cert-renew`, matching service/timer | Reuses the existing `archive-projects` certificate/account in private `/etc/letsencrypt`; pinned Certbot image; file lock prevents overlapping renewals. Checks at 03:15 and 15:15 in the host timezone, with up to one hour randomized delay. Successful renewal leaves a marker, then the host validates and reloads Nginx. No new account registration is performed by the script. |
| Public ports | `archive-port-guard`, service, Docker drop-in | Host-specific `eth0` IPv4/IPv6 rules protect FTP 21, app 4000/4001 and Mongo 35017/35018. Forward rules cover translated container ports 27017/3000/4000; established forwarded connections return. Guard is re-applied after Docker starts. HTTP/HTTPS and SSH are not blocked by these rules. |
| Container logs | `docker/compose-logging.*.yaml` | All four app/Mongo containers use `json-file`, `max-size: 10m`, `max-file: 3`. Limits take effect when each container is recreated with its original image/config/data mounts. |
| Host Docker default | `docker/daemon-logging.fragment.json` | Existing host fallback is `json-file`, `50m`, three files. This is a JSON fragment to merge, never a replacement for the complete daemon configuration. Per-container 10m settings take precedence. |
| Nginx logs | `files/etc/logrotate.d/nginx` | Daily rotation, fourteen retained files, compression with one-cycle delay, correct reopen hooks. No separate duplicate Nginx rotation timer. |
| Longview UID handling | `longview/unmapped-uid.patch` | Preserves process metrics for container UIDs absent from host passwd: `uid-NNN`; missing UID becomes `unknown`. The historical source hash is pinned below. No Longview account setting changes. |
| Longview logs | Dedicated configuration and service/timer | Hourly check; rotate daily or above 10MiB at check time, seven rotated files, compression, copytruncate, separate state. This is not a strict continuous size cap or guaranteed seven-day retention. The configuration is outside `/etc/logrotate.d` to avoid duplicate daily handling. |

## Installation / adoption

On the already-maintained host, run the read-only verification first and leave matching files in place. Do not rerun the historical cleanup script.

For a reviewed restoration or a new matching host:

1. Back up existing configuration and unit files privately, preserving ownership and permissions. Verify the external interface really is `eth0`, the Docker service names/ports match this package, and Nginx serves the existing ACME webroot `/var/www/acme`. Do not copy this host-specific firewall blindly to a different network layout.
2. Install the exact files from `files/` at their corresponding absolute paths. Use root ownership, mode 0750 for the two `/usr/local/sbin` scripts, and mode 0644 for units/logrotate files. Do not copy private certificates, renewal-account data, or log contents into Git. The existing certificate/account and webroot must be restored separately from private backup.
3. Validate shell syntax with `bash -n` / `sh -n`, Nginx with `nginx -t`, and the unit files with `systemd-analyze verify`. Validate rotation without rotating logs using `logrotate --debug --state /var/lib/logrotate/longview.status /etc/logrotate-longview.conf` and `logrotate --debug /etc/logrotate.d/nginx`.
4. After review, run `systemctl daemon-reload`, enable/start `archive-port-guard.service`, `archive-cert-renew.timer`, and `longview-logrotate.timer`. Do not restart Docker merely to load its drop-in: the live guard can be applied independently, and the drop-in governs the next Docker start. Keep existing app services running during adoption.
5. Merge the Docker **logging mappings** into the existing Compose services. Preserve all image IDs, environment, networks, volumes, restart policy, and data. Edit each existing `ports` list to its loopback-only binding below; do not add a second Compose override port entry, which can retain the old public binding. Container recreation belongs to an approved app deployment with rollback, not to this file-copy step. Likewise, merge the daemon JSON fragment without replacing unrelated keys; loading daemon defaults needs a separately coordinated Docker restart and does not retrofit existing containers.

| Existing container | Required host-to-container binding |
| --- | --- |
| `bot_crazyplayer_1` | `127.0.0.1:4001:3000` |
| `bot_mongodb_1` | `127.0.0.1:35018:27017` |
| `emailtrek_emailtrek_1` | `127.0.0.1:4000:4000` |
| `emailtrek_mongodb_1` | `127.0.0.1:35017:27017` |

Email Trek's PM2 configuration directs its internal `out_file` and `error_file` to `/dev/null`, while pm2-runtime still streams events into Docker's bounded log. Preserve that application-side setting. Do not set `disable_logs: true`, which would also suppress its event stream. Never logrotate Docker-managed JSON log files independently.

## Longview source patch and historical cleanup

The patch targets `/opt/linode/longview/Linode/Longview/DataGetter/Processes.pm`:

- Original SHA256: `5410ff1174a92328357b56d2cf4931bedb97b370b106b67ce219a70935772375`.
- Patched SHA256: `f5e0396b595c087396b02c870534dc91e4b8d933aaec9da9110ab9919531f948`.

If the patched hash is already installed, do nothing. If the original hash matches, first save a private backup, then run `patch --dry-run -d /opt/linode/longview -p1 < longview/unmapped-uid.patch`. Apply the same patch only after the dry run succeeds. Any other hash requires reviewing the installed version; do not force it. Check `perl -I/opt/linode/longview -c /opt/linode/longview/Linode/Longview/DataGetter/Processes.pm` and run the included fixture with that source path. The fixture uses a mocked `/proc` reader and makes no network requests. Its `uid-999` case assumes UID999 has no host passwd entry, as on the maintained host; adapt the fixture UID if validating a different host. Restart only Longview after a successful source/fixture check, and restore the private backup on failure. Keep the active Longview log private (0600); no log sample is included here.

`historical/fix-longview-host-logs-20261022.py` is the exact original one-time maintenance script, retained to account for the work. It patches the source, creates rotation files, briefly stops Longview, saves a private compressed tail, compacts the large historical log, and starts the agent. It is not an idempotent installer, refuses an existing maintenance record/configuration, and must not be run by CI, systemd, or routine upgrades. The original host needed a bounded rotation-fixture/manual continuation after an old logrotate debug quirk; this script alone is not a promise that replaying the historical migration on another host will succeed. Use the declarative files and source patch for normal restoration.

## Verification and rollback

`sudo python3 verify-installed.py` is read-only and Python3.5-compatible. It verifies installed hashes, timer/guard activation, the four containers' log settings and loopback bindings, and the Longview source hash. It prints no environment, private config, tokens, mail records, or log lines. It does not send HTTP business requests or contact SMTP/Mongo. Exact-source hash mismatch may reflect a later legitimate package update and needs review rather than automatic overwrite.

Also inspect `systemctl list-timers archive-cert-renew.timer longview-logrotate.timer`, `nginx -t`, and the public HTTPS certificates. A controlled `/usr/local/sbin/archive-cert-renew --dry-run` checks the ACME challenge using the existing renewal setup; this does contact ACME and is not part of the read-only verifier. A live deploy-hook/reload is separate from a dry run. Test public port closure from an external host, while confirming HTTPS and SSH remain reachable. Do not read or publish container environment or certificate private-key files as evidence.

Rollback restores the private file backups, then reloads systemd and reapplies only the affected guard/units. Restore container logging/port changes through the original Compose configuration and retained images/data mounts. Never delete volumes or certificate/account state. Do not remove the port guard merely because an app deployment rolls back. No new notification or alerting mechanism is enabled by these files.
