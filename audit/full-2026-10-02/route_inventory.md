# Route Inventory — My Lists Addon

This document establishes the exhaustive HTTP route inventory for `worker_entry_combined.js` (commit `86b08f80e43ec100b2577516d3a027246ce088d0`), categorizing all endpoints by authentication, authorization, caching, CORS, rate limiting, mutation semantics, inputs, and outputs.

---

## Summary Matrix

- **Total Distinct Route Patterns:** ~85 routes
- **Stremio Protocol Endpoints:** 6 routes (`manifest.json`, `catalog`, `meta`, `subtitles`, `configure`)
- **Public Assets & UI Pages:** 11 routes (`/`, `/configure`, `/app.js`, `/app-features.js`, `/app.css`, `/sw.js`, etc.)
- **Catalog, Discovery & Metadata APIs:** 22 routes
- **Creator Account & Session APIs:** 18 routes
- **v2 Modern APIs (Installs, Connections, Lists v2, Likes v2, Channels v2):** 20 routes
- **Admin Dashboard & Admin APIs:** 28 routes
- **Webhooks & Telemetry:** 6 routes (`/api/scrobble*`, `/api/track-*`, `/api/csp-report`)

---

## 1. Stremio Addon Protocol Endpoints

| Method | Path | Auth Requirement | Authorization / Ownership | Rate Limit | Cache Behavior | CORS | Input | Output | Errors | Mutates | Destructive |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `GET` | `/manifest.json` | None | Public | None | `public, max-age=3600` | `*` | None | JSON (Manifest v3) | — | No | No |
| `GET` | `/{id}/manifest.json` | None (token in path) | Public (tokenized) | None | `no-store` if live rows present, else default | `*` | URL param `:id` | JSON (Manifest v3) | 302 (browser) | No (may trigger async token migration) | No |
| `GET` | `/{id}/catalog/{type}/{catalogId}.json` | None (token in path) | Public (tokenized) | Provider Breaker | `no-store` for personal/live rows; `public, max-age=3600` for public charts | `*` | URL params `:id`, `:type`, `:catalogId` | JSON `{ metas: [] }` | 200 (empty metas on error) | No | No |
| `GET` | `/{id}/catalog/{type}/{catalogId}/skip={skip}.json` | None (token in path) | Public (tokenized) | Provider Breaker | Same as catalog | `*` | `skip` offset parameter | JSON `{ metas: [] }` | 200 (empty metas) | No | No |
| `GET` | `/{id}/meta/{type}/{titleId}.json` | None (optional token) | Public | Provider Breaker | `public, max-age=86400, stale-while-revalidate=604800` | `*` | `:titleId` (`tt*`, `tmdb:*`, `channel_*`) | JSON `{ meta: {...} }` | 200 (`meta: null` on error) | No | No |
| `GET` | `/{id}/subtitles/{type}/{titleId}.json` | None | Public | None | Default public | `*` | `:titleId` (IMDb / episode) | JSON `{ subtitles: [] }` | 200 (empty list) | Yes (async playback track via `ctx.waitUntil`) | No |

---

## 2. Public Web UI & Static Assets

