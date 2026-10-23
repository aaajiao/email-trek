# Visitor-triggered paced delivery

This module extends the bounded-store application. It does not require, query, restore or recreate the retired `mail` collection. The UI, runtime version, Mongo schema and original message subject are unchanged. All repository tests use synthetic data and mocked SMTP/DB; they make no real mail deliveries.

## Private activation contract

Add this optional field to the existing private `/app/config.js`, preserving every existing setting and the original `MAILOPTIONS.subject` bytes:

```js
AUTO_SEND: {
  enabled: false,
  mode: 'test-once',
  runId: '',
  allowlist: [],
},
```

The empty run ID and allowlist keep this example inactive. The operator supplies a unique run ID and the actual authorized recipient privately. Missing, disabled or invalid configuration leaves automatic sending off. Only exact valid addresses from this private allowlist can be automatic recipients; HTTP/Socket input cannot enable the mode or supply its addresses. The existing active Mail You form may still send to a user-submitted valid address, subject to both its existing abuse limits and the new shared delivery budget.

`test-once` consumes this run ID **before verification begins**. It can therefore run at most once across restarts, config off/on, success, verification failure, SMTP failure and 24-hour expiry. To make a newly authorized test, explicitly choose a different `runId`. Do not delete state to rearm. Disable automatic sending after an explicitly authorized one-recipient test; never publish that live run ID or recipient.

`allowlist` is the paced continuing mode for a separately authorized allowlist. It cycles configured recipients, never random explored addresses. Known errors pause that run across restarts; a new explicit run ID is required to resume after a failure. Successful runs continue only when a visitor is present and the common delivery budget allows. No missed sends are queued or caught up. A pending unfinished automatic run is never resumed automatically.

## Preserved exploration and truthful records

The existing single shared visitor queue still performs random `checkMail`/RCPT exploration and masked ASCII scrolling. It also checks whether one automatic delivery is due. Extra visitors do not create extra queues or multiply send rate. The worker captures its current generation; immediately before automatic SMTP reservation it checks that visitors remain and the same queue generation is still active. Disconnect/reconnect cannot revive a stale pending verification. An SMTP call already started may complete after a visitor leaves; it is never retried automatically.

The automatic path verifies the actual allowlisted recipient once, then uses that same result for one final record. A completed delivery acceptance records `sent`; an unconfirmed SMTP outcome after positive verification records only `verified`; a definite RCPT rejection records `not_exists`. A transport exception after DATA may still mean the server accepted the message: its delivery budget outcome is `uncertain`, its automatic run pauses as `record-unconfirmed`, and the message says delivery could not be confirmed. It never claims non-delivery or automatically retries. The SMTP envelope explicitly contains only the validated destination, with inherited cc/bcc removed; custom headers cannot add SMTP recipients. Unknown/timeout verification does not invent a database status or increment Sent. These outcomes are retained in the private budget's run state. Emitted homepage records use the same masking function; complete addresses remain visible only through the artwork's already-intended raw SVG export behavior.

The Mail You form keeps its existing IP/recipient reservation and validation. A new shared delivery-budget refusal returns HTTP429 with `Retry-After`; its frontend does not automatically retry mail. Random RCPT verification is **not** a delivery and does not consume the provider's outbound send budget. This distinction matters: probing an address and sending a message are separate operations.

## Shared persistent delivery budget

Both paths use the same Mail instance and call `smtpBudget.reserve` immediately before `transporter.sendMail`, after address verification. The global gate permits at most one delivery attempt per five minutes and 100 delivery attempts in a rolling 24 hours. The configured provider's higher daily allowance is deliberately not used as the local cap. Existing Mail You abuse limits remain intact and can be stricter for a given IP/recipient.

State lives in the existing private persistent `/app/maintenance-state` mount:

- `smtp-budget.json`: atomic state, 0600, at most 64 KiB, no addresses, passwords or literal run IDs. At most 100 recent delivery attempts and 64 permanent hashed automatic run identities.
- `smtp-budget.initialized`: 0600 first-initialization marker. Only when both marker and state are absent may initialization create an empty budget. One missing file, malformed state or unsafe permissions fail closed.
- `smtp-budget.lock`: 0600, kernel flock across cooperating processes. Every operation rereads state under the lock, avoiding stale per-process allowances.

The mount is required and must be 0700. Writes use exclusive temporary files, file fsync, atomic rename and directory fsync. Reservations/pending attempts are persisted before SMTP; failure does not refund quota. Clock rollback cannot reset committed budget. Old delivery entries expire after 24hours, but automatic run identities do not expire. Once 64 run identities are used, automatic new-run creation fails closed until a separately reviewed state-maintenance decision; there is no automatic eviction/rearming.

## Crash and failure boundary

SMTP and Mongo cannot be one transaction. Normal completed attempts write one final result, but a process crash after SMTP and before its database record can leave an unconfirmed/missing record. The durable attempt remains spent; startup does not resend or replay `insertOne`. A pending record is evidence of a reserved attempt, not proof of successful delivery. When SMTP acceptance is known but recording its budget outcome fails, the reservation remains consumed and the known final status is still written if Mongo permits it. Never fix this uncertainty by automatically sending again.

## Review and deployment

The implementation is confined to `lib/mail.js`, `lib/setIOEvents.js`, `lib/setExpressRouter.js` and `lib/smtpBudget.js`. Review their source hashes against the installed version before deployment; distinguish an incremental update from a first installation of the budget module. Preserve all existing source/config/data/state mounts, image identity, network/ports, PM2 single-process settings and log limits. This feature changes no CSS/HTML/browser JS.

The default private config should remain disabled until the operator explicitly selects the authorized run ID/recipient. The operator, not browser request data, enables the one-shot test. No actual recipient, live run ID or SMTP secret belongs in tests or the repository. Existing SMTP credentials/sender selection remain private and are not modified by these source files.

After deployment, inspect source hashes, private state modes/mount, service health, unchanged homepage/Socket exploration, and the expected one-shot state. A real send is a separate authorized test; offline tests alone do not prove mail delivery. Disable the test afterwards. Preserve the budget, initialization marker, lock, old mailQuota state and HMAC key on every restart or rollback. Source/config rollback must keep the bounded data writer; never restore the retired legacy collection writer. Older source lacks this new shared delivery gate, so a rollback is a temporary recovery action, not an equivalent pacing policy.

## Offline validation

Run `yarn test` for the 24 application and 22 pacing cases, plus the separate 10-case MongoDB driver contract suite. Use `REAL_FLOCK=1 yarn test:pacing` on Linux to exercise `/usr/bin/flock`; the normal portable run injects only the lock acquisition and still tests the real atomic-file/state code. The paced-sending source was independently verified on Node24 Linux with the real lock, including two processes competing for one delivery slot. The later driver adaptation does not change or reset this budget state.

`test/paced-tests.js` uses only synthetic data and mocked SMTP/DB. It exercises the five-minute and24-hour boundaries, shared automatic/manual competition, persistence/corruption, one-shot IDs, clock rollback, failed verification/SMTP/DB outcomes, visitor generation races, real-recipient accounting, homepage masking and 429 feedback. On macOS the lock acquisition is injected; the Linux run must set `REAL_FLOCK=1` and use an isolated disposable state directory to test the actual kernel lock. `test/run.js` retains 24 existing compatibility/security cases, with only its old Mail semantics test receiving a mock budget; new pacing behavior is covered separately.
