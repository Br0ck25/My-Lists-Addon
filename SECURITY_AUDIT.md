# Security Audit

**Date:** 2026-09-25 · **Status:** findings only; nothing changed.

**Scope:**

- Authentication, authorization and creator ownership.
- Credentials: Creator Key, recovery answer, admin key, install ids, scrobble tokens, OAuth tokens, provider API keys.
- Input handling, XSS, CSRF, SSRF, open redirect, rate limiting and abuse, enumeration, information disclosure, logging.
- Client-side storage.

**Not assumed secure just because it sits behind Cloudflare.** Every claim was checked in the source. Cloudflare behavior was checked against its documentation (2026-09-25).

**Severity scale:**

| Severity | Meaning |
|---|---|
| Critical | Account takeover or mass data exposure with realistic preconditions |
| High | Credential exposure or cross-user data access under plausible conditions |
| Medium | Abuse, integrity or targeted attacks |
| Low | Defense in depth |
| Info | Noted for completeness |

**What is already done well (keep):**

- `jsonForScript` escaping for inline JSON (`02_:914`) and its hostile-render CI test.
- `escapeHtmlServer` on server-rendered pages.
- SSRF allowlists on `/api/poster-badge` (`25_:18-39`), `/api/preview` (`isAllowedCatalogSourceUrl`, `04_:318`) and `/api/channel-logo`.
- `timingSafeEqualSecret` for the admin key.
- Per-account failure budgets on recovery-answer reset (`RESET_KEY_ACCOUNT_MAX_FAILURES`).
- The personal-shelf authorization gate (`mayReadTrackedShelf`, `02_:3660`).
- A strict CSP for object, base and frame-ancestors.
- HSTS.
- `no-store` enforced for `/api/creator/*`, `/admin*` and `/api/resolve` (`isPrivateApiPath`, `02_:48`).
- `Secure`, `HttpOnly` and `SameSite` flags on the OAuth state cookies and the admin cookie.
- Byte-accurate size limits.
- The explicit `ok` result on deletes.

---

## Summary

| ID | Severity | Finding |
|---|---|---|
| S-01 | **Critical** | The Creator Key is a permanent bearer password, copied into plaintext storage and URLs |
| S-02 | **High** | The install config id is an unrevocable bearer credential that returns OAuth tokens and grants scrobble writes |
| S-03 | **High** (verify) | Authenticated Trakt `users/me/*` responses are edge-cached by URL (`cf.cacheTtl`) and may be served across users |
| S-04 | **High** | Provider OAuth tokens and API keys are stored unencrypted in many places and never refreshed or revoked |
| S-05 | **High** | XSS blast radius: 326 `innerHTML` sites, secrets in `localStorage` -- **narrowed by P7-1**: `script-src` is nonce-only (no `'unsafe-inline'`, no host), so an injected `<script>` no longer executes; the inline handlers (P6-8, P6-10) and the third-party script/font origins are gone. Trusted Types is report-only until the `innerHTML` sinks are converted |
| S-06 | **Medium-High** | The Creator Key blind index is an unsalted, unpeppered SHA-256 |
| S-07 | **Medium** | TMDB OAuth callback accepts `request_token` from the query string without binding it to the state cookie (login CSRF) |
| S-08 | **Medium** | The scrobble webhook accepts the install id, or the Creator Key in the query string, as write credentials |
| S-09 | **Medium** | No `Origin`/`Sec-Fetch-Site` checks: cross-site pages can drive anonymous writes (likes, adds, telemetry, `/api/save`) from visitors' IPs |
| S-10 | **Medium** | Admin: one shared secret, stateless 7-day cookie, no per-session revocation, no audit log, no second factor |
| S-11 | **Medium** | The recovery answer is a password-equivalent that can mint a new key |
| S-12 | **Medium** | `/api/save` allows unauthenticated permanent writes of up to 10 MB, 20 per minute per IP (storage and cost abuse) |
| S-13 | **Medium** | Rate limiting is non-atomic (KV) and IP-only for most routes |
| S-14 | **Medium** | Secrets may reach logs (provider URLs carry `api_key=` / `apikey=`; raw errors are logged) |
| S-15 | **Medium** | Credentials accepted in query strings on several routes |
| S-16 | **Medium** | PBKDF2 iterations (100k) are below current guidance, and there are no sessions to amortize a higher cost |
| S-17 | Low | Anonymous legacy published lists have no owner; moderation is admin-only |
| S-18 | Low | `/admin/login` form has no CSRF token (login CSRF); OAuth `?debug=1` pages are public |
| S-19 | Low | Error details leak in the TMDB OAuth redirect |
| S-20 | Low | Anonymous like identity is an unkeyed hash of IP plus list |
| S-21 | Info | Credentials previously committed in a public repository (prior INFO-05). Confirm rotation and history purge. |
| S-22 | Info | Username enumeration via create/restore responses (inherent to public usernames) |
| S-23 | Info | JustWatch unofficial API use (legal/ToS, not technical) |