| Method | Path | Auth Requirement | Authorization | Rate Limit | Cache Behavior | CORS | Input | Output | Errors | Mutates | Destructive |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `GET` | `/` | None | Public | None | `no-cache` (ETag validated, 304 supported) | Same-Origin | None | HTML (Builder Shell) | 500 | No | No |
| `GET` | `/configure` | None | Public | None | `no-cache` (ETag validated) | Same-Origin | None | HTML (Builder Shell) | 500 | No | No |
| `GET` | `/{id}/configure` | None | Public | None | `no-cache` | Same-Origin | `:id` (install token) | HTML (Pre-populated) | 500 | No | No |
| `GET` | `/guide` | None | Public | None | `public, max-age=86400` | Same-Origin | None | HTML (User Guide) | — | No | No |
| `GET` | `/app.js` | None | Public | None | `public, max-age=31536000, immutable` if `?v=hash`, else `no-cache` | Same-Origin | Query `v` | JS (`application/javascript`) | 503 | No | No |
| `GET` | `/app-features.js` | None | Public | None | `public, max-age=31536000, immutable` if `?v=hash`, else `no-cache` | Same-Origin | Query `v` | JS (`application/javascript`) | 503 | No | No |
| `GET` | `/app.css` | None | Public | None | `public, max-age=31536000, immutable` if `?v=hash`, else `no-cache` | Same-Origin | Query `v` | CSS (`text/css`) | 503 | No | No |
| `GET` | `/sw.js` | None | Public | None | `no-cache` | Same-Origin | None | JS (Service Worker) | — | No | No |
| `GET` | `/vendor/fflate-0.8.2.js` | None | Public | None | `public, max-age=31536000, immutable` | Same-Origin | None | JS (Vendored fflate) | — | No | No |
| `GET` | `/app.webmanifest` | None | Public | None | `public, max-age=86400` | Same-Origin | None | JSON (`application/manifest+json`) | — | No | No |
| `GET` | `/robots.txt` | None | Public | None | `public, max-age=86400` | Same-Origin | None | Text | — | No | No |
| `GET` | `/sitemap.xml` | None | Public | None | `public, max-age=86400` | Same-Origin | None | XML | — | No | No |
| `GET` | `/icon.png` | None | Public | None | `public, max-age=604800` | Same-Origin | None | PNG binary | — | No | No |
| `GET` | `/reconnect-poster.svg` | None | Public | None | `public, max-age=86400` | `*` | Query `provider` | SVG image | — | No | No |
| `GET` | `/unavailable-poster.svg`| None | Public | None | `public, max-age=86400` | `*` | None | SVG image | — | No | No |

---

## 3. Public Catalog Discovery, Preview & Resolution APIs

| Method | Path | Auth Requirement | Authorization | Rate Limit | Cache Behavior | CORS | Input | Output | Errors | Mutates | Destructive |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `GET` | `/api/public-lists.json` | None | Public | None | `public, max-age=120, stale-while-revalidate=60` | `*` | None | JSON (List Directory) | 500 | No | No |
| `GET` | `/lists/public.json` | None | Public | None | `public, max-age=120, stale-while-revalidate=60` | `*` | None | JSON (List Directory) | 500 | No | No |
| `GET` | `/api/search-published-lists` | None | Public | None | `public, max-age=120` | `*` | Query `q` | JSON (Matching lists) | 500 | No | No |
| `POST` | `/api/preview` | None | Public | Breaker | `no-store` | `*` | Body `{ url, type }` | JSON `{ items: [] }` | 400, 500 | No | No |
| `GET` | `/api/details` | None | Public | Breaker | `public, max-age=86400` | `*` | Query `id` (IMDb ID) | JSON (Title metadata) | 400, 404, 500 | No | No |
| `POST` | `/api/details/batch` | None | Public | Spend-First (Cost = titles) | `public, max-age=86400` | `*` | Body `{ ids: [] }` | JSON `{ [id]: meta }` | 400, 429, 500 | No | No |
| `POST` | `/api/resolve` | None | Public | Breaker | `public, max-age=3600` | `*` | Body `{ config }` | JSON (Resolved config) | 400, 500 | No | No |
| `POST` | `/api/resolve-movie` | None | Public | Breaker | `public, max-age=86400` | `*` | Body `{ title, year }` | JSON `{ id }` | 400, 404, 500 | No | No |
| `POST` | `/api/resolve-show` | None | Public | Breaker | `public, max-age=86400` | `*` | Body `{ title, year }` | JSON `{ id }` | 400, 404, 500 | No | No |
| `POST` | `/api/bulk-resolve` | None | Public | Spend-First (Cost = items) | `no-store` | `*` | Body `{ items: [] }` | JSON `{ resolved: [] }` | 400, 429, 500 | No | No |
| `POST` | `/api/save` | None (Optional Account) | Public or Account | None | `no-store` | `*` | Body `{ entries: [] }` | JSON `{ id, url }` | 400, 401 (if personal rows signed-out), 500 | Yes (KV / D1 `installs`) | No |
| `GET` | `/api/title-search` | None | Public | Breaker | `public, max-age=1800` | `*` | Query `q`, `type` | JSON `{ results: [] }` | 400, 500 | No | No |
| `GET` | `/api/toplists` | None | Public | Breaker | `public, max-age=7200` | `*` | Query params | JSON `{ lists: [] }` | 500 | No | No |
| `POST` | `/api/recommendations` | None (Account proof) | Account | Breaker | `private, no-store` | Same-Origin | Body `{ creatorName, creatorKey }` | JSON `{ items: [] }` | 401, 500 | No | No |
| `GET` | `/api/channel-lineup` | None | Public | Breaker | `public, max-age=3600` | `*` | Query `code` | JSON `{ episodes: [] }` | 400, 404 | No | No |
| `GET` | `/api/channel-preset` | None | Public | None | `public, max-age=86400` | `*` | Query `id` | JSON (Channel config) | 400, 404 | No | No |
| `GET` | `/api/channel-logo` | None | Public | None | `public, max-age=604800` | `*` | Query `path` | SVG image | 400 | No | No |
| `GET` | `/api/channel-poster` | None | Public | None | `public, max-age=604800` | `*` | Query params | SVG / PNG image | 400 | No | No |

