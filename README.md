# email-trek

<pre style="text-align: left;margin-top: 0px;margin-bottom: 200px">                 ____                               ___
                /\  _`\                         __ /\_ \
                \ \ \L\_\    ___ ___      __   /\_\\//\ \
                 \ \  _\L  /' __` __`\  /'__`\ \/\ \ \ \ \
                  \ \ \L\ \/\ \/\ \/\ \/\ \L\.\_\ \ \ \_\ \_
                   \ \____/\ \_\ \_\ \_\ \__/.\_\\ \_\/\____\
                    \/___/  \/_/\/_/\/_/\/__/\/_/ \/_/\/____/


                        ______             __
                       /\__  _\           /\ \
                       \/_/\ \/ _ __    __\ \ \/'\
                          \ \ \/\`'__\/'__`\ \ , &lt;
                           \ \ \ \ \//\  __/\ \ \\`\
                            \ \_\ \_\\ \____\\ \_\ \_\
                             \/_/\/_/ \/____/ \/_/\/_/

 README

   Email Trek is derived from the concept of Star Trek, we assume that the
   email system is destroyed (more exactly and loss associated with human).

   We construct a system can be randomly generated email, and will
   automatically send mail, through this email we will get four state:

     ▞▚ Delivery    ▒▒ Sent    ▓▓ Failure  ██ Open

   We construct a system can be randomly generated email, and will
   automatically send mail, through this email we will get four kinds of
   state: we will record these states, drawing into our own star coordinates.

 CONTACT

   If you have problems, questions, ideas or suggestions, please contact us
   by posting to a suitable email. See http://eventstructure.com/email

   All contributors to the project are listed : Quanquan (code).

 WEB SITE

   Visit the curl web site for the latest news and update:

         * http://eventstructure.com/email-trek/
         http://email-trek.t-h-e-s-p-a-c-e.com/

 GIT

   To download the latest source off the GIT server do this:

     git clone https://github.com/aaajiao/email-trek

   (you'll get a directory named email-trek created, filled with the source
   code)

 NOTICE

   Email Trek contains pieces of source code that is Copyright (c) 2015, 2016
   eventstructure. This notice is included here to comply with the distribution
   terms.

</pre>

## Maintained deployment

The 2026 maintenance branch restores the source actually deployed on the server: Express, Socket.IO and MongoDB. Earlier RethinkDB implementations remain in Git history. The artwork's ASCII layout, fonts, colours and generated-address principle remain intact.

### Current operating mode (2026-10-22)

The original artwork description above is retained as historical context. Current operation is limited: visitors still drive random SMTP/RCPT exploration and masked scrolling, and Mail You remains available for an explicitly submitted recipient. Automatic message delivery to randomly generated unknown addresses is paused. `AUTO_SEND` defaults to off; the authorized one-shot test has ended and automatic delivery remains disabled. These limits mean the current service does not reproduce the complete original automatic-sending mechanism.

`VERIFIED` means an RCPT acceptance response was observed; it does not establish that an address belongs to a real mailbox or that a message arrived. `SENT` means the sending provider accepted the message, not that it reached the inbox, was read, or was opened.


Use Node 24.22.1 and Yarn 1.22.22. `yarn.lock` is authoritative; do not regenerate it with an unrestricted dependency upgrade. Run `yarn install --frozen-lockfile --ignore-optional`, then `yarn test` (24 application regression cases, 22 pacing cases and 10 MongoDB driver cases). On Linux, `REAL_FLOCK=1 yarn test:pacing` exercises the actual kernel lock; other runs use an injected lock while testing state logic. Copy `config.example.js` to a private `config.js` and supply the variables shown in `.env.example` through your deployment environment. The application does not load `.env` itself.

Production uses one process, a persistent private `/app/maintenance-state` directory (0700), an authenticated MongoDB connection, and a reverse proxy that overwrites `X-Real-IP`. PM2 file watching is disabled; production changes use a controlled container recreation rather than watching the dependency tree. Configure only the exact direct proxy peer in `EMAILTREK_TRUSTED_PROXY_IPS`. State files are private, atomic and bounded; do not delete them to clear quotas. The process must not run before storage migration is finalized.

### Storage and historical meaning