---

## Critical

### S-01 — The Creator Key is a permanent bearer password spread across plaintext stores and URLs

**Current:**

- A Creator Profile has one credential: `MYL-XXXX-XXXX-XXXX` (about 60 bits), stored server-side as PBKDF2 (`02_:511-537`).
- There is **no session**. The key is sent on every authenticated request: dashboards poll every 60 s (`22_:6583-6591`), plus every save and sync (`26_:1-88`).
- **Where it ends up:**
  - Browser `localStorage` (`myListAddon:creatorKey`, 51 references).
  - Request bodies, and **query strings**: `/api/preview?creatorKey=` (`25_:1164`), `/api/feedback/threads?creatorKey=` (`25_:6197`), `/api/scrobble?creator=&key=` (`26_:555-588`).
  - **Plaintext in every install config** in KV, as `cfg:{id}.trackCreatorKey` (`25_:7048-7055`, and client `23_:600`). These configs are never deleted (S-02).
  - **Inside base64 install URLs** when the KV save fails (`23_:296-330`, `24_:2224`). These URLs are pasted into Stremio, Nuvio and Wako, and they show up in screenshots, forum posts and app logs.
  - In full backups (`.gitignore` notes these carry the key and OAuth tokens).
- **The consequence:** anyone who reads KV (an admin, a compromised API token, a backup) or any secret-bearing install URL gets working master credentials for those accounts. The PBKDF2 hash protects nothing in that case, because the plaintext sits beside it.

**Problem.** The key cannot be rotated without breaking every install that embeds it. Leaks are silent. Revoking one device means changing the key everywhere.

**Proposed:**

1. **Sessions.**
   - `POST /api/session` with username and Creator Key: verify with PBKDF2 at an increased cost.
   - Issue a 256-bit random session token in an `HttpOnly; Secure; SameSite=Lax; Path=/` cookie. Store only its SHA-256 hash in D1 `sessions`, with an expiry, and rotate it on privilege changes.
   - All `/api/*` calls use the cookie.
   - A "Devices" page lists sessions and revokes them.
2. **Remove the key from everywhere else.**
   - Never send it in query strings; reject requests that do.
   - Never store it in install configs.
   - Never put it in exports.
   - The browser keeps it only transiently on the login screen. Offer "Save to password manager" (`autocomplete="current-password"` on a real form).
3. **Install tokens.** Per-install random tokens (§S-02) replace `trackCreatorKey` as proof of ownership for catalog reads.
4. **Migration.**
   - Existing configs carrying `trackCreatorKey`: the legacy resolver verifies it once, binds the config to the account as an `installs` row, then **deletes the plaintext** from the KV record.
   - Existing clients keep working through a compatibility period: key-in-body is accepted and upgraded to a session cookie on the response (MIGRATION_PLAN Phase 7).