---

## 4. Provider OAuth & External Service Proxies

| Method | Path | Auth Requirement | Authorization | Rate Limit | Cache Behavior | CORS | Input | Output | Errors | Mutates | Destructive |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `GET` | `/api/trakt/oauth/start` | None | Public | None | `no-store` | Same-Origin | Query `redirect` | 302 Redirect to Trakt | 500 | No | No |
| `GET` | `/api/trakt/oauth/callback` | None | Public | None | `no-store` | Same-Origin | Query `code` | HTML / redirect | 400, 500 | Yes (session token) | No |
| `POST` | `/api/trakt/device/code` | None | Public | None | `no-store` | Same-Origin | None | JSON `{ device_code, user_code }` | 500 | No | No |
| `POST` | `/api/trakt/device/token` | None | Public | None | `no-store` | Same-Origin | Body `{ code }` | JSON `{ access_token }` | 400, 500 | Yes | No |
| `GET` | `/api/simkl/oauth/start` | None | Public | None | `no-store` | Same-Origin | Query `redirect` | 302 Redirect to Simkl | 500 | No | No |
| `GET` | `/api/simkl/oauth/callback` | None | Public | None | `no-store` | Same-Origin | Query `code` | HTML / redirect | 400, 500 | Yes | No |
| `GET` | `/api/mdblist/oauth/start` | None | Public | None | `no-store` | Same-Origin | Query `redirect` | 302 Redirect to MDBList | 500 | No | No |
| `GET` | `/api/mdblist/oauth/callback` | None | Public | None | `no-store` | Same-Origin | Query `code` | HTML / redirect | 400, 500 | Yes | No |
| `GET` | `/api/tmdb/oauth/start` | None | Public | None | `no-store` | Same-Origin | None | 302 Redirect to TMDB | 500 | No | No |
| `GET` | `/api/tmdb/oauth/callback` | None | Public | None | `no-store` | Same-Origin | Query `request_token` | HTML / redirect | 400, 500 | Yes | No |
| `POST` | `/api/external-list/create` | Token | Valid Token | Breaker | `no-store` | Same-Origin | Body `{ provider, token, name }` | JSON `{ listId }` | 400, 401, 500 | Yes (upstream) | No |
| `POST` | `/api/external-list/delete` | Token | Valid Token | Breaker | `no-store` | Same-Origin | Body `{ provider, token, listId }` | JSON `{ ok: true }` | 400, 401, 500 | Yes (upstream) | Yes |

---

## 5. Creator Account & Session Management APIs

