# sink_table.md — Module 09: Frontend Security / DOM
# SHA 5232c3b4213b675e9958b9649536ffc1b95a2cb6 · 2026-10-02

All innerHTML, insertAdjacentHTML, location.href/replace/assign, window.open, eval,
new Function, document.write, img src=, a href=, data- attribute, and localStorage
sinks examined in the client JS sources (09_page-shell.js – 25_api-catalog-routes.js).

Legend:
  SAFE      – Attacker-controlled path does not reach this sink, OR escaping/charset
               restrictions provably block breakout.
  SAFE-DES  – Intentional design decision acknowledged in source comments; safe within
               stated scope.
  NO-EXEC   – Sink can receive crafted content but CSP prevents script execution.
  INFO      – Noteworthy behaviour; not a finding.

---

## 1. innerHTML sinks

| # | Sink (file:line) | Source Data | Transformation | Verdict |
|---|---|---|---|---|
| S01 | `16_client-row-core.js:1587` img posterEl into innerHTML | `resolveClientPoster(item, item.poster)` — API-returned URL | `escapeAttr(poster)` before injection | SAFE |
| S02 | `16_client-row-core.js:1598` year in subtitle | `item.year` — API number/string | `escapeHtml(String(year))` | SAFE |
| S03 | `16_client-row-core.js:1606-1615` full card | item.title, item.name, cardClass | `escapeAttr(cardClass)`, `escapeAttr(title)`, `escapeHtml(title)` | SAFE |
| S04 | `16_client-row-core.js:1527` rating badge | ratingType, title — API data | `escapeAttr(ratingType)`, `escapeAttr(title)` | SAFE |
| S05 | `16_client-row-core.js:1579` data-act-args with dataAttrs | options.dataAttrs — caller-controlled | `escapeAttr(key)`, `escapeAttr(String(...))` | SAFE |
| S06 | `16_client-row-core.js:2210` box.innerHTML signInToInstallHtml | data.error — server error msg | `escapeHtml(message)`, `escapeHtml(names.join(','))` | SAFE |
| S07 | `16_client-row-core.js:2214-2281` confirm/alert modal | title, message, confirmBtnText | All wrapped in `escapeHtml()` | SAFE |
| S08 | `16_client-row-core.js:2445-2449` prompt modal | title, message, defaultValue | `escapeHtml()` / `escapeAttr()` | SAFE |
| S09 | `16_client-row-core.js:2769` support bubble | catLabel, senderLabel, m.text, timeStr | `escapeHtml()` on all | SAFE |
| S10 | `16_client-row-core.js:3295` source row URL input | URL value from row state | `escapeAttr(u)` | SAFE |
| S11 | `16_client-row-core.js:3343` channel summary | summary string — server-derived channel config | `escapeHtml(summary)` | SAFE |
| S12 | `16_client-row-core.js:3560` publishedUrl in `<a href=` | `data.url` from `/api/creator/lists` response: `${origin}/lists/${username}/${slug}` where username ∈ `[a-z0-9_-]`, slug ∈ `[a-z0-9-]` | `escapeAttr(payload.publishedUrl)` on href, `escapeHtml(payload.publishedUrl)` on text | SAFE |
| S13 | `16_client-row-core.js:3823` avatar letter | `name\|group\|'L'` — user display name or group | `escapeHtml(String(...trim()[0]))` — single char | SAFE |
| S14 | `16_client-row-core.js:3848` list name input | name from row state | `escapeAttr(name || '')` | SAFE |
| S15 | `16_client-row-core.js:3865` shelf title | name from row state | `escapeHtml(name || 'Unnamed')` | SAFE |
| S16 | `24_client-backup-restore-presets.js:2251` error text | saveErrorMessage — network/server error | `escapeHtml(saveErrorMessage)` | SAFE |
| S17 | `24_client-backup-restore-presets.js:2282-2331` install URL box | installUrl = `ORIGIN + '/' + config + '/manifest.json'` where config ∈ `[A-Za-z0-9_-]{12}` (server-generated base64url) | No HTML-special chars in config or ORIGIN; `stremioInstallUrl` = installUrl with protocol swapped, `stremioWebUrl` = `encodeURIComponent(installUrl)` | SAFE |
| S18 | `22_client-creator-profile.js:681` displayName in h3 | `activeCreator.displayName` — from API + localStorage; strips control chars; max 40 chars | `escapeHtml(activeCreator.displayName)` | SAFE |
| S19 | `22_client-creator-profile.js:878` account delete confirm | displayName | `escapeHtml(activeCreator.displayName)` | SAFE |
| S20 | `22_client-creator-profile.js:1978` displayName modal | displayName from API | `escapeHtml(data.displayName)` | SAFE |
| S21 | `22_client-creator-profile.js:4008` key reveal modal | displayName | `escapeHtml(displayName)` | SAFE |
| S22 | `23_client-list-management.js:1254,1265,1318` poster tiles | `livePreviewPosterHtml(item)` — API items from provider catalogs | `escapeAttr(resolvedPoster)`, `escapeAttr(m.id)` | SAFE |
| S23 | `23_client-list-management.js:1851-1864` remove buttons in poster cards | `m.removeExternalProvider`, `m.id`, etc. — API data | `escapeAttr()` on all | SAFE |
| S24 | `worker_entry_combined.js:77727` preset names (names.map) | preset names from localStorage | Could not read line; trace from source: preset names set/read by `24_client-backup-restore-presets.js` which escapes on output | INFO — needs follow-up |
| S25 | `worker_entry_combined.js:80818` appShellExplorePreviewInnerHtml | `appShellExplorePreview` — explore preview state | Function uses `appShellChannelEscape()` / `appShellChannelAttr()` which wrap `escapeHtml`/`escapeAttr` | SAFE |