**Benefit.** A leaked install URL or backup no longer grants account control. Sessions can be revoked, and PBKDF2 cost moves off the hot path.

**Risk.** Auth changes are the riskiest part of the migration. Staged rollout and dual acceptance are required.

---

## High

### S-02 — The install config id is an unrevocable bearer credential for tokens and writes

**Current:**

- The 12-character id (72 bits, `generateShortId`, `02_:453`) in `/{id}/manifest.json` is the only thing needed to:
  1. read the owner's MDBList key, MDBList, Trakt and Simkl access tokens, and their watch history, Continue Watching, Watchlist and Airing Next via `GET /api/resolve?config={id}` (`25_:6863-6934`);
  2. **write** to the account's watch history via `/api/scrobble?config={id}` (`26_:553-575`), which authenticates using the `trackCreatorKey` stored in that config;
  3. render the configure page with tokens embedded (`/:config/configure`, `25_:465-489`).
- Install URLs are shared by design: addon sharing, screenshots, support threads.
- Configs are never deleted and have no owner index, so a user can't revoke old ones. Each "Update Link" mints another copy (BACKEND_AUDIT BE-C4).

**Proposed:**

- `installs` rows with a random 128-bit token, stored hashed, and scopes (`read`, optionally `scrobble`).
- The install URL grants **catalog reads only**. It never returns credentials.
- The configure page requires a session, and a signed-in user edits the install by id.
- Scrobbling uses a separate `scrobble` token.
- Users can list, rename and revoke installs.
- `/api/resolve` is removed. "Import from install link" requires a session and copies only the non-secret rows.

**Risk.** Legacy ids must keep serving catalogs. The legacy resolver strips secrets and serves read-only (MIGRATION_PLAN §3.2).

### S-03 — Authenticated Trakt responses are edge-cached by URL (verify)

**Current.** Several Trakt calls use a user's `Authorization: Bearer` token on user-relative URLs with `cf: { cacheTtl: 60 }`:

- `https://api.trakt.tv/users/me/watched/shows?extended=noseasons`
- `https://api.trakt.tv/users/me/watchlist/shows?limit=50`

They appear at `06_:910`, `06_:914`, `06_:1245`, `25_:5585`, `25_:5821` and `25_:5831`.

Cloudflare documents that `cacheTtl` "forces Cloudflare to cache the response for this request, regardless of what headers are seen on the response". The default cache key is the URL, which is identical for every user.

**Problem.** Within 60 s in the same data center, user B's Airing Next / Up Next computation can receive **user A's watched shows and watchlist**. That is cross-user data exposure, and it would also produce wrong shelves.

**Verify.** On production, with two Trakt test accounts hitting the same colo, call the Trakt Airing Next preview for A and then for B within 60 s, and compare. Also check whether Trakt responds with `Cache-Control: private` (irrelevant given `cacheTtl`).

**Proposed:**

- Immediately: set `cacheTtl: 0` (or remove `cf` caching) on **every** request that carries user credentials.
- In the provider layer, make credentialed requests structurally uncacheable (NEXT_VERSION_ARCHITECTURE §6.2).
- Audit all 140 `cacheTtl` uses. MDBList calls include the user's key in the URL, so they are per-user keyed, but they still put the key into Cloudflare's cache key space; remove caching there too.

### S-04 — Provider tokens and keys: unencrypted, duplicated, unrefreshable, unrevocable

**Current.** OAuth access tokens (Trakt, MDBList, Simkl), the TMDB v3 session id and user-supplied API keys live in:

- `localStorage` (`traktAccessToken`, `simklAccessToken`, `mdblistAccessToken`, `tmdbSessionId`, keys);
- every install config;
- `creatorsync:{u}.keys` in KV (`26_:3081`);
- base64 URLs;
- backups.