| Method | Path | Auth Requirement | Authorization | Rate Limit | Cache Behavior | CORS | Input | Output | Errors | Mutates | Destructive |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `POST` | `/api/session` | Account Key / Password | Account Owner | Read-First | `private, no-store` | Same-Origin | Body `{ username, key }` | JSON `{ ok: true, username }` + `Set-Cookie: mla_session` | 400, 401 | Yes (issues session) | No |
| `DELETE` | `/api/session` | Session | Account Owner | None | `private, no-store` | Same-Origin | Cookie / Header | JSON `{ ok: true }` | 401 | Yes (revokes session) | Yes (session) |
| `GET` | `/api/me` | Session / Account Key | Account Owner | None | `private, no-store` | Same-Origin | Cookie / Body | JSON `{ ok: true, account: {...} }` | 401 | No | No |
| `GET` | `/api/me/sessions` | Session | Account Owner | None | `private, no-store` | Same-Origin | Cookie | JSON `{ ok: true, sessions: [] }` | 401 | No | No |
| `DELETE` | `/api/me/sessions/:id` | Session | Account Owner | None | `private, no-store` | Same-Origin | Cookie, URL param `:id` | JSON `{ ok: true }` | 401, 404 | Yes | Yes (session) |
| `POST` | `/api/creator/create` | None | New Account | None | `private, no-store` | Same-Origin | Body `{ username, displayName }` | JSON `{ ok: true, creatorKey, username }` | 400, 409 (taken) | Yes (creates creator row) | No |
| `POST` | `/api/creator/restore` | Account Key / Recovery | Account Owner | Read-First | `private, no-store` | Same-Origin | Body `{ username, key, answer }` | JSON `{ ok: true, profile: {...} }` | 400, 401, 429 | No | No |
| `POST` | `/api/creator/reset-key` | Recovery Answer | Account Owner | Read-First | `private, no-store` | Same-Origin | Body `{ username, answer }` | JSON `{ ok: true, newKey }` | 400, 401, 429 | Yes (updates `key_hash`) | Yes (invalidates old key) |
| `POST` | `/api/creator/recovery-answer` | Account Key | Account Owner | None | `private, no-store` | Same-Origin | Body `{ creatorName, creatorKey, answer }` | JSON `{ ok: true }` | 400, 401 | Yes (updates `recovery_answer_hash`) | No |
| `POST` | `/api/creator/forgot-username` | Account Key + Answer | Account Owner | Read-First | `private, no-store` | Same-Origin | Body `{ key, answer }` | JSON `{ ok: true, username }` | 400, 401, 429 | No | No |
| `POST` | `/api/creator/delete-account` | Account Key / Session | Account Owner | None | `private, no-store` | Same-Origin | Body `{ creatorName, creatorKey }` | JSON `{ ok: true }` | 400, 401 | Yes (deletes user, lists, sessions) | **Yes (Full purge)** |
| `POST` | `/api/creator/account/reset` | Account Key / Session | Account Owner | None | `private, no-store` | Same-Origin | Body `{ creatorName, creatorKey }` | JSON `{ ok: true }` | 400, 401 | Yes (resets state/lists) | **Yes** |
| `POST` | `/api/creator/track-status` | Account Key / Session | Account Owner | None | `private, no-store` | Same-Origin | Body `{ creatorName, creatorKey }` | JSON `{ ok: true, tracking: {...} }` | 401 | No | No |
| `POST` | `/api/creator/scrobble-token` | Account Key / Session | Account Owner | None | `private, no-store` | Same-Origin | Body `{ creatorName, creatorKey }` | JSON `{ ok: true, token }` | 401 | Yes (generates scrobble token) | No |

---

## 6. Creator Lists & Sync APIs

