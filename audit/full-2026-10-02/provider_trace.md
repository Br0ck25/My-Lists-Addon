# External Provider Integration & Fault-Tolerance Trace

**Audit Scope:** Module 07 — External Providers, Circuit Breakers, ID Normalization, and Snapshot Invariants  
**Audit Date:** 2026-10-02  
**Target Codebase:** My Lists Addon (`wrangler.toml`, `06_source-fetchers-mdblist-trakt.js`, `07_source-fetchers-tmdb-simkl.js`, `41_provider-breaker.js`, `42_chart-snapshots.js`, `43_catalog-ids.js`, `50_token-refresh.js`, `52_poster-fetch.js`, `57_title-details-fallback.js`)

---

## 1. Provider Topology Overview

The application integrates with multiple third-party metadata and list providers. All outbound traffic routes through Cloudflare Worker global `fetch()`, governed by:
1. **The Circuit Breaker (`41_provider-breaker.js`):** Intercepts outbound calls, tracking consecutive failures (HTTP 5xx, 429, timeouts).
2. **Chart Snapshots (`42_chart-snapshots.js`):** Multi-tier caching in isolate memory and KV (`snap:chart:*`), protecting against upstream downtime and rate limits.
3. **Canonical ID Adapter (`43_catalog-ids.js`):** Normalizes heterogeneous provider identifiers into Stremio-openable IDs (`tt...` IMDb or `tmdb:...`).

| Provider | Purpose | Primary Endpoints | Auth Mechanism | Rate Limit / Quota Behavior |
|---|---|---|---|---|
| **TMDB** | Metadata, trending, genre charts, network/provider discovery | `api.themoviedb.org/3/*` | `api_key` query param | HTTP 429 backoff; 5 failures trips breaker |
| **Trakt.tv** | User lists, watchlist, continue watching, trending charts | `api.trakt.tv/*` | `trakt-api-key` header, OAuth Bearer token | HTTP 429 backoff; OAuth token expires in ~3 months |
| **MDBList** | User lists, watchlist, toplists proxy | `api.mdblist.com/*` | `apikey` param or Bearer token | HTTP 429 / 401 handling; circuit breaker |
| **Simkl** | User lists, best anime / TV / movie charts | `api.simkl.com/*` | `simkl-api-client` header, Bearer token | Circuit breaker integration |
| **RapidAPI** | Streaming Availability for New on Streaming | `streaming-availability.p.rapidapi.com` | `x-rapidapi-key` header | D1 atomic monthly quota ledger (`ledger:rapidapi`) |
| **JustWatch** | Public streaming availability feeds (default engine) | `apis.justwatch.com/*` | None (public feed) | Built-in fallback when RapidAPI key absent |
| **Metahub / RPDB** | Poster & artwork resolution | `images.metahub.space/*`, RPDB | URL pattern / API key | Fallback chain to TMDB posters |

---

## 2. Deep-Dive Provider Traces

### 2.1 The Movie Database (TMDB)

- **Source File:** `07_source-fetchers-tmdb-simkl.js`
- **Request Construction:**
  - Base: `https://api.themoviedb.org/3/`
  - Authentication: `api_key=${encodeURIComponent(apiKey)}` appended to query string.
  - User-Agent: `my-list-addon/1.9`.
  - Cache options: `cf: { cacheTtl: 900, cacheEverything: true }`.
- **Movie vs Series Discrimination:**
  - Standard charts use distinct paths:
    - Movies: `/discover/movie`, `/movie/popular`, `/movie/top_rated`, `/movie/now_playing`, `/movie/upcoming`.
    - TV Series: `/discover/tv`, `/tv/popular`, `/tv/top_rated`, `/tv/airing_today`, `/tv/on_the_air`.
  - Multi-search & discover: `mapTmdbItem` reads `media_type === "movie" ? "movie" : "series"`.
- **ID Normalization & Episode Mapping:**
  - For series: queries `/tv/{id}/season/{season}` to retrieve episode listings.
  - IDs are resolved via `/external_ids` to fetch IMDb ID (`imdb_id`).
  - Titles lacking IMDb IDs fall back to canonical `tmdb:{id}` syntax.
- **Error Handling & Failure Protection:**
  - In `fetchTmdbPagedResults`: if `!pageResults[0].ok`, throws `Error("TMDB request failed (HTTP ${status})")`.
  - Errors are NOT swallowed or returned as empty arrays `[]`.
  - HTTP 401 raises an explicit hint to verify API keys in Settings.

### 2.2 Trakt.tv

- **Source File:** `06_source-fetchers-mdblist-trakt.js`
- **Request Construction:**
  - Base: `https://api.trakt.tv/`
  - Headers:
    - `trakt-api-version: 2`
    - `trakt-api-key: <TRAKT_CLIENT_ID>`
    - Optional `Authorization: Bearer <accessToken>` for personal user lists/history.
  - Pagination: Uses `?page=${Math.floor(skip / PAGE_SIZE) + 1}&limit=${PAGE_SIZE}`.
- **Item Mapping & Schema Handling:**
  - Trakt payloads wrap items in `{ movie: { ... } }` or `{ show: { ... } }` or `{ episode: { ... } }`.
  - `mapTraktItems` inspects `it.movie || it.show || it`.
  - Type assignment: `type: it.movie ? "movie" : (it.show ? "series" : type)`.
  - ID extraction priority: `obj.ids.imdb` -> `tmdb:${obj.ids.tmdb}` -> skipped if neither exists.
- **Token Expiry & Reauth Protocol:**
  - Trakt access tokens expire in ~3 months.
  - Proactive background job `token.refresh` (`50_token-refresh.js`) queries connections expiring within 7 days (`TOKEN_REFRESH_WINDOW_MS = 7 * 86400000`) and calls `/oauth/token` to renew them.
  - If refresh is rejected (`fresh.rejected`), marks connection status `reauth_required` in D1 and prompts the user to reconnect.
