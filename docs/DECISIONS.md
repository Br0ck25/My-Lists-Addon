# Product and Architecture Decisions

Decisions the owner has made. They are recorded here so the code, the plan documents and future work agree. The newest entries are at the top.

## 2026-09-25 — Next-version direction

| # | Decision | Consequence in the code |
|---|---|---|
| D-1 | **Hosted only.** mylistsaddon.com is the only supported deployment. Self-hosting and the Cloudflare Workers Free plan are no longer supported or designed for. | Free-plan budgets, "Worker owner" messages, the base64 install-link fallback and the cross-deployment `/api/resolve` proxy were removed in Phase 1. See `CLOUDFLARE_FREE_TIER_REMOVAL_PLAN.md`. |
| D-2 | **Cloudflare for everything.** D1, KV, R2, Queues, Analytics Engine and Cron are all fine to use. There is no external database. | Target architecture in `NEXT_VERSION_ARCHITECTURE.md`. |
| D-3 | **Deploy by pasting `worker_entry_combined.js` into the Cloudflare dashboard.** The deployable stays one self-contained file, and every binding must be configurable in the dashboard. | No Wrangler-only features (Workflows, Static Assets, new Durable Object classes). Every new binding is optional in code until it is added in the dashboard. See `docs/OPERATIONS.md`. |
| D-4 | **Dashboard bindings: do what is recommended.** | Recommended bindings: `DB` (D1), `CONFIGS` (KV), `ANALYTICS` (Analytics Engine), plus R2 and Queues in later phases. See `docs/OPERATIONS.md`. |
| D-5 | **Keep JustWatch** as the New on Streaming source for now. | `NEW_ON_STREAMING_ENGINE` stays `"justwatch"`. RapidAPI remains the fallback engine. |
| D-6 | **No anonymous likes or anonymous lists.** Only signed-in accounts can like lists, external lists or channels, share or publish channels, or count as "added" on a channel. | `/api/lists/like`, `/api/lists/like-external` and `/api/channel/like` return 401 `signInRequired` without an account. `/api/channel/share` requires an account. `/api/channel/added` counts once per account and ignores signed-out adds. The site prompts signed-out visitors to log in. Legacy anonymous published lists (`publishedlist:user:*`, D1 `published_lists`) are no longer shown in the directory or search and can't be liked. **Their existing URLs still resolve**, so Stremio catalogs that already use them keep working. An admin can delete them from `/admin`. |
| D-7 | **Leaked credentials in git history:** no action requested. | — |
| D-8 | **Signed-out installs stay, limited to public lists.** A signed-out visitor can add the site's public lists to the Live Preview and generate an install link. Nothing personal or user-made works signed out: no watchlist, Airing Next, watch history or Continue Watching, no custom lists or imports, no channels of their own, no connected provider accounts. | See "D-8 in the code" below. Install links that already exist keep working exactly as they do today. |
| D-9 | **Existing anonymous likes stay.** Votes cast signed-out before D-6 keep counting toward the totals people see. | Nothing removes the `a:`-prefixed voter ids from the like ledgers. |
| D-10 | **Signed-out install links never expire.** An install link made without an account keeps working however long it goes unused. | Nothing deletes or expires `cfg:` records. Task P7-7's idle expiry is dropped. |

## D-8 in the code

**Signed out, a visitor can:**
- add the site's public lists to the Live Preview: Quick Add charts, Discover shelves, curated and storyline lists, community lists from the directory, and links to public MDBList, Trakt, TMDB or Letterboxd lists;
- add a **storyline** (Channels → Storylines, Sagas & Universes → "+ Add") or an **Explore Channels** listing ("+ Add") as it is. It goes into the Live Preview as a catalog row and is not copied into My Channels, for anyone, signed in or not;
- generate an install link from them.

**Signed out, these ask for an account first:**
- custom lists: creating, importing, the Quick List Wizard;
- channels someone builds or changes: + New Channel, Quick Add networks, Next Up, merging, importing a shared link, and **Customize** on a storyline or **Edit** on a channel row. The sign-in prompt appears on that click, not at Save;
- connecting a Trakt, MDBList, Simkl or TMDB account;
- any personal shelf: the site's own Watchlist, Watch History and Continue Watching, or a provider watchlist, history, collection, Up Next or Airing Next.

**Where it is enforced:**
- **`/api/save` is the rule.**
  - `entryAccountRequirement` (`04_config-resolution.js`) decides which rows need an account.
  - A storyline row is recognized by its `storylineId`. Its episodes can't be checked, because the storyline catalogue lives in the page (`TV_CROSSOVER_EVENTS`), not in the Worker.
  - An Explore Channels row must name a share code that is currently listed. For a signed-out save the server stores that listing's published lineup, not the row's own.
  - A save that has one of those rows needs `creatorName`/`creatorKey` for a real account, or it is refused with 401 `signInRequired`.
  - A signed-out save stores no provider keys, tokens or playback tracking.
  - The account proof is verified and never stored in the install link.
- **The builder mirrors it.**
  - `rowNeedsAccount` (`16_client-row-core.js`) makes the same decision in the browser.
  - `addRow` checks it for every new row.
  - The buttons that start the work (+ New List, + New Channel, Connect Trakt and the like) ask first.
  - `generate()` names any rows a signed-out link can't carry.
  - A test keeps the client and server rules in agreement.

**What does not change:**
- Install links that already exist keep serving exactly what they carry, personal rows included.
- A signed-out builder that still holds rows from before D-8 shows them as they were. To make a new link, the visitor signs in or removes those rows.

## Open questions

None.