| Method | Path | Auth Requirement | Authorization | Rate Limit | Cache Behavior | CORS | Input | Output | Errors | Mutates | Destructive |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `POST` | `/api/creator/sync/save` | Account Key / Session | Account Owner | None | `private, no-store` | Same-Origin | Body `{ config, keys, expectedUpdatedAt }` | JSON `{ ok: true, updatedAt }` | 400, 401, 409 (conflict) | Yes (KV `creatorsync:*`) | No |
| `POST` | `/api/creator/sync/load` | Account Key / Session | Account Owner | None | `private, no-store` | Same-Origin | Body `{ creatorName, creatorKey }` | JSON `{ ok: true, data: {...} }` | 401 | No | No |
| `POST` | `/api/creator/sync/meta` | Account Key / Session | Account Owner | None | `private, no-store` | Same-Origin | Body `{ creatorName, creatorKey }` | JSON `{ ok: true, updatedAt }` | 401 | No | No |
| `POST` | `/api/creator/sync/save-tracking` | Account Key / Session | Account Owner | None | `private, no-store` | Same-Origin | Body `{ creatorName, creatorKey, tracking }` | JSON `{ ok: true }` | 401 | Yes (KV / D1 tracking) | No |
| `POST` | `/api/creator/sync/share-tracking` | Account Key / Session | Account Owner | None | `private, no-store` | Same-Origin | Body `{ creatorName, creatorKey, shares }` | JSON `{ ok: true }` | 401 | Yes (`creatorshare:*`) | No |
| `POST` | `/api/creator/sync/save-presets` | Account Key / Session | Account Owner | None | `private, no-store` | Same-Origin | Body `{ creatorName, creatorKey, presets }` | JSON `{ ok: true }` | 401 | Yes (`creatorsyncpresets:*`) | No |
| `POST` | `/api/creator/sync/save-channels` | Account Key / Session | Account Owner | None | `private, no-store` | Same-Origin | Body `{ creatorName, creatorKey, channels }` | JSON `{ ok: true }` | 401 | Yes (`creatorsyncchannels:*`) | No |
| `POST` | `/api/creator/lists` | Account Key / Session | Account Owner | None | `private, no-store` | Same-Origin | Body `{ creatorName, creatorKey }` | JSON `{ ok: true, lists: [] }` | 401 | No | No |
| `POST` | `/api/creator/lists/save` | Account Key / Session | Account Owner | None | `private, no-store` | Same-Origin | Body `{ creatorName, creatorKey, name, items, visibility }` | JSON `{ ok: true, slug }` | 400, 401 | Yes (`creator_lists` table) | No |
| `POST` | `/api/creator/lists/items` | Account Key / Session | Account Owner | None | `private, no-store` | Same-Origin | Body `{ creatorName, creatorKey, slug }` | JSON `{ ok: true, items: [] }` | 401, 404 | No | No |
| `POST` | `/api/creator/lists/reorder` | Account Key / Session | Account Owner | None | `private, no-store` | Same-Origin | Body `{ creatorName, creatorKey, order: [] }` | JSON `{ ok: true }` | 401 | Yes (`sort_order`) | No |
| `POST` | `/api/creator/lists/delete` | Account Key / Session | Account Owner | None | `private, no-store` | Same-Origin | Body `{ creatorName, creatorKey, slug }` | JSON `{ ok: true }` | 401 | Yes (deletes list) | **Yes** |

---

## 7. Modern v2 Subsystem APIs (Installs, Connections, Lists v2, Likes v2, Channels v2)