- **Error & Rate Limiting:**
  - HTTP 429 throws: `"Trakt is temporarily busy (rate limit). Please wait a few seconds and try again."`
  - HTTP 401/403 throws: `"Your Trakt connection may have expired -- try reconnecting in Settings."`

### 2.3 MDBList

- **Source File:** `06_source-fetchers-mdblist-trakt.js`
- **Request Construction:**
  - Base: `https://api.mdblist.com/`
  - Auth: `?apikey=${encodeURIComponent(mdblistKey)}` or `Authorization: Bearer <accessToken>`.
- **List vs Slice Strategy:**
  - User lists are fetched in full from MDBList and sliced locally (`metas.slice(skip, skip + PAGE_SIZE)`), as MDBList's API does not support native pagination on custom lists.
  - Results are cached in KV (`mdblist:list:${slug}`) with 1-hour TTL.
- **Error Handling:**
  - HTTP 401/403 throws explicit error directing user to check MDBList API key.
  - Network failures throw and trigger the circuit breaker.

### 2.4 Streaming Availability (RapidAPI) & JustWatch

- **Source File:** `03_admin.js`, `26_api-creator-and-admin-routes.js`, `53_more-jobs.js`
- **Engine Selection:**
  - Default: `justwatch` (requires no API keys, reads public streaming release feeds).
  - Configurable: `rapidapi` via `NEW_ON_STREAMING_ENGINE = "rapidapi"` in `wrangler.toml` [vars].
- **Atomic Monthly Quota Ledger (`rapidApiLedgerD1`):**
  - Stored in D1 `jobs` table under dedupe key `ledger:rapidapi`.
  - Atomic SQL statement updates monthly request tally:
    ```sql
    UPDATE jobs SET progress_json = json_object(
      'month', ?,
      'count', (CASE WHEN json_extract(progress_json, '$.month') = ? THEN count ELSE 0 END) + ?,
      'lastAt', ?), updated_at = ?
    WHERE dedupe_key = 'ledger:rapidapi'
    ```
  - Automatically resets counter to `add` upon month boundary rollover (`YYYY-MM`).

---

## 3. Circuit Breaker Architecture (`41_provider-breaker.js`)

To protect upstream providers from cascading retry storms and prevent slow user request timeouts:

```
[Request to Provider]
        |
        v
+-----------------------+
| Is Breaker Open?      |---- YES ----> Return ProviderUnavailable (Fail fast, 0ms)
+-----------------------+                    |
        | NO                                 v
        v                              Serve stale KV cache
+-----------------------+
| Execute fetch()       |
+-----------------------+
        |
        +---- Success (2xx, 3xx) -------> Reset failures = 0
        |
        +---- Domain error (401, 404) --> Reset failures = 0 (Not provider outage)
        |
        +---- Failure (5xx, 429, timeout)
                     |
                     v
              failures++
                     |
              failures >= 5?
                     |
                    YES
                     v
              Trip breaker: openUntil = now + 60s
              Publish to KV `pb:{provider}`
```

- **Failure Status Definition:** Status `null` (timeout/network error), `status >= 500`, or `status === 429`.
- **Domain Status Definition:** Status `401`, `403`, or `404` are considered valid responses about specific credentials or missing IDs, resetting the consecutive failure counter.
- **Cross-Isolate Propagation:** Tripped breakers write `pb:{provider}` to KV with a 60-second TTL. Other isolates poll this key at most once a minute, synchronizing breaker state across Cloudflare's global edge network.

---

## 4. Anti-Corruption: Provider Failure vs. Valid Empty Data

A critical failure mode in aggregation platforms is treating a provider error or transient empty response as valid empty data and caching/persisting it, wiping out valid catalogs.

The codebase strictly enforces multi-layer defense against this:

1. **Provider Fetchers Throw on Non-200:**
   `fetchTmdbPagedResults` and Trakt fetchers throw an Error upon HTTP failure statuses instead of returning `[]`.
2. **Snapshot Empty Guard (`42_chart-snapshots.js:132-137`):**
   ```javascript
   const items = Array.isArray(fresh) ? fresh : [];
   if (!items.length) {
     if (previous && previous.items.length) {
       console.warn(`[ChartSnapshot] ${key} came back empty; keeping the last copy.`);
     }
     return { snap: previous || null, raw: fresh };
   }
   ```
   Even if an upstream provider returns HTTP 200 with an empty collection `[]`, the snapshot engine detects `!items.length`, preserves the existing good snapshot, logs a warning, and refuses to write the empty collection to KV.
3. **Stale-While-Revalidate Resilience:**
   Snapshots in KV are stored with a 7-day TTL (`CHART_SNAPSHOT_KV_TTL_SEC = 7 * 86400`). If an upstream provider suffers a multi-hour outage, the add-on serves stale cached copies seamlessly rather than empty shelves.

---

## 5. Verification & Test Evidence

All provider contracts, mapping logic, and failure handling mechanisms are validated via automated suites:
- `tests/providers.test.mjs` (Breaker trip after 5 failures, 60s cooldown, 4xx non-tripping, timeout counting).
- `tests/provider-contracts.test.mjs` (Provider request URLs, headers, and error shapes).
- `tests/chart-refresh.test.mjs` (Snapshot preservation and background refresh).
- `tests/my-lists-addon-charts.test.mjs` (Chart catalog generation and pagination).
- `audit/full-2026-10-02/probes/p06_external_providers.mjs` (Automated end-to-end simulation probe: 4/4 suites passing).
