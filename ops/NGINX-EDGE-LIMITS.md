Nginx edge limits for Bot Gluttony and Email Trek

The installer changes only three exact HTTPS application locations. A map uses
the actual remote address only for POST, and an empty key exempts other methods.
The application must retain its own durable limits; these edge limits cover the
three canonical paths rather than every possible application route alias.

| Exact path | Rate | Burst | Maximum body |
| --- | --- | --- | --- |
| Bot `/api/auth/login` | 20/minute | 5 | 8 KiB |
| Email `/mail-you-send` | 1/second | 4 | 4 KiB |
| Email `/get-data` | 10/second | 60 | 4 KiB |

Each zone has1MiB shared memory; excess returns429, with no artificial burst
delay. Generic proxy blocks, headers, methods, query strings, Socket.IO, ACME,
TLS settings and ordinary pages remain unchanged. The exported configs in
`nginx/` include the existing unchanged upgrade-header map dependency. They do
not contain certificate private keys or application credentials.

Use `python3 install-nginx-edge-limits.py` as root on the host for a plan.
Use `--apply` for a private timestamped backup, atomic writes, `nginx -t` and
`systemctl reload nginx`. On failure it restores the saved files. A deliberate
rollback uses `--rollback /root/maintenance-archives/<date>/<backup-directory>`.
No daemon restart or host reboot is performed. Existing unfamiliar exact
locations or conflicting zone configuration cause the installer to refuse.

`verify-nginx-edge-limits.py` runs local HTTPS checks with the correct Host/SNI.
It uses malformed JSON rejected before application routes, so it neither sends
mail nor queries historical data. It does issue deliberately invalid login
credentials and oversized request bodies. It confirms50 concurrent data-path
requests fit the export burst, then verifies429 and413 responses. Its forged-IP
headers do not alter rate-limit keys. Run it only as an intentional maintenance
test, not as a monitor or scheduled job.

Validation on2026-10-22: syntax check and reload passed; Nginx active. The tested
binary was 1.20.2, while these directives also use1.10-compatible syntax. Normal
pages returned200; invalid login401; limits returned429; body caps413;50 data
requests passed the limiter and reached the parser400. ACME missing challenge
returned404. Bytes outside managed sections matched their originals exactly.

The host was subsequently upgraded to Nginx 1.30.6. Its preserved configuration
passed syntax checks and normal HTTP/HTTPS health checks. The historical full
401/429/413 and 50-request limiter results above are not presented as a fresh
run against 1.30.6.

The direct peer seen by the Email container after a static proxied request was
172.22.0.1, represented as an IPv4-mapped socket in `/proc/net/tcp6`.
`EMAILTREK_TRUSTED_PROXY_IPS=172.22.0.1` is appropriate for this current Docker
network, together with Nginx overwriting X-Real-IP. Recheck if the network changes.

Evidence: nginx-edge-apply-result.json, nginx-edge-verification.json,
nginx-edge-scope-verification.json and nginx-upstream-peer.json. These are static
maintenance results. No health timer or additional monitoring is installed.
