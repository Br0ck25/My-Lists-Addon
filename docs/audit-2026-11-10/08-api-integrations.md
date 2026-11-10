# 08 API and integrations
Health grade: (see end, filled in last)

## Scope covered
- Stremio/Nuvio/Wako contract: `/:config/manifest.json`, `/catalog/:type/:id[/extra].json`, `/meta/...`, `/subtitles/...`, `/i/<token>/...`, `/c/...`, bare `/manifest.json`, OPTIONS/HEAD/POST on them. Files: `src/api/70_stremio-routes.js`, `src/api/25_api-catalog-routes.js`, `src/catalog/05_catalog-core.js` (`buildManifest`), `src/core/02_http-and-creator-utils.js` (`fetch` guard, caches, CORS).
- Provider fetchers MDBList/Trakt/TMDB/Simkl (`src/catalog/06_*`, `07_*`), failure matrix with stubs: HTTP 500, 429, HTML-with-200, empty-with-200, error-object-with-200, null items, network throw, hang (10 s abort).
- Provider breaker `src/catalog/41_provider-breaker.js`.
- Legacy install URL formats (`resolveConfig`, `decodeConfig`).
- OAuth Trakt/MDBList/Simkl callbacks and token refresh (`src/api/75_*`, `src/api/28_connections.js`, `src/jobs/50_token-refresh.js`), client side pick-up (`src/client/17_client-my-lists-and-trakt-oauth.js`).
- Harness: `/tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s08/` (`lib.mjs` stubs `globalThis.fetch` with the real fixtures from `tests/fixtures/providers`, then calls `worker.fetch` through `tests/harness.mjs`). Dev server on 8880/8881 for the browser checks (stopped at the end).

## Proven findings

### API-01 A failing KV read turns manifest and catalog answers into a bare 500 with no CORS header and an internal error message
- Severity: Medium
- Status: Proven
- File:line: `src/api/26_api-creator-and-admin-routes.js:114-139` (the one top-level `catch`), reached from `src/core/04_config-resolution.js:114` (`env.CONFIGS.get` is not guarded) via `installManifest` / `stremioCatalogRow` (`src/api/70_stremio-routes.js:99, 190`)
- What is wrong: The catalog route has careful "provider is down" handling (placeholder tile, last good copy, no-store). But if the *install lookup itself* throws (Cloudflare KV answering 5xx or a rate-limit error), nothing on the path catches it. The outer catch builds `json({ok:false,error:<message>}, 500)` with plain `json()`, which carries no `Access-Control-Allow-Origin`. The raw error text of the platform ("KV GET failed: 503 Service Unavailable") is sent to the app. The meta route is the only one of the four that catches it and answers 200 `{meta:null}`.
- Impact: During a short KV hiccup every Stremio/Nuvio/Wako request for the manifest or a row gets HTTP 500 instead of an empty row. Apps treat a 500 manifest as "addon failing" (worse than an empty shelf). In the browser app (web.stremio.com) the 500 shows as an opaque CORS error. The same 500 is not cached (no-store), so it recovers on the next request, which is why this is Medium, not High.
- Proof: `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s08/t7_kvdown.mjs` (install created normally, then `env.CONFIGS.get` made to throw):
```
/ID/manifest.json 500 cors=null cc=no-store {"ok":false,"error":"KV GET failed: 503 Service Unavailable"}
/ID/catalog/movie/m1.json 500 cors=null cc=no-store {"ok":false,"error":"KV GET failed: 503 Service Unavailable"}
/ID/meta/movie/tt0111161.json 200 cors=* cc=no-store {"meta":null,"error":"KV GET failed: 503 Service Unavailable"}
/ID/catalog/movie/search_movies/search=x.json 500 cors=null cc=no-store {"ok":false,"error":"KV GET failed: 503 Service Unavailable"}
```
  Contrast: a provider failure on the same route returns 200 with CORS (see t3 output below).
- Recommended fix: In the top-level catch (line 139) use `jsonPublic`-style CORS headers when `isPublicCorsPath(path)` is true, and for `/catalog/` and `/meta/` paths answer 200 `{metas:[]}` / `{meta:null}` with `no-store`; never echo the platform message. Effort S.