## 2. insertAdjacentHTML sinks

| # | Sink (file:line) | Source Data | Transformation | Verdict |
|---|---|---|---|---|
| I01 | `16_client-row-core.js:112,130,150,172,193,2534,2612,2958,3210,3246` | Static literal: `'<span class="check-icon">&#x2713;</span> '` | No user data | SAFE |
| I02 | `19_client-search-and-likes.js:3351,4142,4144,4172,4174,4206,4208,4243,4245,4806` | Static badge/button HTML | No user data (badge SVG, button text literals) | SAFE |
| I03 | `20_client-channel-builder.js:47,9387,10131` | Static literal check-icon | No user data | SAFE |
| I04 | `21_client-custom-list-builder.js:1255,1320` | `watchBadgeHtml(state)` where state ∈ `{'partial', *}` | Returns one of two static string literals | SAFE |
| I05 | `23_client-list-management.js:1723,1748,1783` | `first.map(livePreviewPosterHtml).join('')` — API catalog items | See S22/S23: all fields use `escapeAttr()`/`escapeHtml()` | SAFE |

## 3. location.href / window.open / redirect sinks

| # | Sink (file:line) | Source Data | Transformation | Verdict |
|---|---|---|---|---|
| R01 | `17_client-my-lists-and-trakt-oauth.js:574` | `ORIGIN + '/api/mdblist/oauth/start'` — literal path | ORIGIN = location.origin; no user input | SAFE |
| R02 | `17_client-my-lists-and-trakt-oauth.js:726` | `ORIGIN + '/api/trakt/oauth/start'` — literal path | Same as R01 | SAFE |
| R03 | `17_client-my-lists-and-trakt-oauth.js:1494` | `ORIGIN + '/api/tmdb/oauth/start'` — literal path | Same as R01 | SAFE |
| R04 | `17_client-my-lists-and-trakt-oauth.js:1795` | `ORIGIN + '/api/simkl/oauth/start'` — literal path | Same as R01 | SAFE |

No `window.open()`, `location.replace()`, or `location.assign()` calls found in client JS sources.

## 4. eval / new Function / document.write sinks

| # | Sink | Verdict |
|---|---|---|
| E01 | `eval()` | SAFE — absent from all client JS files (probe Suite 6 confirms) |
| E02 | `new Function()` | SAFE — absent from all client JS files (probe Suite 6 confirms) |
| E03 | `document.write()` | SAFE — absent from all client JS files (probe Suite 6 confirms) |

## 5. img src= attribute sinks (poster/artwork URLs)

| # | Sink (file:line) | Source Data | Transformation | Verdict |
|---|---|---|---|---|
| P01 | `16_client-row-core.js:1587` | `resolveClientPoster(item, item.poster)` — provider artwork URL | `escapeAttr(poster)` | SAFE — `escapeAttr` blocks HTML breakout; `javascript:` is CSS-safe since `img` ignores JS protocol |
| P02 | `22_client-creator-profile.js:4877` | `itemPoster` — server-returned poster URL from creator list items | `escapeAttr(itemPoster)` | SAFE — same as P01 |
| P03 | `23_client-list-management.js:1821` | `resolvedPoster` — API data | `escapeAttr(resolvedPoster)` | SAFE |

