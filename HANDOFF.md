# Handoff

## Current work: Stremio Discover title logos (2026-11-01)
- On the fixed session branch `arena/8b2876bc-my-lists-addon`. Shared final catalog enrichment already covers all list sources; do not reintroduce per-list allowlists or replace list identity/posters/order.
- `05_catalog-core.js` now carries matching Cinemeta HTTP(S) `logo` into catalog previews. TMDB details append images to the existing credits call and choose English, then neutral PNG logos. The existing merge preserves nonempty source logos. Preview cache bumped to v3. No new requests solely to find a logo, no migrations/settings/dependencies.
- Missing artwork, provider failures, unsupported IDs or preview deadlines retain text titles. A successful Cinemeta response with no logo does NOT trigger TMDB fallback. Real Stremio/provider validation remains outstanding; deploy rebuilt Worker and refresh catalogs. See latest docs/RELEASES.md entry.
- Build/sync/syntax and nine focused preview tests pass. Full suite: 2,717 pass, five failures, one TODO: four previously recorded account-purge/install-manifest failures, plus cold-catalog p95 51.01 ms against 40 ms. Prior handoff already noted this latency instability; do not claim a clean suite or guaranteed cold latency.
- Earlier Nuvio history work requires activity migration A0002 before its deployment; see docs/NUVIO_HISTORY_DEPLOYMENT.md. Do not undo that work or turn on gated feature flags as part of this logo change.