| Method | Path | Auth Requirement | Authorization | Rate Limit | Cache Behavior | CORS | Input | Output | Errors | Mutates | Destructive |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `GET` | `/api/installs` | Session (`FF_INSTALLS`) | Account Owner | None | `private, no-store` | Same-Origin | Session cookie | JSON `{ ok: true, installs: [] }` | 401 | No | No |
| `POST` | `/api/installs` | Session (`FF_INSTALLS`) | Account Owner | None | `private, no-store` | Same-Origin | Body `{ name, entries, ... }` | JSON `{ ok: true, token, install: {...} }` | 400, 401 | Yes (`installs` table) | No |
| `GET` | `/api/installs/:token` | Session (`FF_INSTALLS`) | Account Owner | None | `private, no-store` | Same-Origin | URL param `:token` | JSON `{ ok: true, install: {...} }` | 401, 404 | No | No |
| `PATCH` | `/api/installs/:token` | Session (`FF_INSTALLS`) | Account Owner | None | `private, no-store` | Same-Origin | Body `{ name, entries, ... }` | JSON `{ ok: true, install: {...} }` | 400, 401, 404 | Yes | No |
| `DELETE` | `/api/installs/:token` | Session (`FF_INSTALLS`) | Account Owner | None | `private, no-store` | Same-Origin | URL param `:token` | JSON `{ ok: true }` | 401, 404 | Yes | **Yes (Revokes install)** |
| `POST` | `/api/installs/:token/rotate` | Session (`FF_INSTALLS`) | Account Owner | None | `private, no-store` | Same-Origin | URL param `:token` | JSON `{ ok: true, newToken }` | 401, 404 | Yes (rotates token) | Yes (invalidates old token) |
| `GET` | `/api/connections` | Session | Account Owner | None | `private, no-store` | Same-Origin | Session cookie | JSON `{ ok: true, connections: [] }` | 401 | No | No |
| `POST` | `/api/connections/import-local` | Session | Account Owner | None | `private, no-store` | Same-Origin | Body `{ tokens: {...} }` | JSON `{ ok: true, imported: [] }` | 400, 401 | Yes (encrypts secrets to D1) | No |
| `DELETE` | `/api/connections/:provider` | Session | Account Owner | None | `private, no-store` | Same-Origin | URL param `:provider` | JSON `{ ok: true }` | 401, 404 | Yes (deletes row + revokes) | **Yes** |
| `POST` | `/api/connections/:provider/token` | Session | Account Owner | None | `private, no-store` | Same-Origin | URL param `:provider` | JSON `{ ok: true, accessToken }` | 401, 404 | Yes (refreshes if needed) | No |
| `GET` | `/api/lists` | Session (`FF_V2_LISTS_API`) | Account Owner | None | `private, no-store` | Same-Origin | Session cookie | JSON `{ ok: true, lists: [] }` | 401 | No | No |
| `POST` | `/api/lists` | Session (`FF_V2_LISTS_API`) | Account Owner | None | `private, no-store` | Same-Origin | Body `{ title, type, visibility }` | JSON `{ ok: true, list: {...} }` | 400, 401, 409 | Yes (D1 `lists`) | No |
| `GET` | `/api/lists/:id` | None (Optional Session) | Public / Owner | None | `no-store` if private, else `public, max-age=120` | `*` | URL param `:id`, query `cursor`, `limit` | JSON `{ ok: true, list, items, nextCursor }` | 404 | No | No |
| `PATCH` | `/api/lists/:id` | Session (`FF_V2_LISTS_API`) | List Owner | None | `private, no-store` | Same-Origin | Body `{ title, visibility, ... }` | JSON `{ ok: true, list: {...} }` | 401, 404, 409 | Yes | No |
| `DELETE` | `/api/lists/:id` | Session (`FF_V2_LISTS_API`) | List Owner | None | `private, no-store` | Same-Origin | URL param `:id` | JSON `{ ok: true }` | 401, 404 | Yes (`deleted_at = now`) | **Yes (Soft delete)** |
| `POST` | `/api/lists/:id/items` | Session (`FF_V2_LISTS_API`) | List Owner | None | `private, no-store` | Same-Origin | Body `{ items: [] }` | JSON `{ ok: true, added: N }` | 400, 401, 404 | Yes (D1 `list_items`) | No |
| `GET` | `/api/likes/:type/:id` | None | Public | None | `public, max-age=60` | `*` | URL params `:type`, `:id` | JSON `{ ok: true, likes, liked }` | 400, 404 | No | No |
| `PUT` | `/api/likes/:type/:id` | Session / Account | Account Owner | None | `private, no-store` | Same-Origin | URL params `:type`, `:id` | JSON `{ ok: true, liked: true, likes: N }` | 401, 404 | Yes (D1 `likes`) | No |
| `DELETE` | `/api/likes/:type/:id` | Session / Account | Account Owner | None | `private, no-store` | Same-Origin | URL params `:type`, `:id` | JSON `{ ok: true, liked: false, likes: N }` | 401, 404 | Yes (D1 `likes`) | Yes (removes vote) |
| `GET` | `/api/channels` | Session | Account Owner | None | `private, no-store` | Same-Origin | Session cookie | JSON `{ ok: true, channels: [] }` | 401 | No | No |
| `POST` | `/api/channels` | Session | Account Owner | None | `private, no-store` | Same-Origin | Body channel definition | JSON `{ ok: true, channelId }` | 400, 401 | Yes (D1 `channels`, R2 `BLOBS`) | No |
| `DELETE` | `/api/channels/:id` | Session | Channel Owner | None | `private, no-store` | Same-Origin | URL param `:id` | JSON `{ ok: true }` | 401, 404 | Yes | **Yes** |

---

## 8. Scrobble Webhooks, Activity & Telemetry

