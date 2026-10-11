# My Lists Addon

> **Official Hosted Platform**: [**mylistsaddon.com**](https://mylistsaddon.com)  
> **Source Code**: [**github.com/Br0ck25/My-Lists-Addon**](https://github.com/Br0ck25/My-Lists-Addon)  
> **Compatible Players**: [Stremio](https://stremio.com) (Desktop, Web, Mobile, Android TV, Fire TV), [Wako](https://wako.app), [Nuvio](https://nuvio.to), and any player supporting the Stremio Addon Protocol.

A high-performance, full-featured catalog and list management add-on for media players. It transforms your **MDBList**, **Trakt**, **TMDB**, and **Simkl** lists into dynamic catalog rows on your home screen — featuring a full **Custom List Builder**, **Letterboxd CSV Import**, **Virtual TV Channels**, **Airing Next Calendars**, **Continue Watching & Watch History Sync**, **Media Server Scrobbling (Plex / Jellyfin / Emby)**, and **BetterPosters** artwork integration.

This repository is the source code of the hosted service at [**mylistsaddon.com**](https://mylistsaddon.com). It is free to use with no advertisements or subscriptions. It is not meant to be self-hosted.

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
- Installable as an app on desktop and mobile (`/app.webmanifest`). Needs a connection to use.
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
| `/sw.js` | `GET` | Service worker (caches the app's scripts and styles) |
| `/app.webmanifest` | `GET` | Web App Manifest for mobile and desktop installation |

### Security & Credential Handling
- **Install Links as Bearer Tokens**: An install URL (`/<config-id>/manifest.json`) represents your configured catalogs. When stored in the cloud, credentials remain encrypted. Do not share your private install URLs publicly.
- **Scoped Scrobble Tokens**: Media server webhooks authenticate using dedicated tokens (`?st=...`), ensuring your root Creator Key is never exposed to webhook logs.
- **Creator Keys**: Accounts are secured using salted PBKDF2-SHA256 hashed keys (`MYL-XXXX-XXXX-XXXX`). Server-side API tokens are encrypted with AES-256-GCM.

---

## Development

This project is developed as a modular JavaScript application running on Cloudflare Workers, compiled into a single production bundle without external build tooling.

### Prerequisites
- **Node.js** (v20+ recommended, test runner uses built-in `node:test`)
- **Python 3** (used by the bundle assembly and verification scripts)

### Building the Bundle
The application source is modularized across ES modules (`00_constants.js` onward; `build.py` picks up every `NN_*.js`). To compile them into `worker_entry_combined.js`:

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
node --test tests/service-worker.test.mjs
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

## Contributing: UI changes

Anyone (human or AI) changing buttons, colours, spacing, text or wording follows [`AI_UI_RULES.md`](AI_UI_RULES.md) (one page) and [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md) (full spec, with recipes for adding a button, card, modal or toast). The design tokens live in one place (`DESIGN_TOKENS_CSS` in `00_constants.js`), and `tests/design-system.test.mjs` fails the build when the rules are broken.

---

## Support This Project

My Lists Addon is a free community service with no ads or subscriptions. If you enjoy using the platform and want to help cover hosting and infrastructure costs or support ongoing development:

- **Ko-fi**: [ko-fi.com/mylistsaddon](https://ko-fi.com/mylistsaddon)
- **TorBox Debrid (Referral)**: [torbox.app/subscription?referral=af23795c-7706-4b02-a979-d84b5613cfd1](https://torbox.app/subscription?referral=af23795c-7706-4b02-a979-d84b5613cfd1)

---

## License

This project is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). Noncommercial use only. The project is not intended for self-hosting and comes with no support.