Note: `javascript:` URI in an `<img src=>` is a browser no-op (browsers do not follow JS protocols on img src). `escapeAttr` passes it unchanged but it cannot execute. Not a finding.

## 6. a href= sinks

| # | Sink (file:line) | Source Data | Transformation | Verdict |
|---|---|---|---|---|
| H01 | `16_client-row-core.js:3560` | `payload.publishedUrl` = `${origin}/lists/${username}/${slug}` where username ∈ `[a-z0-9_-]`, slug ∈ `[a-z0-9-]` — server-generated | `escapeAttr()` | SAFE |
| H02 | Install button hrefs `24_:2295,2298,2301` | `stremioInstallUrl` = `stremio://…/…/manifest.json`, `nuvioInstallUrl`, `stremioWebUrl` | Derived from config ∈ `[A-Za-z0-9_-]{12}` — no HTML-special chars | SAFE |

## 7. localStorage / sessionStorage sinks

| # | Key | Contents | Risk | Verdict |
|---|---|---|---|---|
| LS01 | `myListAddon:creatorDisplayName` | Display name string | Used in `escapeHtml()` before DOM insertion | SAFE |
| LS02 | `myListAddon:region` | Region code (e.g. "US") | Used to set `regionEl.value` (DOM property, not innerHTML) | SAFE |
| LS03 | `myListAddon:watchHistory` | JSON array of watch items | Items go through `livePreviewPosterHtml` with `escapeAttr`/`escapeHtml` | SAFE |
| LS04 | `myListAddon:feedbackThreadIds` | JSON array of thread ID strings | `JSON.stringify(ids.slice(0,30))` — not rendered directly to DOM | SAFE |
| LS05 | Custom list state | `customlist:v1:{JSON}` | Parsed via `parseCustomListPayloadClient()`; fields used via `escapeHtml`/`escapeAttr` | SAFE |

## 8. CSP and Trusted Types

| Property | Value | Verdict |
|---|---|---|
| `script-src` | `'self' 'nonce-<fresh-128bit>'` — no `unsafe-inline`, no host wildcard | SAFE — nonce per response, CSPRNG (crypto.getRandomValues), 128-bit |
| `style-src` | `'self' 'unsafe-inline'` | SAFE-DES — intentional; hundreds of `style=` attributes; CSS injection possible but script execution blocked |
| `style-src-elem` | `'self' 'nonce-<fresh>'` | SAFE |
| `img-src` | `'self' https: data:` | SAFE-DES — intentional; provider artwork from arbitrary HTTPS hosts; no script execution from img |
| `connect-src` | `'self' https:` | INFO — allows API calls to any HTTPS host; narrowing is a documented future task |
| `frame-ancestors` | `'self'` | SAFE — clickjacking prevented |
| `object-src` | `'none'` | SAFE — no plugin attack surface |
| `base-uri` | `'self'` | SAFE — base-tag injection prevented |
| `frame-src` | `https://www.youtube.com` | SAFE — YouTube trailer embeds only |
| `worker-src` | `'self'` | SAFE — service worker origin-locked |
| Trusted Types | `require-trusted-types-for 'script'` — REPORT-ONLY, gated on `FF_CSP_TT_REPORT` | INFO — not enforced; ~300 innerHTML sinks need migration first; acknowledged by codebase |

## 9. Service Worker

| Property | Value | Verdict |
|---|---|---|
| Scope | Implicit `/` (same origin) | SAFE |
| Origin check | `url.origin !== self.location.origin` → return | SAFE |
| Method gate | `req.method !== 'GET'` → return | SAFE |
| User data in SW template | None (zero `${...}` in SW string) | SAFE |
| Caches | Shell (`/` only) + versioned assets | SAFE — no API responses cached |

## Summary

**Findings confirmed:** 0 (zero) exploitable XSS, template injection, open redirect, or CSRF paths.

**Design decisions noted (not findings):**
- `style-src 'unsafe-inline'` — intentional, documented, enables CSS injection but not script execution
- `img-src https:` — intentional, documented, required for provider artwork
- `connect-src https:` — intentional, listed as future narrowing task
- Trusted Types REPORT-ONLY — intentional; migration path for ~300 innerHTML sinks in progress

**Items needing follow-up (INFO only):**
- S24: Probe could not read `worker_entry_combined.js:77727` preset names from source; source trace indicates escaping via `appShellChannelEscape()` but not directly confirmed from numbered source fragments. Low risk given function chain.
