/**
 * My Lists (mylistsaddon.com) -- Cloudflare Worker
 *
 * GENERATED FILE. Do not edit worker_entry_combined.js by hand: it is built
 * from header.js plus the numbered sources (00_ ... 26_) by `python build.py`
 * (or `./build.ps1`), and CI fails if the committed file drifts from them.
 *
 * Deployment: paste this whole file into the Cloudflare dashboard (Workers &
 * Pages -> this Worker -> Edit code -> Deploy). Bindings, secrets and cron
 * triggers are configured in the dashboard; see docs/OPERATIONS.md for the
 * full list and the release checklist.
 *
 * What it serves:
 *  - the My Lists website (builder, lists, channels, discover, settings);
 *  - the Stremio add-on protocol for Stremio / Nuvio / wako
 *    (/:config/manifest.json, /:config/catalog/..., /:config/meta/...);
 *  - the JSON API the website uses (/api/...), and /admin.
 *
 * Storage: D1 (binding DB) and Workers KV (binding CONFIGS). The target
 * architecture -- D1 as the only source of truth, KV as a cache -- is in
 * NEXT_VERSION_ARCHITECTURE.md.
 */