Tokens arrive in URL fragments after OAuth (`25_:3438`, `3704`, `3819`, `5212`). `refresh_token` is discarded. Disconnect is client-side.

**Proposed:** `provider_connections` in D1, with tokens encrypted using AES-GCM under a `TOKEN_ENCRYPTION_KEY` secret (key id stored per row to allow rotation).

- The OAuth callback stores tokens server-side and redirects with no token in the URL.
- The UI sees only `{provider, username, status}`.
- A refresh job runs daily.
- Disconnect revokes the token at the provider (where supported) and deletes the row.
- User API keys are stored the same way.

### S-05 — XSS blast radius

**Current:**

- **Fixed by P7-1 (2026-09-29):** CSP `script-src 'self' 'nonce-<one per response>'` (`02_`), with a fresh nonce stamped into every inline `<script>`/`<style>` at the Worker's boundary (`withSecurityHeaders`, `02_`; the placeholder is `CSP_NONCE_PLACEHOLDER`, and `html_checks.py` fails the build if a rendered block lacks it). There is no `'unsafe-inline'` and no host left in `script-src`, so an injected `<script>` -- or an injected `src` to someone else's server -- is refused by the browser. `style-src-elem` is nonce-only too; `style-src` keeps `'unsafe-inline'` for the app's own `style="..."` attributes, which a nonce cannot cover. The third-party origins that used to be in the policy are gone: fflate is served from this Worker (`/vendor/fflate-0.8.2.js`, `FFLATE_UMD_JS` in `01_`) and the webfonts are the device's own (D-20). The inline handlers this line used to cite went in P6-8/P6-10.
- 326 `innerHTML` assignments in the client, against 260 `escapeHtml(` calls. Escaping is applied per call site by convention.
- User-controlled strings rendered in many places: list names, display names, channel descriptions, feedback text, provider titles.
- **Every secret is in `localStorage`:** the Creator Key, OAuth tokens and API keys.
- Previous audits found stored XSS twice (fixed).

**Problem.** One missed escape equals full account takeover, plus theft of all connected provider accounts.

**Proposed:**

- Remove secrets from `localStorage` (S-01, S-04). Session cookies are `HttpOnly`.
- ~~Move to event delegation with no inline handlers~~ (done: P6-8 on the builder page, P6-10 on /admin), ~~then a nonce-based CSP (`script-src 'self'`) for the inline `<script>` blocks~~ (done: P7-1).
- Render user strings through the existing `escapeHtml` / `escapeAttr` helpers every time, or use `textContent` (vanilla JavaScript, no framework, D-11).
- Trusted Types is **report-only** as of P7-1 (`require-trusted-types-for 'script'`, reports to `/api/csp-report`, counted in Analytics Engine and logged once per distinct violation per isolate; `FF_CSP_TT_REPORT=0` turns the reports off). Enforcement waits on the `innerHTML` sites.
- ~~Self-host `fflate`; drop jsDelivr from `script-src`~~ (done: P7-1).

---

## Medium

### S-06 — Unsalted SHA-256 blind index of the Creator Key

- **Where.** `creatorKeyLookupHash = SHA-256("keylookup:" + key)` (`02_:652-657`), stored in D1 `creator_key_lookups` and KV `keylookup:*` to support "forgot username".
- **Problem.** The key space is about 2^60. The PBKDF2 hash makes brute force per account expensive, but the lookup hash is fast and unkeyed. Anyone with a D1 or KV dump can enumerate candidate keys with a GPU and match **all accounts at once**. Expected work to crack *some* account falls by a factor of the number of accounts. For 100k accounts, that is about 2^43 SHA-256 operations, which is minutes to hours on a single modern GPU.
- **Proposed.** `HMAC-SHA256(LOOKUP_PEPPER, normalizedKey)`, with the pepper as a Worker secret. Recompute lookups on next login (the key is available then) or at key reset; drop the old table after migration. Longer term, move account recovery to email (optional) or a recovery code shown once.

