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

Use Node 24.22.1 and Yarn 1.22.22. `yarn.lock` is authoritative; do not regenerate it with an unrestricted dependency upgrade. Run `yarn install --frozen-lockfile --ignore-optional`, then `yarn test`. Copy `config.example.js` to a private `config.js` and supply the variables shown in `.env.example` through your deployment environment. The application does not load `.env` itself.

Production uses one process, a persistent private `/app/maintenance-state` directory (0700), an authenticated MongoDB connection, and a reverse proxy that overwrites `X-Real-IP`. Configure only the exact direct proxy peer in `EMAILTREK_TRUSTED_PROXY_IPS`. State files are private, atomic and bounded; do not delete them to clear quotas. The process must not run before storage migration is finalized.

### Storage and historical meaning

The online collection `mail_recent_v1` retains the latest 100,000 records with a 128 MiB cap. `mail_totals_v1` permanently retains cumulative totals, separates historical and new counts, and uses one durable pending record to recover interrupted writes. Run one writer process, not a cluster.

The 99,249,396-record baseline ended at cutoff `6ada58640000000000000000` (2026-10-22 18:39:32 UTC). Statistics and 10,453 representative historical samples were archived privately; complete legacy database contents are intentionally not in this repository. A small post-cutoff tail is archived separately before migration.

Historical statuses describe the original program's observations, not ownership or deliverability of email addresses. In particular, old `not_exists` counts included network failures, and old `verified` counts could include ambiguous SMTP responses. New verification accepts an exact RCPT 250 response, records RCPT 5xx rejection as `not_exists`, and does not classify temporary/network failures as nonexistent addresses. SMTP acceptance still does not prove mailbox ownership or successful delivery.

`ops/storage/` contains explicit operator tools for representative archival and tail verification. `lib/migrate-storage.js` provides `prepare`, `finalize --writers-stopped`, and `verify`; it never deletes the legacy collection. Finalize only after stopping the legacy writer and validating local archive hashes. Remove the old collection only after independent count/hash checks and successful application checks. Never restore the legacy writer after the new store has accepted writes.

### Preserved interactions and abuse limits

The homepage initializes from recent history immediately, updates permanent totals and scrolls masked addresses while visitors are connected. The generator pauses after the last visitor leaves. SVG exports intentionally contain the full stored addresses, support the existing maximum of 100,000, escape XML safely and show bounded retry/error feedback. SVG data is public by artwork design.

Mail You validates one address and provides clear feedback. Quotas are 3 attempts per IP per 15 minutes / 20 per day, 1 per recipient per 10 minutes / 5 per day, globally 30 per hour / 100 per day, with at most 2 concurrent sends. Attempts remain bounded across restarts. A successful send contributes one final record; failures do not falsely increment Sent. There is no automatic mail retry, because SMTP and database commits cannot be made atomic on this legacy stack.

See `docs/source-build-node24.md`, `docs/runtime-maintenance.md` and `ops/` for runtime compatibility, HTTPS renewal, firewall boundaries and bounded logs. Application major versions and MongoDB remain unchanged; this maintenance is not a complete audit of every legacy dependency. Never commit runtime credentials, samples, database files, generated SVGs or private retained-server images.