The online collection `mail_recent_v1` retains the latest 100,000 records with a 128 MiB cap. `mail_totals_v1` permanently retains cumulative totals, separates historical and new counts, and uses one durable pending record to recover interrupted writes. Run one writer process, not a cluster.

The source now pins MongoDB Node driver 7.7.0 for a separately reviewed server upgrade. The write protocol, record schema, counters and retention window are unchanged. See [MongoDB driver compatibility](docs/mongodb-driver.md) for the driver changes, isolated tests and deployment limits; a source change alone does not upgrade the running database.

The 99,249,396-record baseline ended at cutoff `6ada58640000000000000000` (2026-10-22 18:39:32 UTC). Statistics and 10,453 representative historical samples were archived privately; complete legacy database contents are intentionally not in this repository. A small post-cutoff tail is archived separately before migration.

Historical statuses describe the original program's observations, not ownership or deliverability of email addresses. In particular, old `not_exists` counts included network failures, and old `verified` counts could include ambiguous SMTP responses. New verification accepts an exact RCPT 250 response, records RCPT 5xx rejection as `not_exists`, and does not classify temporary/network failures as nonexistent addresses. SMTP acceptance still does not prove mailbox ownership or successful delivery.

`ops/storage/` contains explicit operator tools for representative archival and tail verification. `lib/migrate-storage.js` provides `prepare`, `finalize --writers-stopped`, and `verify`; it never deletes the legacy collection. Finalize only after stopping the legacy writer and validating local archive hashes. Remove the old collection only after independent count/hash checks and successful application checks. Never restore the legacy writer after the new store has accepted writes.

### Preserved interactions and abuse limits

The homepage initializes from recent history immediately, updates permanent totals and scrolls masked addresses while visitors are connected. The generator pauses after the last visitor leaves. SVG exports intentionally contain the full stored addresses, support the existing maximum of 100,000, escape XML safely and show bounded retry/error feedback. SVG data is public by artwork design.

Mail You validates one address and provides clear feedback. Its request-level abuse limits remain 3 attempts per IP per 15 minutes / 20 per day, 1 per recipient per 10 minutes / 5 per day, globally 30 per hour / 100 per day, with at most 2 concurrent handlers. In addition, all actual message-delivery calls share a durable budget of one attempt per five minutes and 100 per rolling 24 hours, reserved immediately before SMTP. RCPT exploration is separate from message delivery.

Visitor-triggered automatic delivery is disabled by default. It uses only an explicit private allowlist and never sends to randomly explored addresses. `test-once` consumes a private run ID before verification, so failures, restarts and reconnects cannot repeat the test. `allowlist` mode remains visitor-driven and paced; an error or unfinished attempt pauses that run. Keep the budget and consumed run identities on the persistent state mount. See `docs/paced-sending.md` for configuration, cancellation and crash boundaries.

Each normally completed attempt records one final status for the actual recipient. A confirmed SMTP acceptance contributes `sent`; an unconfirmed transport outcome retains only the prior verification fact, marks the budget `uncertain`, and is not automatically resent. SMTP and database commits cannot be atomic on this stack, so a crash can leave an unconfirmed result. An explicit single-recipient SMTP envelope prevents inherited cc/bcc/custom envelope recipients from bypassing the destination rule. Homepage records remain masked.

See `docs/source-build-node24.md`, `docs/runtime-maintenance.md` and `ops/` for runtime compatibility, HTTPS renewal, firewall boundaries and bounded logs. The driver update is limited to MongoDB and its required dependency subtree; unrelated application packages remain at their existing lockfile versions. This maintenance is not a complete audit of every legacy dependency. Never commit runtime credentials, samples, database files, generated SVGs or private retained-server images.

### Completed legacy-data retirement (2026-10-22)

The old `emailtrek.mail` collection was retired after the private archive hashes, baseline/tail counts, frozen last-100,000-record hash, new accepted writes and live pages/exports were verified. The permanent cumulative totals and the capped 100,000-record online window remain active. `ops/storage/drop-old-mail.js` records the one-time guard used; it defaults to a plan and requires the exact private archival proof, source hashes and explicit acknowledgements. It is not a recurring cleanup task and must not be adapted into a blind scheduled deletion. The private proof and raw sample data are deliberately excluded from Git.