### S-07 — TMDB OAuth login CSRF

- **Where.** `/api/tmdb/oauth/callback` (`25_:5165-5222`) uses `url.searchParams.get("request_token") || cookieToken` and never checks that they match.
- **Attack.** The attacker creates a request token, approves it with the attacker's TMDB account, then sends the victim `https://mylistsaddon.com/api/tmdb/oauth/callback?request_token=X&approved=true`. The victim's browser stores the attacker's session id. Any TMDB list actions the victim then takes (add or remove items, create lists) go to the attacker's account, and the victim's reads show the attacker's lists.
- **Proposed.** Require `request_token === cookieToken` (constant-time compare), and reject if the cookie is missing. In v2, store connections server-side, bound to the session.

### S-08 — Scrobble endpoint credential confusion

- **Where.** `handleMediaServerScrobble` (`26_:548-600`) accepts `st=` (a scoped scrobble token — good), **or** `config=`/`token=` (an install id, a read credential that gets shared), **or** `creator=&key=` (the master key in a URL stored in the media server's config and logs).
- **Proposed.** Accept `st=` only. Existing webhook URLs of the other two forms: log usage, show the user a banner with the new URL, and set a sunset date.

### S-09 — No CSRF defense on anonymous write endpoints

- **Where.** No route checks `Origin` or `Sec-Fetch-Site`; a search of `02_`, `25_` and `26_` finds none. JSON bodies are parsed regardless of `Content-Type` (`request.json()`), so a cross-site `fetch(..., {method:'POST', mode:'no-cors', body: JSON.stringify(...)})` with `text/plain` is a CORS "simple request": it is sent without a preflight. Removing CORS (`02_:9-14`) stops the attacker *reading* the response, not *sending* the request.
- **Impact.** A popular third-party page can make every visitor's browser:
  - like a chosen list (anonymous voter = hash(visitor IP + list), so each visitor is a "distinct voter"), manipulating the public directory ranking;
  - bump channel "adds";
  - spam telemetry and feedback;
  - call `/api/save`. The per-IP limit is useless when the IPs are real visitors.

  Authenticated creator routes are not exposed today, because they require the key in the body. **They will be exposed after the move to cookies** unless CSRF protection lands at the same time.
- **Proposed:**
  - Middleware: for state-changing methods, require `Content-Type: application/json`, **and** `Origin` equal to our origin (or `Sec-Fetch-Site: same-origin`).
  - Session cookies `SameSite=Lax`, plus a double-submit or custom-header check (`X-Requested-With: mylists`).
  - Require an account for likes and remove anonymous likes, or keep them with a lower ranking weight plus a WAF rate limit.

### S-10 — Admin authentication

- **Where.** A single `ADMIN_KEY` secret. Login is `POST /admin/login` (`26_:7012-7106`) with a KV burst limit plus a D1 daily failure budget. The session cookie is `expiresAt.HMAC(ADMIN_KEY, expiresAt)`, valid 7 days, `HttpOnly; Secure; SameSite=Strict` (`03_:1546-1589`).
- **Problem:**
  - No per-session revocation (short of rotating `ADMIN_KEY`, which is also the HMAC secret).
  - No identity; with more than one admin they share a password.
  - No audit log of destructive actions (delete lists, reset keys, moderation).
  - No second factor.
  - The admin can reset any user's key (`/admin/api/reset-creator-key`, `26_:1465`) and read any list.
- **Proposed.**
  - Put `/admin*` behind **Cloudflare Access** (Zero Trust; dashboard-configured; SSO plus MFA). Keep `ADMIN_KEY` only as a break-glass fallback.
  - Store admin sessions in D1 (revocable), with an `admin_audit_log` table written on every mutating admin call.

### S-11 — Recovery answer equals password

- **Where.** `/api/creator/reset-key` (`26_:1351-1463`). A matching recovery answer (lowercased, minimum 8 characters for new answers; older answers may be shorter) returns a **new Creator Key**. It is throttled per account (5 failures per day) and per IP.
- **Problem.** Answers to implicit security questions are guessable or findable. 5 per day × 365 is about 1,800 guesses per year per account, with no alerting.
- **Proposed.**
  - Replace with one-time recovery codes generated at signup (shown once, stored hashed), and optionally verified email for recovery.
  - Keep existing answers working, but notify active sessions on reset, and add a delay (the reset takes effect after 24 h unless cancelled from a signed-in device).

### S-12 — Unauthenticated permanent writes on `/api/save`

- **Where.** `25_:6942-7119`. Anyone can store up to `SAVED_CONFIG_BYTES_MAX = 10 MB` per call, 20 calls per minute per IP, **permanently** (no TTL, no owner).
- **Problem.** Storage and billing abuse: about 288 GB per day per IP at the limits, and more with rotating IPs or S-09. It is also an anonymous public blob store (arbitrary JSON in `entries`).
- **Proposed.**
  - v2: anonymous installs are allowed but small (a few hundred rows, a few KB), with an expiry of 180 days since `last_used_at`, extended on use.
  - Large channel and list content must be entities owned by an account.
  - WAF rate limit on the create route.

### S-13 — Rate limiting

- **Where.** KV `ratelimit:*` (`02_:1698-1708`, plus 8 inline copies). The code acknowledges that stale reads let bursts through. Most limits key only on IP; IPv6 is collapsed to /64 (good).
- **Proposed.** WAF rate-limiting rules for per-IP limits at the edge, plus D1 atomic counters for per-account and per-credential limits (FT-13). For login: per-username and per-IP limits with exponential backoff.

### S-14 — Secrets in logs

- **Where:**
  - `safeErrorMessage` logs the **original** error (`02_:240-245`).
  - Many `console.error("…", e)` calls log errors whose messages or stacks can include request URLs.
  - TMDB and MDBList keys travel in query strings (`api_key=`, `apikey=`) across about 84 TMDB URL templates.
  - Workers Logs and Logpush retain logs.
- **Proposed.**
  - A logger that redacts `api_key`, `apikey`, `access_token`, `key` and `token` parameters and `Authorization` headers before emitting.
  - Prefer header-based auth where providers support it: TMDB v4 bearer tokens accept `Authorization: Bearer` on v3 endpoints.

### S-15 — Credentials in query strings

- **Where:**
  - `/api/preview` GET: `creatorKey`, `traktAccessToken`, `mdblistKey` (`25_:1157-1164`).
  - `/api/feedback/threads` GET: `creatorKey` (`25_:6197`).
  - `/api/simkl/my-lists`: `?token=` (`25_:3830`).
  - `/api/tmdb-my-lists`: `?sessionId=` (`25_:5225`).
  - `/api/mdblist-my-lists`: `?accessToken=` (`25_:6434`).
  - `/api/scrobble`: `key=` (`26_:556`).
- **Proposed.** Reject credentials in query strings, except the scoped scrobble token and the install token (which are designed for URLs). v2 needs none of the others.

### S-16 — PBKDF2 cost

- **Where.** `PBKDF2_ITERATIONS = 100000` with SHA-256 (`02_:511`). OWASP's current guidance for PBKDF2-HMAC-SHA256 is 600,000.
- **Proposed.** With sessions, verification runs only at login, so raise the iterations. Rehash on successful login (the stored format already encodes the iteration count).

---

## Low

- **S-17** — Anonymous published lists (`publishedlist:user:*`, D1 `published_lists`) have no owner, and only the admin can remove them. Creation was removed in 1.5.3. Migrate them as `legacy_anonymous` and offer a "claim" flow only if provenance can be proven (it can't), so keep them admin-moderated.
- **S-18** — `/admin/login` has no CSRF token (login CSRF: forcing an admin session is low impact). `?debug=1` on the Trakt and MDBList OAuth start pages (`25_:3306`, `25_:3582`) prints configuration to anyone. It is not secret, but it isn't needed in production.
- **S-19** — `failWith("network", err.message || String(err))` in the TMDB callback (`25_:5217-5219`) bypasses `safeErrorMessage`.
- **S-20** — Anonymous voter id = `SHA-256(ip|listId)` truncated (`02_:1778-1784`). It is not keyed, so a leaked ledger lets anyone test candidate IPs. Use `HMAC(secret, ip|target)`.

## Info

- **S-21** — `COMPLETE_AUDIT_REPORT.md` §0 records that `my-lists-full-backup1.json`, containing a Creator Key and live Trakt, MDBList and Simkl tokens, was committed to a **public** repository with a fork. The file was removed, but it is still in git history. **Confirm that those credentials were rotated or revoked**, and rewrite history, or accept that the fork holds them.
- **S-22** — `/api/creator/create` answers "That username is already taken", so usernames are enumerable. They are also public in `/lists/public.json`. Acceptable.
- **S-23** — New on Streaming uses JustWatch's unofficial GraphQL API with no terms (`00_:325-336`). This is a legal and operational risk; see BACKEND_AUDIT BE-M12.

---

## Other checks (no finding)

| Check | Result |
|---|---|
| SQL injection | All D1 access uses `prepare().bind()`. Dynamic SQL is limited to placeholder lists and table and column names from constants (`d1ReplaceRowsById` takes `table`/`keyColumn` from internal callers only). LIKE patterns are escaped (`escapeLikePrefix`, `purgeCreatorData`). **OK.** |
| Path traversal | No filesystem access. KV keys are built from validated usernames and slugs (`validateCreatorUsername`, `slugifyServer`). **OK.** |
| Open redirect | `/api/poster-badge` redirect limited to allowlisted image hosts; OAuth redirects go to our origin. **OK.** |
| SSRF | `/api/preview`, `/api/poster-badge` and `/api/channel-logo` are allowlisted. `/api/resolve`'s remote proxy is allowlisted by DNS name but should be removed (FT-10). **OK after removal.** |
| IDOR on lists | Creator list mutations authenticate and derive the owner from the key. Private lists return 404 on public routes and likes (`25_:7178-7180`). **OK.** |
| Private tracking shelves | Gated by `mayReadTrackedShelf` on all four read paths (the SEC-001 fix). **OK**, but see S-02: install id holders are treated as owners. |
| Replay | Creator requests are replayable indefinitely (no nonce or session); fixed by S-01. OAuth state cookies are single-use per 10 min. |
| Account takeover paths | Key leak (S-01), recovery answer (S-11), admin key reset (S-10), XSS (S-05). |
| Clickjacking | `frame-ancestors 'self'`, `X-Frame-Options: SAMEORIGIN`. **OK.** |
| Session fixation | N/A today; required in the v2 session design (rotate the token at login). |

## Fix priority

1. **Before anything else (hotfix, Phase 1):**
   - S-03 (remove `cacheTtl` on credentialed calls).
   - S-07 (bind the TMDB token to the cookie).
   - Stop generating base64 configs with secrets (FT-09).
   - Stop storing `trackCreatorKey` in new configs, and derive ownership from a server-stamped `trackOwner` plus install binding instead. If ownership can't be bound yet, keep storing it for now, but at least stop the base64 path.
   - S-15 (reject credentials in query strings on the non-webhook routes).
   - S-21 (confirm rotation).
2. **Phase 7 (with sessions):** S-01, S-02, S-04, S-06, S-08, S-09, S-11, S-16.
3. **Phase 6 (with the frontend rewrite):** S-05 CSP and Trusted Types.
4. **Ongoing:** S-10 Cloudflare Access for admin, S-12, S-13, S-14.