| Method | Path | Auth Requirement | Authorization | Rate Limit | Cache Behavior | CORS | Input | Output | Errors | Mutates | Destructive |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `POST` | `/api/scrobble` | Scrobble Token (`?st=`) / Key | Account Owner | Rate Counter | `no-store` | `*` | Webhook JSON / form body | JSON `{ ok: true }` | 400, 401, 429 | Yes (D1 `DB_ACTIVITY`) | No |
| `POST` | `/api/scrobble/plex` | Scrobble Token | Account Owner | Rate Counter | `no-store` | `*` | Plex multipart payload | JSON `{ ok: true }` | 400, 401, 429 | Yes (D1 `DB_ACTIVITY`) | No |
| `POST` | `/api/scrobble/jellyfin` | Scrobble Token | Account Owner | Rate Counter | `no-store` | `*` | Jellyfin webhook JSON | JSON `{ ok: true }` | 400, 401, 429 | Yes (D1 `DB_ACTIVITY`) | No |
| `POST` | `/api/track-event` | None | Public | Spend-First | `no-store` | `*` | Body `{ event, meta }` | JSON `{ ok: true }` | 400, 429 | Yes (Analytics Engine) | No |
| `POST` | `/api/track-install` | None | Public | Spend-First | `no-store` | `*` | Body `{ sourceGroupId }` | JSON `{ ok: true }` | 400, 429 | Yes (D1 `stats`) | No |
| `POST` | `/api/feedback` | None | Public | Read-First | `no-store` | Same-Origin | Body `{ message, contact }` | JSON `{ ok: true, threadId }` | 400, 429 | Yes (D1 `feedback`) | No |
| `POST` | `/api/csp-report` | None | Public | Spend-First | `no-store` | `*` | CSP Violation JSON | 204 No Content | 429 | Yes (telemetry log) | No |

---

## 9. Admin Dashboard & Administrative APIs

*All routes under `/admin/api/*` require admin authorization via Cloudflare Access JWT or verified `ADMIN_KEY` session cookie.*

