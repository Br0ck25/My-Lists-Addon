# Security Audit — My Lists

**Date:** 2026-09-24 · **Method:** source review of every authentication, authorization, input, output and outbound-request path; targeted reproductions against the real Worker on a local in-memory harness (no production system was touched); review of the prior audits' security claims. Nothing was assumed safe because it runs behind Cloudflare.

**Severity:** Critical · High · Medium · Low · Info. Status: **CONFIRMED** (reproduced), **VERIFIED** (deterministic in code), **LIKELY** (depends on conditions).

---

## 0. Summary

The previous audit rounds fixed a long list of concrete bugs (SEC-001 shelf disclosure, stored XSS through the script preamble, SSRF on `/api/resolve`, open image proxy on `/api/poster-badge`, LIKE-wildcard purge, fail-open token rotation). What remains is mostly **design-level**: the product's credentials are long-lived bearer secrets that are copied into places the user cannot see or revoke, and ownership is expressed as a reusable username string.

| ID | Severity | Title | Status |
|---|---|---|---|
| S-1 | **High** | Install configs store and hand out provider OAuth tokens, API keys and the account key | VERIFIED |
| S-2 | **High** | Master-key authentication: one un-scoped, long-lived secret in every request, in `localStorage`, in configs and backups | VERIFIED |
| S-3 | **High** | Anonymous channel shares can be overwritten or claimed by anyone holding the link | CONFIRMED |
| S-4 | **High** | Account deletion leaves published channels, install configs (with tokens) and votes; a re-registered username inherits channel ownership | VERIFIED |
| S-5 | **High** | Credential exposure from the historical public backup commit — rotation cannot be verified from the repository | VERIFIED (history) |
| S-6 | Medium | CSP allows inline script and any HTTPS connect/img destination, over ~330 `innerHTML` sinks | VERIFIED |
| S-7 | Medium | Rate limiting is non-atomic KV read-then-write; per-IP only on credential endpoints | VERIFIED |
| S-8 | Medium | `forgot-username` fallback performs up to 50 PBKDF2 verifications per unauthenticated request | VERIFIED |
| S-9 | Medium | Admin: single shared secret, stateless 7-day cookie, no revocation, no MFA, no audit log | VERIFIED |
| S-10 | Medium | Webhook filter bypass/crash lets a household's other users' plays into the owner's history | CONFIRMED |
| S-11 | Medium | Legacy webhook auth accepts `creator=&key=` (the master key) in a URL | VERIFIED |
| S-12 | Medium | `LEGACY_UNVERIFIED_CONFIG_SHELVES = true` keeps a SEC-001 residual open | VERIFIED |
| S-13 | Medium | OAuth tokens returned via URL fragment and stored client-side; no refresh, no server-side revocation | VERIFIED |
| S-14 | Medium | Unauthenticated, un-rate-limited permanent writes: anonymous channel shares (4 MB each) and install configs | CONFIRMED / VERIFIED |
| S-15 | Low | Anonymous like voter ids are unsalted hashes of the client IP | VERIFIED |
| S-16 | Low | `/api/preview` echoes raw upstream error messages | VERIFIED |
| S-17 | Low | Trakt device endpoints pair a caller-supplied client id with the server's client secret; unauthenticated, no rate limit | VERIFIED |
| S-18 | Low | Latent auth-confusion code in `getCreator` (hyphen-insensitive lookup that would cache another account's record under a new name) | VERIFIED (dead today) |
| S-19 | Low / business | Unofficial JustWatch GraphQL use | VERIFIED |
| S-20 | Low | Provider API keys travel in query strings (TMDB `api_key=`), increasing log exposure | VERIFIED |
| S-21 | Info | Arbitrary ≤12-character KV key reads via legacy install ids | VERIFIED |
| S-22 | Info | Username enumeration via signup/"taken" responses and the public directory | By design |

Checked and **not** found vulnerable: SQL injection (all D1 access is parameterized; the only interpolated identifiers are internal constants in `d1ReplaceRowsById`), path traversal (no filesystem; KV keys built from validated slugs/usernames), open redirects (redirects are same-origin or to allowlisted image hosts), SSRF (`/api/poster-badge` and `/api/channel-logo` are host-/shape-allowlisted; `/api/resolve`'s cross-origin fetch is allowlisted — and should be removed entirely, see FT-25), CSRF on account routes (credentials travel in JSON bodies, not cookies; admin cookie is `SameSite=Strict`, `/admin/logout` requires POST), timing leaks on key/admin comparisons (`timingSafeEqualHex`/`timingSafeEqualSecret`), stored XSS through the server-rendered preamble (`jsonForScript` + the hostile-render CI check), shelf disclosure (SEC-001 gate present on catalog, preview and resolve paths).

---

## 1. High

### S-1 · Install configs store and hand out secrets — VERIFIED
* **Where:** `/api/save` (25:7032–7055) stores `tmdbKey`, `mdblistKey`, `mdblistAccessToken`, `traktKey`, `traktAccessToken`, `simklKey`, `simklAccessToken`, and — whenever a personal shelf is present — `trackCreatorKey` (**the account's plaintext key**) in `cfg:{id}`, permanently. `/api/resolve?config={id}` (25:6863–6934) returns the MDBList key and the Trakt/MDBList access tokens to **any caller with the 12-character id**, unauthenticated. `/{id}/configure` (25:465–489) renders the same tokens into the HTML of the configure page.
* **Why it matters:** the install URL is not treated as a secret by users or by the ecosystem — it is pasted into Stremio, shown in the app's add-on list, synced to Stremio's cloud add-on collection, shared on forums and in screenshots, and sent to support. Anyone who sees it can read the owner's provider tokens (read/write access to their Trakt/MDBList account, including list deletion via `/api/external-list/delete`). The account key stored alongside is readable by anyone with KV access (operators, a leaked API token) and survives account deletion (S-4).
* **Attack:** obtain a user's install URL → `GET /api/resolve?config=<id>` → use `traktAccessToken` directly against `api.trakt.tv` until it expires (~90 days).
* **Fix:**
  1. **Now (Phase 1):** stop returning tokens and keys from `/api/resolve` (return entries only); stop rendering tokens into `/{config}/configure`; stop storing `trackCreatorKey` in new configs (store `trackOwner` only — it is already verified at save time).
  2. **Phase 3/7:** install tokens scoped to an add-on profile; provider credentials only in the encrypted vault; legacy configs migrated with secrets moved to the vault (when the owner is known) or discarded.
* **Severity rationale:** High, not Critical, because exploitation requires obtaining the install URL; but URLs are shared routinely and the impact is third-party account takeover within the token's scope.

### S-2 · Master-key authentication — VERIFIED
* **Where:** `authenticateCreator` (26:12–88) on every account route; the key sent in JSON bodies; `localStorage['myListAddon:creatorKey']` (51 read/write sites); `collectKeys()` copies it into install configs (23:600) and backups (24:132–186); legacy webhook URLs carry it (S-11).
* **Problem:** one credential does everything, never expires, cannot be scoped, and can only be revoked by rotating it (which breaks every device and link). Any XSS (see S-6) or malicious browser extension reads it from `localStorage`. PBKDF2 per request also makes every authenticated endpoint a CPU-cost target, which is why a verification throttle and an in-isolate success memo exist.
* **Fix:** sessions (HttpOnly `__Host-` cookie, server-side records, device list, revoke); the key becomes a login factor only; add passkeys; per-purpose tokens (add-on, webhook) that are hashed at rest and revocable.

### S-3 · Anonymous channel shares can be overwritten or claimed — CONFIRMED
* **Where:** `/api/channel/share` POST (26:2473–2569). With a `code` whose record has no owner, the ownership check (`existing.owner && existing.owner !== owner`) is skipped and the record is replaced; a signed-in caller becomes the owner (`owner || existing.owner`) and can publish it under their name.
* **Reproduction:** anonymous share created → second anonymous POST with the same `code` and different content → the share now serves the attacker's channel.
* **Impact:** anyone who sees a shared channel link can replace its contents (spam, offensive content, links to unrelated media) for everyone who opens or imports it; channels can be "stolen" into the directory.
* **Fix:** anonymous shares are immutable (edits mint a new code, or require an edit secret returned only at creation); claiming requires that secret; rate-limit anonymous shares.

### S-4 · Deletion is incomplete; usernames are reusable identities — VERIFIED
* **Where:** `purgeCreatorData` (02:3022–3446). Not removed: `channelshare:*` owned by the account, `creatorchannel:{u}:*`, `index:publicchannels` entries, channel/list votes cast as `u:{username}`, `cfg:*` install configs (plaintext key + OAuth tokens), `feedback:*`.
* **Impact:** personal data and third-party tokens persist after the user was told everything was deleted (a data-protection problem); the next person to register the username passes owner checks for the previous owner's channels (`record.owner !== auth.username` is false) and `/channels/{u}/{slug}` still resolves.
* **Fix:** immutable account ids as owners; cascade deletes; username holds; a deletion job that also purges install configs by owner (requires the new model's `owner_account_id` on `legacy_installs`, backfilled from `trackOwner`/`trackCreatorName`).

### S-5 · Historical credential exposure — VERIFIED (history only)
* **Where:** `COMPLETE_AUDIT_REPORT.md` §0 records that `my-lists-full-backup1.json`, committed to a public repository with a fork, contained an account key and live Trakt, MDBList and Simkl OAuth tokens. The file was removed and `.gitignore` now blocks the pattern, but git history retains it.
* **Action:** confirm (outside the repo) that the affected account key was rotated and the three provider connections were revoked at the providers; consider history rewriting if the fork owner cooperates. Treat as open until confirmed.

---

## 2. Medium

### S-6 · CSP permits inline script and unrestricted egress
* **Where:** `securityHeaders()` (02:94–114): `script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net`, `connect-src 'self' https:`, `img-src 'self' https: data:`.
* **Context:** ~330 `innerHTML` assignments and ~700 inline event handlers in the client; `escapeHtml` is applied carefully and CI renders a hostile page, so no live XSS was found. But one missed escape anywhere yields full account takeover (S-2) and the CSP would let the script exfiltrate to any HTTPS host.
* **Fix:** with the Phase 6 client: no inline handlers, nonce-based `script-src`, `connect-src` limited to the API and provider OAuth hosts actually needed, `img-src` limited to image hosts in use, and Trusted Types for DOM sinks.

### S-7 · Rate limiting is bypassable and IP-only on credentials
* **Where:** `consumeRateLimit` (02:1698) and inline copies (see FT-30). Read-then-write on edge-cached KV — N concurrent requests all read the same count. Credential endpoints (`/api/creator/restore`, `/admin/login`, `/api/creator/reset-key`) have per-IP buckets; only reset-key also has a per-account failure budget.
* **Fix:** Cloudflare rate-limiting rules/binding (atomic); per-account and per-IP limits on every credential check; exponential backoff for repeated failures on one account.

### S-8 · `forgot-username` fallback CPU amplification
* **Where:** 26:1597–1617. On an index miss, verifies the presented key against up to 50 accounts' PBKDF2 hashes (≈750 ms CPU). Per-IP limit 5 per 15 minutes.
* **Fix:** delete the fallback (lookup hashes are written on every login/restore/rotation).

### S-9 · Admin authentication
* **Where:** `/admin/login` (26:7012+), `makeAdminCookieValue`/`isValidAdminCookie` (03:1549–1565): one `ADMIN_KEY`; cookie = expiry + HMAC(ADMIN_KEY, expiry), valid 7 days, `SameSite=Strict`, HttpOnly, Secure. No per-admin identity, no revocation short of rotating `ADMIN_KEY`, no MFA, no audit log of destructive actions (key resets, list deletions, channel moderation, migrations).
* **Fix:** Cloudflare Access (or admin accounts with passkeys/TOTP) in front of `/admin`; server-side admin sessions; `admin_audit_log`.

### S-10 · Webhook user filter bypass and crash
* **Where:** `handleMediaServerScrobble` (26:774–854). URL `filterUsers`/`allowedUsers` are overridden by the account's saved default; the account-level filter crashes with a TDZ `ReferenceError` (BACKEND_AUDIT B-H1).
* **Impact:** privacy inside a household/shared media server: other users' plays land in the owner's history (reproduced with `mallory` recorded despite `allowedUsers=alice` in the URL).
* **Fix:** explicit precedence; compute `pingId` first; tests.

### S-11 · Master key in webhook URLs
* **Where:** `/api/scrobble?creator=&key=` still accepted (26:586–591) "because webhook URLs handed out before scrobble tokens existed are sitting in people's media servers".
* **Fix:** in-app warning for accounts whose recent webhooks used the legacy form (count via Analytics Engine), a published sunset date, then removal; rotate the key for accounts that used it.

### S-12 · SEC-001 residual via legacy configs
* **Where:** `LEGACY_UNVERIFIED_CONFIG_SHELVES = true` (00:740); `resolveConfig` (04:75–77) honours personal shelves in configs saved before ownership was verified.
* **Fix:** measure usage now; at migration, bind a legacy config to its account only if the config's stored key still verifies; otherwise drop personal shelves and notify the owner.

### S-13 · OAuth token handling
* **Where:** Trakt callback redirects to `/#trakt_token=…&trakt_username=…` (25:3438); MDBList/Simkl similar; device flow returns `access_token` in JSON; tokens kept in `localStorage`, copied into configs and backups; no `refresh_token` stored anywhere; "Disconnect" only deletes the local copy.
* **Fix:** server-side vault with encryption at rest, refresh job, upstream revocation on disconnect, least-privilege scopes, the browser never sees tokens.

### S-14 · Unauthenticated permanent storage writes
* **Where:** `/api/channel/share` (anonymous, **no rate limit**, up to 4 MB, permanent); `/api/save` (20/min per IP, up to 10 MB, permanent, never deleted).
* **Impact:** storage-cost abuse and content hosting on the product's domain.
* **Fix:** rate limits (per IP and global), lower anonymous size caps, TTL for unclaimed anonymous content, and in the new model install configs belong to profiles.

---

## 3. Low / Info

| ID | Finding | Fix |
|---|---|---|
| S-15 | Anonymous like voter id = `SHA-256(ip + "|" + listScope)` truncated to 128 bits (02:1778–1784). Without a server secret, the IPv4 space can be enumerated per list to recover who liked what. | HMAC with a server secret (pepper); or require sign-in to like. |
| S-16 | `/api/preview` returns `err.message` directly (25:1270–1273), bypassing `safeErrorMessage`'s URL/token stripping; today provider errors are status-only, but it is one careless `throw` away from leaking a URL with `api_key=`. | Use `safeErrorMessage`. |
| S-17 | `/api/trakt/device/{code,token}` accept `traktKey`/`clientId` from the body and send the server's `TRAKT_CLIENT_SECRET` with it (25:3451–3518); no rate limit. | Server client id only; rate limit per IP. |
| S-18 | `getCreator`'s hyphen-insensitive fallback (02:3499–3503) is dead only because of a `.length` bug; if repaired it would return another account's record (and cache it under the requested name) — an authentication confusion. | Delete. |
| S-19 | JustWatch GraphQL is used without a key or published terms (00:325–349 says "Using it here is the operator's call"). | Legal review; flag off by default until cleared. |
| S-20 | TMDB's key travels as `?api_key=` in ~100 outbound URLs; any logged fetch error or URL could expose it. | TMDB v4 read access token in an `Authorization` header; scrub URLs in logs. |
| S-21 | `resolveConfig` reads **any** KV key of ≤12 characters (`CONFIGS.get(configParam)`, 04:25–26); only whitelisted fields are projected into the response today. | Strict id format; move legacy ids to a table. |
| S-22 | Signup reveals whether a username exists; `/lists/public.json` publishes creator usernames. | Acceptable by design; keep generic errors on credential endpoints (already done). |

---

## 4. Checklist results (Phase 12)

| Area | Result |
|---|---|
| Authentication | Master key per request (S-2); PBKDF2 100k iterations with per-credential salt; constant-time comparisons; no sessions; no MFA. |
| Authorization / creator ownership | Account routes resolve the username from the verified key (no IDOR found on lists/sync). Ownership of channels is a username string (S-3, S-4). Private lists return the same 404 as missing lists (no oracle). |
| Creator keys | ~60 bits of entropy from a 32-symbol alphabet; fine as a login factor; unsafe as a universal bearer secret (S-2). |
| Public/private lists | Visibility fails closed (`=== "public"`); legacy records stamped lazily. Tracking shelves gated by explicit share flags. Default visibility for new lists/channels is **public** in the UI (FRONTEND F-H5). |
| Admin access | S-9. |
| OAuth state | HttpOnly Path-scoped `SameSite=Lax` state cookies, 10-minute lifetime, constant-time compare; MDBList uses PKCE. Good. |
| OAuth tokens | S-1, S-13. |
| Secrets / API keys | Worker secrets for provider keys (good); user-supplied provider keys stored in configs and backups (S-1). |
| Input validation | Usernames, slugs, display names, list sizes, item counts, config sizes, channel sanitization are validated server-side. Webhook payload parsing is permissive but typed. |
| SQL injection | None found. |
| XSS | None found live; defence depends on manual escaping (S-6). |
| CSRF | Not applicable to JSON-body credentials; admin cookie `SameSite=Strict`. The new session cookie must use `SameSite=Lax` plus a CSRF token or `Sec-Fetch-Site` checks for state-changing requests. |
| SSRF | Allowlisted; remove `/api/resolve` remote fetch (FT-25). |
| Open redirects | None found. |
| Path traversal | Not applicable. |
| Rate limiting / abuse | S-7, S-14; unauthenticated provider-proxy endpoints spend the shared TMDB key (`/api/title-search`, `/api/season`, `/api/details`, etc.) with per-IP limits on some only. |
| Enumeration | S-22 (acceptable). |
| Brute force | Per-IP limits + per-account budget on reset-key; restore relies on per-IP limits and a daily per-IP budget. |
| Account takeover | Via S-1 (provider accounts), via stolen `localStorage` (S-2, S-6), via weak recovery answers (mitigated by min length 8 and per-account budget). |
| Replay | Webhooks are not signed (Plex/Jellyfin/Emby do not sign); scrobble token scoping limits impact. Consider idempotency keys for webhook events. |
| IDOR | None found on account routes; channel shares S-3. |
| Information disclosure | S-16; `/api/creator/track-status` returns diagnostics only to the owner. |
| Logging of secrets / PII | `console.error("handled error:", err)` logs full error objects; URLs with `api_key=` can appear (S-20); IP addresses are used as rate-limit keys (not logged by the app). Define a logging policy: no tokens, no keys, hashed IPs. |

---

## 5. Recommended order

1. **Phase 1 (immediately, current codebase):** S-1 steps 1–3 (stop returning/storing/rendering secrets), S-3 (immutable anonymous shares), S-4 interim (delete channels on account deletion; username hold), S-8, S-10, S-16, S-17, S-18, rate limit on anonymous shares (S-14); confirm S-5 rotation.
2. **Phase 3 (data model):** immutable ids; `provider_connections` vault schema; `addon_tokens`; `legacy_installs` with secrets removed.
3. **Phase 7 (security hardening):** sessions + passkeys; token vault + refresh + revoke; admin behind Access/MFA with audit log; rate-limit binding everywhere; CSP nonces + Trusted Types (requires the Phase 6 client); sunset legacy webhook auth (S-11) and legacy unverified shelves (S-12).
