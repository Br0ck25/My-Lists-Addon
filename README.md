# My Lists Addon

> **Official Hosted Platform**: [**mylistsaddon.com**](https://mylistsaddon.com)  
> **Source Code**: [**github.com/Br0ck25/My-Lists-Addon**](https://github.com/Br0ck25/My-Lists-Addon)  
> **Compatible Players**: [Stremio](https://stremio.com) (Desktop, Web, Mobile, Android TV, Fire TV), [Wako](https://wako.app), [Nuvio](https://nuvio.to), and any player supporting the Stremio Addon Protocol.

A high-performance, full-featured catalog and list management add-on for media players. It transforms your **MDBList**, **Trakt**, **TMDB**, and **Simkl** lists into dynamic catalog rows on your home screen — featuring a full **Custom List Builder**, **Letterboxd CSV Import**, **Virtual TV Channels**, **Airing Next Calendars**, **Continue Watching & Watch History Sync**, **Media Server Scrobbling (Plex / Jellyfin / Emby)**, and **BetterPosters** artwork integration.

This repository contains the complete open-source codebase powering the official hosted platform at [**mylistsaddon.com**](https://mylistsaddon.com). It is free to use with no advertisements or subscriptions.

---

## Getting Started

To use the add-on, you do **not** need to install or host anything yourself. Simply visit [**mylistsaddon.com**](https://mylistsaddon.com):

1. **Build Your Catalogs**: Open [mylistsaddon.com](https://mylistsaddon.com) in any browser.
2. **Add Shelves & Lists**: Add popular charts, streaming provider shelves (Netflix, Max, Disney+, Prime Video, etc.), connect your Trakt, MDBList, Simkl, or TMDB accounts, build custom lists, or design synthetic linear TV channels.
3. **Generate Install Link**: Click **Install Addon** or **Generate Install Link** to copy your personal manifest URL (`https://mylistsaddon.com/<config-id>/manifest.json`) or install directly into Stremio, Wako, or Nuvio with one click.
4. **Creator Profiles (Sync Across Devices)**: Create a free account using just a username (secured by a private Creator Key `MYL-XXXX-XXXX-XXXX`). Your custom lists, channels, watch progress, and settings stay synchronized across all your devices and video players.

Install links never expire. When you update your lists or settings at [mylistsaddon.com](https://mylistsaddon.com), your changes sync to your connected players automatically.

---

## Key Features

### Multi-Provider Catalog Engine
- **MDBList**: Turn public or private MDBList URLs and personal watchlists into catalog rows. Includes one-click browsing of MDBList Toplists and popular charts.
- **Trakt**: Full support for public lists, personal lists, liked lists, watchlists, collections, recommendations, and trending/popular charts. Includes OAuth login and TV/console Device Code authentication (`/api/trakt/device/code`).
- **TheMovieDB (TMDB)**: Support for TMDB v3/v4 lists, user lists, keyword/genre/network/company charts, search, and automated TMDB-to-IMDb external ID resolution.
- **Simkl**: Trending charts across Movies, TV Shows, and Anime (Daily, Weekly, Monthly), plus OAuth account linking for personal list and history import.

### Discover & Quick Add Shelves
- One-click catalog shortcuts for major streaming platforms (Netflix, Disney+, Prime Video, Apple TV+, Max, Hulu, Paramount+, Peacock, Anime, etc.).
- Curated collections, award winners, box office hits, and trending lists built right into the web app.
- **New on Streaming**: Dynamic catalog rows tracking what actually *arrived* on each service, newest first, with a show pushed back to the top the day a new episode airs.

### Custom List Builder & Letterboxd CSV Import
- **Build from scratch**: Search movies and shows across TMDB to create custom catalogs.
- **Letterboxd CSV Import**: Upload Letterboxd export CSVs to batch-resolve titles and release years into IMDb/TMDB IDs (`/api/bulk-resolve`).
- **Community List Sharing**: Publish custom lists to the community directory, clone public lists, and like community catalogs.

### Virtual TV Channel Builder
- Create synthetic linear TV channels and scheduled playlists combining hand-picked episodes from different TV shows and movies into a single row.
- **Play Orders**: Order by air date (oldest or newest first), show-then-season, **interleaved / round-robin** (e.g. 90s prime-time blocks), A-Z, or shuffle daily.
- **Daily Broadcast Schedule**: Rotating 24/7 lineup with dials for how many shows run per day, episode block sizes, and turnover time.
- **Story Lock**: Keep serialized dramas advancing in chronological sequence while procedurals and comedies shuffle around them.
- **Hide Watched**: Skip episodes already in your Watch History once auto-tracking is enabled.
- **Next Up Channels**: Derives a live channel from your Continue Watching shelf so pressing play always serves the next unwatched episode across your active shows.
- **Spotlight Channels**: Search an actor, director, or creator to generate a complete filmography channel in career order or best-first.
- **Auto-Sync & Updates**: Channels can automatically fold in newly-aired episodes or follow upstream Trakt, MDBList, Simkl, or TMDB lists live.
- **Custom Branding**: Built-in channel logo generator and custom poster rendering (`/api/channel-poster`).

### Continue Watching, Airing Next & Watch History
- Automatically tracks watch progress and next unwatched episode per show.
- Mark titles or whole seasons as watched/unwatched directly from the UI.
- **Airing Next Shelf**: Displays upcoming episodes of shows you watch, ordered soonest first, with exact broadcast air times sourced from TVmaze.
- **Automated Cron Sync**: Background tasks query TMDB every 6 minutes to find newly-aired episodes for caught-up shows and push them to your Continue Watching row.

### Media Server Playback Scrobbler (Plex / Jellyfin / Emby)
- Automatically scrobble playback events from your home media servers into your Watch History and Continue Watching progress.
- Supports webhook integration via secure, scoped scrobble tokens:
  ```
  POST https://mylistsaddon.com/api/scrobble?st=<your-scrobble-token>
  ```
- Generate and rotate your scoped scrobble tokens anytime under **Creator Profile &rarr; Scrobble Webhook**.

### BetterPosters Artwork (Optional)
- Optional integration with [BetterPosters](https://btttr.cc/) to render genre tags, IMDb/Rotten Tomatoes/Metacritic/Trakt ratings, and 4K/HDR badges directly into poster artwork.
- Toggle anytime under **Settings &rarr; Account & Sync &rarr; Better Posters**. Applies seamlessly across web previews and Stremio/Nuvio catalog rows.

### Progressive Web App (PWA)
- Installable PWA with an offline-capable app shell (`/sw.js` and `/app.webmanifest`).
- Works on desktop and mobile browsers, with dark mode, clipboard shortcuts, and QR code sharing.

---

## App Integration & Supported Clients

| Client / Protocol | Compatibility & Setup |
|---|---|
| **Stremio** (Desktop, Android, iOS Web, Android TV, Fire TV) | Fully compatible with Stremio Addon Protocol v3. Install via one-click `stremio://` deep link or paste your manifest URL into the Stremio search bar. |
| **Wako** | Fully compatible. Add your manifest URL as a third-party catalog provider. |
| **Nuvio** | Native support for catalog rows, search feeds, and synthetic channel playback. |
| **Plex / Jellyfin / Emby** | Webhook scrobbler for syncing playback progress directly to your watch history. |

---

## API & Endpoint Reference

| Endpoint | Method | Description |
|---|---|---|
| `/` | `GET` | Web configuration interface and PWA |
| `/:config/configure` | `GET` | Web interface pre-populated with an existing configuration |
| `/:config/manifest.json` | `GET` | Stremio Addon Protocol Manifest (redirects to `/configure` in browsers) |
| `/:config/catalog/:type/:id.json` | `GET` | Catalog item feed with pagination (`skip=`) support |
| `/api/title-search` | `GET` | Search movies and TV shows via TMDB |
| `/api/bulk-resolve` | `POST` | Batch resolve movie title/year pairs to IMDb IDs (Letterboxd import) |
| `/api/show-seasons` | `GET` | Fetch season metadata for a TV show |
| `/api/show-episodes` | `GET` | Fetch episode metadata for a season |
| `/api/toplists` | `GET` | Fetch popular MDBList toplists |
| `/api/trakt-popular-lists` | `GET` | Fetch trending and popular Trakt lists |
| `/api/recommendations` | `POST` | Fetch TMDB recommendations for selected titles |
| `/api/trakt/device/code` | `POST` | Initiate Trakt TV / console device login |
| `/api/trakt/device/token` | `POST` | Poll Trakt device authentication status |
| `/api/creator/*` | `POST` | Creator Profile authentication, list management, and sync |
| `/api/creator/lists` | `POST` | Paginated creator list index metadata |
| `/api/creator/lists/items` | `POST` | Detailed items for up to 100 named lists |
| `/api/scrobble` | `POST` | Webhook receiver for Plex, Jellyfin, and Emby playback scrobbling (`?st=<token>`) |
| `/admin` | `GET` | Platform administrative analytics dashboard |
| `/admin/api/*` | `GET/POST` | Administrative management, stats, feedback inbox, and moderation APIs |
| `/sw.js` | `GET` | Service worker for offline PWA caching |
| `/app.webmanifest` | `GET` | Web App Manifest for mobile and desktop installation |

### Security & Credential Handling
- **Install Links as Bearer Tokens**: An install URL (`/<config-id>/manifest.json`) represents your configured catalogs. When stored in the cloud, credentials remain encrypted. Do not share your private install URLs publicly.
- **Scoped Scrobble Tokens**: Media server webhooks authenticate using dedicated tokens (`?st=...`), ensuring your root Creator Key is never exposed to webhook logs.
- **Creator Keys**: Accounts are secured using salted PBKDF2-SHA256 hashed keys (`MYL-XXXX-XXXX-XXXX`). Server-side API tokens are encrypted with AES-256-GCM.

---

## Local Development & Contributing

This project is developed as a modular JavaScript application running on Cloudflare Workers, compiled into a single production bundle without external build tooling.

### Prerequisites
- **Node.js** (v20+ recommended, test runner uses built-in `node:test`)
- **Python 3** (used by the bundle assembly and verification scripts)

### Building the Bundle
The application source is modularized across ES modules (`00_constants.js` through `26_api-creator-and-admin-routes.js`). To compile them into `worker_entry_combined.js`:

```bash
# Using Python
python build.py

# Or on Windows PowerShell
.\build.ps1
```

### Running Tests
The project maintains a zero-external-dependency test harness using Node.js's native test runner:

```bash
# Run all test suites
node --test tests/*.test.mjs

# Run a specific test suite
node --test tests/worker.test.mjs
```

### Verification Scripts
Before submitting changes, ensure all sync checks and budgets pass:

```bash
# Verify the combined worker matches the split source files
python check_sync.py

# Verify JavaScript syntax of the bundle
node --check worker_entry_combined.js

# Verify bundle size constraints and performance budgets
node check_bundle_budget.mjs
```

---

## Environment & Configuration Reference

The following environment variables, secrets, and Cloudflare bindings configure the hosted platform and the test runner:

| Variable / Binding | Type | Description |
|---|---|---|
| `CONFIGS` | KV Binding | Fast key-value store for install configs, caches, and rate counters |
| `DB` | D1 Binding | Primary relational database (`my-lists-db`) for accounts, lists, search, and analytics |
| `ANALYTICS` | Analytics Engine | Per-request route, status, and performance telemetry |
| `BLOBS` | R2 Bucket | Storage for shared channels' episode catalogs and exports |
| `JOBS` | Queue Producer | Cloudflare Queue for asynchronous background tasks |
| `DB_ACTIVITY` | D1 Binding | Activity and watch history database (`mylists-activity`) |
| `TMDB_API_KEY` | Secret | TheMovieDB API key for metadata, seasons, episodes, search, and posters |
| `TRAKT_CLIENT_ID` | Secret | Trakt OAuth application client ID |
| `TRAKT_CLIENT_SECRET` | Secret | Trakt OAuth application client secret |
| `SIMKL_CLIENT_ID` | Secret | Simkl API application client ID |
| `SIMKL_CLIENT_SECRET` | Secret | Simkl API application client secret |
| `MDBLIST_API_KEY` | Secret | MDBList API key for private lists and metadata |
| `MDBLIST_POPULAR_KEY` | Secret | Dedicated MDBList key for Toplists and popular catalogs |
| `MDBLIST_CLIENT_ID` | Secret | MDBList OAuth client ID |
| `MDBLIST_CLIENT_SECRET` | Secret | MDBList OAuth client secret |
| `TOKEN_ENCRYPTION_KEY` | Secret | AES-256-GCM encryption key (`k1:<base64>`) for stored provider credentials |
| `LOOKUP_PEPPER` | Secret | HMAC-SHA256 secret pepper for blind indexing creator keys |
| `ADMIN_KEY` | Secret | Administrative dashboard access passphrase |
| `CF_ACCESS_TEAM_DOMAIN` | Variable | Cloudflare Access team domain for Zero Trust dashboard authentication |
| `CF_ACCESS_AUD` | Variable | Cloudflare Access application AUD tag |
| `FF_ADMIN_EMAILS` | Variable | Comma-separated admin emails permitted via Cloudflare Access |
| `CF_ANALYTICS_TOKEN` | Secret | Cloudflare API token for querying Analytics Engine (alias: `CLOUDFLARE_API_TOKEN`) |
| `CF_ANALYTICS_ACCOUNT_ID` | Variable | Cloudflare Account ID for Analytics queries (alias: `CLOUDFLARE_ACCOUNT_ID`) |
| `CLOUDFLARE_API_TOKEN` | Secret | Alias for `CF_ANALYTICS_TOKEN` |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | Alias for `CF_ANALYTICS_ACCOUNT_ID` |
| `RAPIDAPI_KEY` | Secret | RapidAPI key for optional provider lookups |
| `STREAMING_AVAILABILITY_API_KEY` | Secret | Streaming Availability API key for optional provider lookups |
| `NEW_ON_STREAMING_ENGINE` | Variable | Configuration selector for New on Streaming catalog backend |
| `ACTIVITY_SHARD_COUNT` | Variable | Activity sharding factor for high-throughput activity writes |
| `INSTALL_MIGRATION_PERCENT` | Variable | Rollout percentage for migrating install secrets into encrypted D1 storage |
| `FF_SESSIONS` | Variable | Feature flag: Enables session authentication cookies |
| `FF_INSTALLS` | Variable | Feature flag: Enables `/api/installs` token management |
| `FF_NEW_UI` | Variable | Feature flag: Activates the modern responsive user interface |
| `FF_V2_LISTS_READ` | Variable | Feature flag: Reads lists from relational D1 v2 schema |
| `FF_V2_LISTS_API` | Variable | Feature flag: Item-level v2 list manipulation API |
| `FF_V2_LISTS_ONLY` | Variable | Feature flag: Exclusively uses relational v2 list storage |
| `FF_PROVIDER_BREAKER` | Variable | Feature flag: Circuit breaker preventing upstream provider cascades |
| `FF_CHART_SNAPSHOTS` | Variable | Feature flag: Background-cached provider chart snapshots |
| `FF_CANONICAL_IDS` | Variable | Feature flag: Normalizes catalog IDs to canonical IMDb / TMDB identifiers |
| `FF_EVENT_TRACKING` | Variable | Feature flag: Enables granular telemetry event tracking |
| `FF_MATERIALIZER` | Variable | Feature flag: Background list materializer |
| `FF_SHOW_SCHEDULE` | Variable | Feature flag: Background show schedule synchronizer |
| `FF_CSP_TT_REPORT` | Variable | Feature flag: Report-only CSP Trusted Types auditing |
| `FF_SCROBBLE_ST_ONLY` | Variable | Feature flag: Enforces scoped scrobble tokens exclusively |
| `SCROBBLE_SUNSET_DATE` | Variable | Sunset cutover date for legacy scrobble query parameters |
| `SUNSET_60DAY_START_DATE` | Variable | Activation date for in-app 60-day sunset deprecation notices |

---

## Architecture & Operator Documentation

For system architecture details, operational checklists, deployment runbooks, and architectural decisions, refer to the documentation in `docs/`:

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — Architectural design, system boundaries, and multi-tier storage models (D1, KV, R2).
- **[docs/OPERATIONS.md](docs/OPERATIONS.md)** — Production operations, Cloudflare dashboard configurations, background queues, and maintenance runbook.
- **[docs/DEPLOY_CHECKLIST.md](docs/DEPLOY_CHECKLIST.md)** — Step-by-step release checklist, staging verification, and rollback procedures.
- **[docs/CUTOVER.md](docs/CUTOVER.md)** — Cutover runbook, legacy storage sunset, and migration verification.
- **[docs/DECISIONS.md](docs/DECISIONS.md)** — Architectural Decision Records (ADRs) explaining technical choices.

---

## Support This Project

My Lists Addon is a free community service with no ads or subscriptions. If you enjoy using the platform and want to help cover hosting and infrastructure costs or support ongoing development:

- **Buy Me A Coffee**: [buymeacoffee.com/brock25](https://buymeacoffee.com/brock25)
- **TorBox Debrid (Referral)**: [torbox.app/subscription?referral=af23795c-7706-4b02-a979-d84b5613cfd1](https://torbox.app/subscription?referral=af23795c-7706-4b02-a979-d84b5613cfd1)

---

## License

This project is licensed under the [MIT License](LICENSE).