| Method | Path | Auth Requirement | Authorization | Rate Limit | Cache Behavior | CORS | Input | Output | Errors | Mutates | Destructive |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `GET` | `/admin` | None (Shows login form if unauthenticated) | Public / Admin | None | `no-store` | Same-Origin | Cookie / Access JWT | HTML (Admin Dashboard or Login) | 500 | No | No |
| `POST` | `/admin/login` | `ADMIN_KEY` | Admin | Read-First (Brute force protection) | `no-store` | Same-Origin | Form / JSON `{ key }` | JSON `{ ok: true }` + `Set-Cookie: mla_admin` | 401, 429 | Yes (creates admin session) | No |
| `POST` | `/admin/logout` | Admin Session | Admin | None | `no-store` | Same-Origin | Cookie | JSON `{ ok: true }` | — | Yes (revokes session) | Yes (session) |
| `GET` | `/admin/api/audit` | Admin Session | Admin Only | None | `private, no-store` | Same-Origin | Query `limit`, `cursor` | JSON `{ ok: true, log: [] }` | 401 | No | No |
| `GET` | `/admin/api/analytics` | Admin Session | Admin Only | None | `private, no-store` | Same-Origin | Query `days` | JSON (Analytics rollup) | 401, 500 | No | No |
| `GET` | `/admin/api/apiusage` | Admin Session | Admin Only | None | `private, no-store` | Same-Origin | Query params | JSON (Provider API stats) | 401 | No | No |
| `GET` | `/admin/api/leaderboard` | Admin Session | Admin Only | None | `private, no-store` | Same-Origin | None | JSON (Top lists) | 401 | No | No |
| `GET` | `/admin/api/admin-sessions` | Admin Session | Admin Only | None | `private, no-store` | Same-Origin | None | JSON `{ ok: true, sessions: [] }` | 401 | No | No |
| `POST` | `/admin/api/revoke-admin-session` | Admin Session | Admin Only | None | `private, no-store` | Same-Origin | Body `{ sessionId }` | JSON `{ ok: true }` | 401, 404 | Yes | **Yes (Revokes session)** |
| `POST` | `/admin/api/reset-creator-key` | Admin Session | Admin Only | None | `private, no-store` | Same-Origin | Body `{ username }` | JSON `{ ok: true, newKey }` | 401, 404 | Yes | **Yes (Forces key reset)** |
| `GET` | `/admin/api/published-lists` | Admin Session | Admin Only | None | `private, no-store` | Same-Origin | Query params | JSON `{ lists: [] }` | 401 | No | No |
| `POST` | `/admin/api/delete-published-list`| Admin Session | Admin Only | None | `private, no-store` | Same-Origin | Body `{ slug }` | JSON `{ ok: true }` | 401, 404 | Yes | **Yes (Deletes list)** |
| `GET` | `/admin/api/creator-lists` | Admin Session | Admin Only | None | `private, no-store` | Same-Origin | Query `username` | JSON `{ lists: [] }` | 401 | No | No |
| `POST` | `/admin/api/delete-creator-list` | Admin Session | Admin Only | None | `private, no-store` | Same-Origin | Body `{ username, slug }` | JSON `{ ok: true }` | 401 | Yes | **Yes (Deletes creator list)** |
| `POST` | `/admin/api/channel-moderate` | Admin Session | Admin Only | None | `private, no-store` | Same-Origin | Body `{ code, action }` | JSON `{ ok: true }` | 401 | Yes | **Yes** |
| `GET` | `/admin/api/schema-status` | Admin Session | Admin Only | None | `private, no-store` | Same-Origin | None | JSON (Schema migrations status) | 401 | No | No |
| `POST` | `/admin/api/migrate-d1` | Admin Session | Admin Only | None | `private, no-store` | Same-Origin | Body params | JSON `{ ok: true, done, results }` | 401, 500 | Yes (KV -> D1 backfill) | No |
| `GET` | `/admin/api/migrate-accounts` | Admin Session | Admin Only | None | `private, no-store` | Same-Origin | Query `dry_run` | JSON (Reconciliation report) | 401, 500 | No (Dry run on GET) | No |
| `POST` | `/admin/api/migrate-accounts` | Admin Session | Admin Only | None | `private, no-store` | Same-Origin | Body `{ dryRun }` | JSON (Backfill accounts execution) | 401, 500 | Yes | No |
| `POST` | `/admin/api/migrate-day-counts` | Admin Session | Admin Only | None | `private, no-store` | Same-Origin | None | JSON `{ ok: true, migrated }` | 401 | Yes | No |
| `POST` | `/admin/api/export-kv-to-r2` | Admin Session | Admin Only | None | `private, no-store` | Same-Origin | None | JSON `{ ok: true, exported }` | 401 | Yes (R2 snapshot) | No |
| `POST` | `/admin/api/rebuild-public-index`| Admin Session | Admin Only | None | `private, no-store` | Same-Origin | None | JSON `{ ok: true }` | 401 | Yes (re-indexes directory) | No |
| `GET` | `/admin/api/feedback` | Admin Session | Admin Only | None | `private, no-store` | Same-Origin | Query `status` | JSON `{ threads: [] }` | 401 | No | No |
| `POST` | `/admin/api/feedback/status` | Admin Session | Admin Only | None | `private, no-store` | Same-Origin | Body `{ id, status }` | JSON `{ ok: true }` | 401 | Yes | No |
| `POST` | `/admin/api/feedback/reply` | Admin Session | Admin Only | None | `private, no-store` | Same-Origin | Body `{ id, reply }` | JSON `{ ok: true }` | 401 | Yes | No |
| `POST` | `/admin/api/feedback/delete` | Admin Session | Admin Only | None | `private, no-store` | Same-Origin | Body `{ id }` | JSON `{ ok: true }` | 401 | Yes | **Yes** |
| `GET` | `/admin/api/installs/status` | Admin Session | Admin Only | None | `private, no-store` | Same-Origin | None | JSON (Install migration progress) | 401 | No | No |
| `POST` | `/admin/api/installs/restore` | Admin Session | Admin Only | None | `private, no-store` | Same-Origin | None | JSON `{ ok: true, restored }` | 401 | Yes (undo install move) | No |
| `GET` | `/admin/api/jobs/status` | Admin Session | Admin Only | None | `private, no-store` | Same-Origin | None | JSON (Queue / cursor states) | 401 | No | No |
| `POST` | `/admin/api/jobs/ping` | Admin Session | Admin Only | None | `private, no-store` | Same-Origin | Body `{ job }` | JSON `{ ok: true, enqueued }` | 401 | Yes (enqueues job) | No |

---

## 10. Background Queue & Import Jobs APIs

| Method | Path | Auth Requirement | Authorization | Rate Limit | Cache Behavior | CORS | Input | Output | Errors | Mutates | Destructive |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `POST` | `/api/imports` | Session / Account | Account Owner | Spend-First | `private, no-store` | Same-Origin | Body `{ url, targetListId }` | JSON `{ ok: true, importId }` | 400, 401, 429 | Yes (enqueues import) | No |
| `GET` | `/api/imports/:id` | Session / Account | Account Owner | None | `private, no-store` | Same-Origin | URL param `:id` | JSON `{ ok: true, status, progress }` | 401, 404 | No | No |