### API-02 A broken Trakt token refresh is treated as "the person must sign in again" when Trakt (or Cloudflare in front of it) answers 403
- Severity: Medium
- Status: Proven
- File:line: `src/api/28_connections.js:517` (Trakt) and `:566` (MDBList): `if (res.status === 400 || res.status === 401 || res.status === 403) rejected = true`; consumed by `src/jobs/50_token-refresh.js:58-70` (`markConnectionStatus(..., "reauth_required")`)
- What is wrong: The function's own comment says "a transient failure must not mark a connection broken". But 403 is treated as a definite refusal. Trakt sits behind Cloudflare, and the same codebase already knows that Trakt answers bursts with 429/**403** and a Cloudflare 1015 page (`src/api/75_provider-list-and-oauth-routes.js:635` retries on 403; `src/client/17_...:860` talks about "rate-limited by Cloudflare (1015)"). The daily `token.refresh` job refreshes up to 500 connections in one run, which is exactly the burst that triggers such a block.
- Impact: A person whose Trakt/MDBList token was perfectly healthy is flipped to `reauth_required`. Their personal rows (Watchlist, Continue Watching, Up Next) in Stremio/Nuvio are replaced by a single "Reconnect Trakt at mylistsaddon.com" tile until they open the website and sign in again. The refresh token was never consumed, so nothing had actually gone wrong.
- Proof: `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s08/t9_refresh.mjs 403cf` (real Worker + queue + D1; Trakt stub answers the refresh call with a Cloudflare 1015 HTML 403):
```
[Jobs] token.refresh: 0 renewed, 1 need signing in again, 0 left for tomorrow.
mode=403cf refreshCalls=2 {"status":"reauth_required","last_error":"The provider refused to renew this sign-in. Connect it again."}
```
  Control run `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s08/t9_refresh.mjs 503` leaves the connection `ok`, so the guard is only wrong for 403.
- Recommended fix: Treat only 400 (invalid_grant) and 401 as a refusal; treat 403 and 429 as "could not be asked" (return null, retry tomorrow). Optionally require a JSON body with `error=invalid_grant` before marking. Effort S.

### API-03 Anyone can put their own wording into the app's Trakt/MDBList error dialog through a link; and a real exchange failure is always described as "rate-limited by Cloudflare"
- Severity: Low
- Status: Proven
- File:line: `src/client/17_client-my-lists-and-trakt-oauth.js:851-866` (`pickUpTraktTokenFromUrl`); the server side hands any text through: `src/api/75_provider-list-and-oauth-routes.js:593` (`failWith(url.searchParams.get("error"))`)
- What is wrong: The page reads `?trakt_error=<anything>&trakt_error_detail=<anything>` from the address bar and puts both into a modal titled "Trakt Connection" ("Could not connect to Trakt (<error>: <detail>)"). The text is HTML-escaped (no script injection), but the wording is fully attacker-chosen. Separately, `err === 'exchange_failed'` is hard-wired to the message "rate-limited by Cloudflare (1015)" and to opening the device-code login, even when the true cause is e.g. `invalid_grant` or a wrong client secret; the real detail is thrown away.
- Impact: A link such as `https://<site>/?trakt_error=Security%20alert&trakt_error_detail=Call%20support%20on%200800...` shows that sentence inside the site's own trusted dialog (phishing/social-engineering text, no links or markup possible). For genuine failures the owner/user is misled about the cause.
- Proof: `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s08/t8_pw.cjs` against the dev server (Chromium, 390 px wide). Screenshot `/tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s08/trakt_err_3.png` shows the dialog "Trakt Connection - Could not connect to Trakt (Security alert: Call support on 0800 123 456 to restore your account)." Screenshot `/tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s08/trakt_err_2.png` shows that `trakt_error=exchange_failed&trakt_error_detail=invalid_grant...` produces the unrelated "Sign in to connect your Trakt account" dialog (device-code fallback), with the detail discarded.
- Recommended fix: Show only messages from a fixed list; map unknown codes to "Could not connect to Trakt"; log `detail` instead of displaying it; limit the 1015 wording to detail that actually contains 429/1015. Effort S.
