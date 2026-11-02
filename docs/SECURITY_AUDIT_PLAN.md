# Security audit, with a fix plan (handoff to Sonnet 5.5)

Audited 2026-11-02, read-only. Nothing in `src/` was changed.
Baseline: `bash verify.sh -q` passes every build, syntax and scope step. Tests: 3,143 run, 3,137 pass, 1 fail, 5 todo. The one failure is the known cold-catalog p95 timing budget (`tests/load-performance.test.mjs`, "Directory Keyset Pagination Depth") on a shared VM. Do not loosen it.

## Summary for the owner

The site is in good shape on security. Earlier reviews were acted on: every admin route checks the admin login, every account route checks the account, a test fails if a new route is not listed, database queries are built safely, the pages block injected scripts (nonce CSP), cross-site form posts are refused, sign-in guessing is rate-limited correctly, and outbound fetches only go to approved hosts. I found nothing that lets one person read or change another person's data through the website.

What I found is mostly about **what an attacker could do if they ever got a copy of the database or KV store** (for example through a leaked Cloudflare API token or backup passphrase), plus some privacy tidy-ups:

1. The "forgot username" lookup keeps a fast, unsalted fingerprint of every Account Key. With a database copy, someone could work out Account Keys in hours instead of centuries (SEC-01).
2. Trakt, MDBList and Simkl sign-ins saved by cloud sync sit unencrypted in KV, although the newer storage for the same tokens is encrypted (SEC-02).
3. The Account Key stays in the browser's storage forever, even once a sign-in cookie exists. **Owner decided (2026-11-02): yes, with sessions that renew while in use** (SEC-03).
4. Media-server webhook tokens are stored as-is, unlike every other token (SEC-04).
5. Anonymous like votes store a fingerprint of the voter's IP address that can be reversed (SEC-05). Expired sign-in records are never deleted (SEC-06).
6. Smaller items: the webhook endpoint has no limit on bad tokens (SEC-07); shared channels can carry images from any web host, which lets a sharer log viewers' IP addresses (**owner decided: HTTPS only**, SEC-08).
7. Settings to confirm in Cloudflare and GitHub (SEC-09, SEC-10).

## How this audit was done (what it covers and does not)

The code is about 125k lines, so it was not read line by line. I:
1. Read the shared security code in full: `securityHeaders`, `verifyCsrf`, the PBKDF2 and recovery-answer hashing, sessions (`createSession`, `resolveSession`, revocation), the rate limiter (`rateLimitCount`, `consumeRateLimit`, `reserveRateLimit`), `clientIpKey`, admin gating (`isAdminRequest`), token encryption (`encryptToken`, `storeProviderConnection`, install secrets).
2. Grepped each audit area: hard-coded secrets, every `fetch` with a non-literal URL (SSRF), URL allowlists, unescaped `${}` in server-rendered HTML, `localStorage` writes of credentials, CORS headers, retention (`DELETE FROM`), IP handling, secret comparisons.
3. Unshallowed the clone and fetched every PR ref, then searched **all 571 commits** for committed backups, `.env` files and token-shaped literals. None found.
4. Read the CI workflows and wrangler configs.

Already covered by earlier audits and **not re-opened here**: `docs/BACKEND_AUDIT.md` (BA-001 to BA-012, including the support-inbox HTML injection, BA-003), `docs/BUG_AUDIT_PLAN.md`, `docs/CODE_QUALITY_AUDIT.md`, and the security regression tests (`tests/security-suite.test.mjs`, `admin-security`, `csp`, `csrf-oauth-exemption`, `rate-limit`, `route-access`, `session-*`, `support-email-injection`).

## Rules for the implementer

- Follow `CLAUDE.md`. Edit `src/**/NN_*.js`, never `worker_entry_combined.js`, then `python build.py`. No refactors or renames, one root cause per commit.
- For every item: write the failing test first (rule 10), then fix. The test must fail if the fix is reverted.
- After each item: `bash verify.sh -q --fast` plus that test file. Before pushing: `bash verify.sh -q`. Run `python tools/gen_map.py` if functions were added or moved.
- A schema change is a new file in `migrations/` (next number is `0024_`) **and** the same change in `schema.sql`. Code must keep working when the migration has not been applied yet (the codebase's pattern: try the new column, catch "no such column", fall back). `tests/migration-suite.test.mjs` shows how this is tested.
- New secrets (env vars) must be optional: with the secret missing, behaviour stays exactly as today. Document each in `docs/OPERATIONS.md` and `docs/SELF-HOSTING.md`.
- SEC-03 and SEC-08 were decided by the owner on 2026-11-02; build them exactly as the "Decision" line in each item says.
- Add one `docs/RELEASES.md` entry at the end. Finding IDs are `SEC-nn`. Fix in the order in "Fix order".

---

## Findings

### SEC-01 (Medium, data security): the Account Key "blind index" is an unsalted SHA-256, and it is still written when the peppered HMAC exists
**Evidence.** `creatorKeyLookupHash` (`src/core/02_http-and-creator-utils.js:1718`) is `SHA-256("keylookup:" + key)`, no secret. `storeCreatorKeyLookup` (line 1733) writes it to D1 `creator_key_lookups` (line 1739) and as a **KV key name** `keylookup:<hash>` (lines 1759-1768) on every key create/reset, *and also* writes the peppered `accounts.key_lookup_hmac` when `LOOKUP_PEPPER` is set (line 1746). So the weak copy is kept even on a deployment that has the strong one. `usernameForCreatorKeyLookup` (line 1809) reads HMAC first and the legacy copies only as a fallback (counted by `recordLegacyLookupHit`).

**Impact.** The Account Key is the account's permanent password, and the code deliberately stores it only as PBKDF2 (100,000 iterations). The blind index undoes that. Keys are 12 characters from 32 symbols (2^60). With a copy of D1 or a KV key listing, an attacker tests guesses against **every** account at once with one fast SHA-256 each. For 10,000 accounts, the first key falls in about 1.5 hours on one consumer GPU (2^60 / 10^4 ≈ 1.2e14 hashes at ~2e10/s). The KV key names are also visible in the admin KV browser and copied by `/admin/api/export-kv-to-r2`.

**Fix (three commits).**
1. In `storeCreatorKeyLookup`: when `env.LOOKUP_PEPPER` is set, write only the HMAC and **do not** write the SHA-256 row or KV keys; when it is not set, behave as today. Test: with `LOOKUP_PEPPER` set, creating an account leaves `creator_key_lookups` empty and no `keylookup:` KV key, and forgot-username still finds the account.
2. Lazy clean-up: wherever a legacy hit is found *and* the pepper is set (forgot-username, sign-in paths at `62_creator-auth.js:192` and `79_session-and-channel-routes.js:80` that already backfill the HMAC), delete that account's legacy D1 row and KV keys right after the HMAC is written (`deleteCreatorKeyLookup` exists; check it does not also clear the HMAC it just wrote: it does, at line 1788, so add a narrower helper or a flag). Test: a legacy-only account signs in once and afterwards has HMAC and no legacy entries.
3. A one-off admin job (pattern: the existing migration jobs in `src/jobs/`) that deletes legacy rows/KV keys for accounts that **already have** `key_lookup_hmac`. Do not delete legacy rows for accounts without an HMAC: they would fall into the forgot-username PBKDF2 scan (see the DOS-001 note in `creatorApiForgotUsername`, `67_creator-api-routes.js:428`).

**Owner/ops step.** Confirm `LOOKUP_PEPPER` is set on the live Worker (Dashboard → Worker → Settings → Variables, as a Secret). Without it, step 1 changes nothing.

**Regression risk.** Low-medium: forgot-username is the only reader. Run `tests/authkey-breakdown.test.mjs` and the forgot-username tests after each step.

---

### SEC-02 (Medium, data security): provider tokens in the cloud-sync blob are stored in plaintext in KV
**Evidence.** `/api/creator/sync/save` (`src/api/68_creator-api-account-and-save-routes.js:331-350`) stores `keys` (`tmdbKey`, `tmdbSessionId`, `mdblistKey`, `mdblistAccessToken`, `traktKey`, `traktAccessToken`, `simklKey`, `simklAccessToken`) as plain JSON in KV `creatorsync:<username>`. The newer stores for the same credentials are encrypted with `TOKEN_ENCRYPTION_KEY` (`storeProviderConnection`, `28_connections.js:53`; install secrets, `27_installs.js:199`). Legacy install records also keep plaintext keys in KV until migrated (`INSTALL_MIGRATION_PERCENT`, `27_installs.js:82`).

**Impact.** Anyone with KV read access (a leaked API token, the admin KV export to R2) gets working Trakt/MDBList/Simkl/TMDB sessions for every synced account, which can write to those third-party accounts.

**Fix.**
1. Add two helpers near `encryptToken` (`02_`): `sealSyncKeys(env, username, keys)` → `{ enc: "<encryptToken(JSON)>" }` with context `"creatorsync:" + username`, and `openSyncKeys(env, username, stored)` that accepts either the sealed form or a plain object (legacy). When `TOKEN_ENCRYPTION_KEY` is not configured, seal returns the plain object (today's behaviour).
2. In sync/save, store `keys: await sealSyncKeys(...)`. Every reader of `creatorsync:` that uses `.keys` (start with `68_` line 315 and the sync/load route in `69_`; grep `creatorsync:` — 9 files) calls `openSyncKeys`. The client must receive exactly what it receives today.
3. Legacy blobs are re-sealed the next time they are saved; no bulk job needed.
Test: with an encryption key set, after a save the raw KV value contains no token string; a load returns the same `keys` as before; a legacy plaintext blob still loads; with no encryption key, raw storage is unchanged.

**Ops step.** In `/admin`, check "Install links: keys moving to encrypted storage" and raise `INSTALL_MIGRATION_PERCENT` to `100` once it is healthy, so legacy install records stop holding plaintext keys.

**Regression risk.** Medium (sync is used on every visit). Run `tests/provider-secrets-sync.test.mjs`, `creator-kv-mirror`, `client-storage` and the full suite.

---

### SEC-03 (Medium, authentication) — **decided**: the Account Key is kept in `localStorage` forever
**Evidence.** The key is written to `localStorage['myListAddon:creatorKey']` on sign-in (`src/client/22_client-creator-profile.js:772, 1769, 1843, 2104, 3926`) and stays there even after the browser holds an HttpOnly 30-day session (Release 19, `16_client-row-core.js` "Requests signed by the session"). `docs/DECISIONS.md` D-13 says the key "moves with P6-9's session sign-in"; that step has not happened.

**Impact.** The key never expires and replaces the password. Any script that runs on the origin (an XSS that slips past the CSP, a malicious browser extension) or anyone using a shared computer can read it and take over the account permanently, until the owner resets the key. A session cookie, by contrast, is HttpOnly, expires and can be revoked.

**Question for the owner (changes what users see).** Once a browser has a working session, should the site forget the Account Key in that browser? Then, when the session ends (30 days, sign-out, revoked), the person would type their key again to sign back in. Today they never have to.

**Decision (owner, 2026-11-02): yes, forget the key, AND make sessions renew while they are used,** so someone who visits regularly never has to retype the key. Only people who sign out, are signed out, or stay away for 30 days type it again.

**Fix.**
0. *Sliding sessions first (its own commit, own test, no flag needed).* Today `expires_at` is fixed at sign-in (`createSession`, `02_:1549`) and the cookie's `Max-Age` is 30 days from issue (`buildSessionCookieHeader`). In `resolveSession`, inside the existing at-most-every-5-minutes `last_seen_at` update, also set `expires_at = now + SESSION_TTL_MS`, and make the response carry a fresh `Set-Cookie` (`buildSessionCookieHeader(token)`) at that same moment, so the browser cookie is renewed too (find where the `X-MLA-Session` header is added to `/api/creator/` answers and add the cookie there when `resolveSession` reports it renewed). Revoked, expired or deleted-account sessions must never be renewed. Test: a session used on day 29 is still valid on day 50; a session not used for 31 days is refused; a revoked one is not revived by a request.
1. When the server confirms a session for this account (the `X-MLA-Session` header handling in `16_`), remove `myListAddon:creatorKey` and keep `creatorName` plus a "signed in by session" marker. `activeCreator` (`16_:1224`) must treat "name + session marker" as signed in.
2. On a 401 from a session-only request, show the existing sign-in prompt instead of resending the key.
2b. Before the key is forgotten in a browser for the first time, tell the person once to keep their Account Key somewhere safe, and offer to set a recovery answer if they have none (`hasRecoveryAnswer` is already sent to the page). Reuse the existing notice/toast components and copy style (`docs/AI_UI_RULES.md`); no new styles.
3. Browsers where `localStorage` or cookies are blocked (`creatorSessionHeldFor()` returns `''`) keep today's behaviour.
4. Pages that read the key directly (`18_:162, 443`, `19_:1163, 1769, 1813, 1851`, the public list page's like button) must use the session.
Tests: client-harness test that after a session-confirmed response the key is gone from storage and a save still succeeds; a server test that a session-only request to every `/api/creator/` route the client calls succeeds.

**Regression risk.** High (sign-in flow). Do it last, behind a flag (`FF_FORGET_KEY`), off by default.

---

### SEC-04 (Low-medium, data security): media-server webhook tokens are stored in plaintext
**Evidence.** `scrobble_tokens.token` is the raw token and the primary key (`schema.sql:145`); KV stores it as a key name (`scrobbleTokenKey`, `02_:3680`); `usernameForScrobbleToken` (`02_:3762`) looks it up directly. Sessions (`hashSessionToken`) and install links (`installTokenHash`, `27_installs.js:128`) store only a SHA-256.

**Impact.** A database or KV copy gives a working `?st=` token for every account, which can write fake plays into anyone's watch history.

**Fix.** The Settings page shows the webhook URL again later, so a hash alone is not enough. Add migration `0024_scrobble_token_hash.sql`: columns `token_hash TEXT` (unique index) and `token_enc TEXT`. New/rotated tokens: store `token_hash = SHA-256(token)` and `token_enc = encryptToken(token, env, "scrobble:" + username)`; look up by hash; show by decrypting. Lazy migrate: when a plaintext row authenticates, fill hash+enc and blank `token` to a value no request can send (e.g. `"hashed:" + token_hash`). KV: stop writing `scrobbletoken:<raw>`; key by hash. Without the migration or `TOKEN_ENCRYPTION_KEY`, keep today's path.
Tests: after a rotate, no raw token appears in D1 or KV; the URL shown in Settings still works; an old plaintext token still authenticates once and is then migrated.

---

### SEC-05 (Low, privacy): anonymous like votes keep a reversible fingerprint of the voter's IP
**Evidence.** `likeVoterId` (`02_:3502`) stores `"a:" + SHA-256(ip + "|" + scope)` truncated to 128 bits (`hashStringForKey`, `02_:2224`) in KV ledgers and D1 `list_likes.voter_id`, kept indefinitely. IPv4 has 2^32 addresses, so the IP behind any vote is recovered in under a second per list.

**Impact.** Stored IP addresses are personal data. The database links them to which lists a person liked.

**Fix.** Use HMAC-SHA-256 with a secret (reuse `LOOKUP_PEPPER`, or a new optional `LIKE_VOTER_PEPPER`) when set; otherwise today's hash. During a transition, check both the new and old id so a visitor cannot like twice; when an old id is found, rewrite it to the new one. Test: with the pepper set, the stored voter id differs from `SHA-256(ip|scope)`; a visitor who liked before the change still shows as liked and cannot add a second vote.

---

### SEC-06 (Low, privacy/retention): expired and revoked account sessions are never deleted
**Evidence.** Nothing deletes from `sessions` except account deletion (`02_:1517`). Each row keeps the user agent and timestamps. Admin sessions are purged (`src/admin/03_admin.js:1895`).

**Fix.** A daily job (alongside the existing ones in `src/jobs/53_more-jobs.js`, registered the same way) runs `DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)` with "now minus 7 days" for both, in batches (`LIMIT` via a `rowid IN (SELECT ...)` subquery). Test: old expired and old revoked rows go; a live session and a just-revoked one stay; the session list in Settings is unchanged.

---

### SEC-07 (Low, API abuse): the webhook endpoint has no limit on bad tokens or body size
**Evidence.** `/api/scrobble` (`authenticateScrobbleRequest`, `src/api/64_media-server-scrobble.js:125`) does up to one D1 read and one KV read (plus a second D1 read) per request with no per-IP budget, and `parseScrobblePayload` (line 190) buffers the whole multipart body (Plex attaches a thumbnail) with no size check. Every other unauthenticated, costly endpoint is IP-limited.

**Fix.** Before the token lookup, refuse with 413 when `Content-Length` is over 8 MB (Plex thumbnails are well under that). After a failed token lookup, spend a per-IP failure budget (`reserveRateLimit(env, ctx, "scrobblebadtoken", ip, 30, 600)`); a valid token releases it, so a busy media server with a correct token is never limited. Test: 31 bad-token requests from one IP get 429 on the last; a valid-token request from that IP still succeeds; a 9 MB body gets 413. Load test `loadtests/scrobble-burst.js` must still pass.

---

### SEC-08 (Low, privacy) — **decided**: shared channels can carry images from any host
**Evidence.** `sharedChannelImageUrl` (`src/catalog/05_catalog-core.js:3382`) accepts any `http://` or `https://` URL for a shared channel's poster, thumbnail, show poster and backdrop. Other people who add the channel load those images in Stremio/Nuvio.

**Impact.** Someone who shares a channel can point its images at a server they control and log the IP address (and app) of everyone who views it. `http://` images also load without encryption.

**Decision (owner, 2026-11-02): HTTPS only.** Custom logos on hosts like Imgur must keep working; the strict host allowlist is not wanted.

**Fix.** In `sharedChannelImageUrl`, accept only `https://` URLs (parse with `new URL`, require `protocol === "https:"`); an `http://` image is dropped and the channel's generated poster is used. Also check the client-side channel builder accepts the same rule when saving, so a person is not surprised later (grep the client for where channel images are entered). Test: an `http://` image is dropped, an `https://` image on any host (e.g. `https://i.imgur.com/x.png`) is kept, a `javascript:` or `data:` value is dropped.

---

### SEC-09 (Ops checklist, secrets and infrastructure) — owner, not code
Tick each in Cloudflare / GitHub; none needs a code change.
1. **Old leaked tokens.** `.gitignore` records that `my-lists-full-backup1.json` (an Account Key plus live Trakt, MDBList and Simkl tokens) was committed in an older repository. It is **not** in any of this repository's 571 commits or PR refs (checked). Confirm those tokens were revoked and that the Account Key was reset, and that the file is gone from the old repo's history.
2. Live Worker secrets set: `LOOKUP_PEPPER` (SEC-01), `TOKEN_ENCRYPTION_KEY`, `ADMIN_KEY` as a long random value; Cloudflare Access on `/admin` (`docs/OPERATIONS.md` §25) so the key is only the break-glass path.
3. `INSTALL_MIGRATION_PERCENT` raised to `100` once healthy (SEC-02).
4. GitHub: turn on secret scanning and push protection (Settings → Code security). Keep `BACKUP_PASSPHRASE` only in GitHub secrets and the password manager; the `CLOUDFLARE_API_TOKEN` used by backups should have **D1 Read only**.
5. The repository's Actions artifacts are readable by others (noted in `d1-backup.yml`); backups are encrypted with AES-256, which is correct. Rotate `BACKUP_PASSPHRASE` if it was ever shared.

### SEC-10 (Low, dependency security)
**Evidence.** There are no runtime npm dependencies (the Worker is one file). The only vendored library is fflate 0.8.2 (the self-hosted zip reader, checked byte for byte by `tests/csp.test.mjs`), which has no published advisories. Dev tools are installed pinned (`acorn@8.14.0`, `eslint-scope@8.2.0`, `playwright@1.56.1`) but without a lockfile, so their own sub-dependencies float. GitHub Actions are pinned by commit SHA (good) but nothing proposes updates.

**Fix.** Add `.github/dependabot.yml` with `package-ecosystem: github-actions`, weekly, so SHA-pinned actions get update PRs. Dev-dependency transitive pinning is optional (CI only, no secrets in the `test` job); leave it unless the owner wants a lockfile.

---

## Fix order

1. SEC-09 (owner, today: settings only).
2. SEC-01 (step 1, then 2, then 3).
3. SEC-02.
4. SEC-04 (needs migration 0024).
5. SEC-07.
6. SEC-06.
7. SEC-05.
8. SEC-10.
9. SEC-08 (HTTPS only).
10. SEC-03: step 0 (sliding sessions) first, then the rest behind `FF_FORGET_KEY`, off by default.

## Checked and fine (by audit area)

Absence of a finding is not proof of absence; this is what was looked at.

- **Authentication.** Account Keys: 60 bits from the CSPRNG with no modulo bias (256 is a multiple of 32), stored as PBKDF2-SHA-256 with a per-key salt. Recovery answers: 600,000 iterations (chained), bounded on verify. Sessions: 256-bit random, stored as SHA-256, HttpOnly/Secure/SameSite=Lax cookie, 30 days, revoked on sign-out, key reset and account deletion; the isolate cache is 10 s. Admin: revocable hashed sessions, Cloudflare Access JWT verified (not trusted from a header), audit log. Secret comparisons use `timingSafeEqualSecret`/`timingSafeEqualHex` (Ko-fi token included). Legacy query-string credentials on webhooks are refused (D-36).
- **Authorization.** `tests/route-access.test.mjs` fails on any route missing from `tests/route-access.json`; admin routes go through `isAdminRequest`; cross-account access (lists, connections, install links) is covered by `tests/security-suite.test.mjs`. Install tokens cannot act as the account.
- **API security.** CSRF: same-origin plus `application/json` on every mutating request, with an exact list of exemptions. Rate limits are atomic in D1, keyed on `CF-Connecting-IP` (not spoofable; IPv6 grouped by /64), fail closed, and refund on success for sign-in budgets. CORS is `*` only on GET catalog/public routes, never with credentials.
- **Input validation / XSS / SQL.** All D1 queries reviewed use `.bind()`; the full-text search input is stripped to letters and digits. Server-rendered pages escape (`escapeHtmlServer`, `jsonForScript`); the configure page receives only non-secret fields (`nonSecretInstallConfigFields`). CSP: nonce-only scripts, `form-action 'self'`, `object-src 'none'`, `frame-ancestors 'self'`.
- **SSRF.** User-supplied URLs are checked against host allowlists before any server-side fetch (`isAllowedPosterUrl`, `isAllowedCatalogSourceUrl`, TVMaze next-episode link prefix); RPDB keys only change the path on a fixed origin.
- **Secrets.** No hard-coded keys or tokens in `src/`, tools, workflows or wrangler files; full history and PR refs clean; `.gitignore` blocks backup exports. Error messages and logs redact secrets (`redactSecretsInText`).
- **Data security.** Provider connections, install secrets, Stremio authKeys and Nuvio refresh tokens are AES-GCM encrypted with a key ring and a per-record context; the Nuvio password is exchanged and dropped. D1 backups are encrypted before upload.
- **Infrastructure.** CI has `contents: read` only, actions are SHA-pinned, secrets are used only in the scheduled jobs, no `pull_request_target`. HSTS (180 days), `nosniff`, `X-Frame-Options`, Referrer-Policy and Permissions-Policy are set on every response. `wrangler.toml` warns against a deploy that would wipe dashboard variables, and `keep_vars = true`.

## Known and deliberately deferred (not findings)

- CSP `img-src https:` and `connect-src https:` are broad on purpose (posters and provider APIs come from many hosts); narrowing is listed as a follow-up in `securityHeaders`. Trusted Types is report-only (`FF_CSP_TT_REPORT`).
- The admin key still works alongside Cloudflare Access, as a documented break-glass path (`docs/OPERATIONS.md`).
- Install links (`/i/<token>`) are bearer URLs by nature: Stremio has no other way to authenticate an add-on.
