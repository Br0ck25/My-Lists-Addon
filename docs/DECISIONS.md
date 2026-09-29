# Product and Architecture Decisions

Decisions the owner has made. They are recorded here so the code, the plan documents and future work agree. The newest entries are at the top.

## 2026-09-28 — Lists that live in one browser (P6-9)

| # | Decision | Consequence in the code |
|---|---|---|
| D-16 | **A list saved to an account while signed out is queued with its own copy of the data.** Pressing "Save to an account" signed out copies the whole list into memory (`rememberPendingListSave`, `_pendingListSaves`, `22_`) and opens the sign-in dialog; the queue is pushed right after the sign-in completes (`flushPendingListSaves`, awaited in `submitRestoreProfile`) and, for a new account, after the one-time migration of the browser's lists (`submitCreateProfile`). | Signing in calls `clearLocalAccountData()`, which deletes the whole `myListAddon:` prefix **and** the sessionStorage list mirror, so a payload looked up after the sign-in would not exist -- the copy is made before it, not after. The flush announces what it saved and what it could not, so a failed push never leaves a list only in a store the page has stopped showing. |
| D-17 | **Signing in to an existing account does not auto-merge the browser's lists into it.** The lists are shown, labelled "Saved in this browser only", and each one moves only when its own button is pressed. | The automatic path stays what it was: the whole-store migration runs on **sign-up** (`submitCreateProfile`), where the account is new by definition and nothing can be duplicated. On sign-in to an existing account the button is the person's to press (`saveLocalListToAccount`, private by default), which is the only way to avoid duplicating a list the account already has. |

## 2026-09-28 — Phase 6, session UI cleanup (P6-8)

| # | Decision | Consequence in the code |
|---|---|---|
| D-13 | **The browser keeps no provider credential.** Trakt, MDBList, Simkl and TMDB keys, tokens and session ids belong to the account: they are held in memory for the visit and never written to `localStorage` again. The copy a browser wrote before P6-8 keeps working and is dropped once the account hands the same value back. | `rememberProviderSecret` / `readProviderSecret` / `forgetProviderSecret` / `dropLegacyProviderSecret` and `PROVIDER_SECRET_KEYS` (`16_`). A signed-out visitor who pastes a key keeps it for the visit only -- saving it is what signing in does (`saveState` pushes the keys up). `myListAddon:creatorKey` is **not** in the list: it is what signs this browser in, and it moves with P6-9's session sign-in, together with the rest of the browser-only data (P6-9's "Save to an account" / "Export" is what a browser-only list needs). |
| D-14 | **No inline `on*=` handlers in the builder; controls name their action.** A control carries `data-act`, `data-act-args` (one JSON value, escaped once by `appActArgs`) and `data-act-on` when its tag does not say which event it answers; one delegated listener per event type runs them (`appActDispatch`, `16_`). | The FE-02 shape (a JavaScript string inside an attribute) is deleted from the client, with `escapeJsAttr`; `html_checks.py` resolves every `data-act` against the bundle and fails the builder page if a handler returns. The `/admin` page keeps its own inline handlers until P6-10, which is why that check excludes it. The `'unsafe-inline'` CSP stays until the page's inline `<script>` blocks move (P7-1) -- removing the handlers is headroom, not the fix. |
| D-15 | **`alert()` and friends are not used in the app's page.** A message is the app's own toast (`showToast`) and a question is the app's own dialog. | ~120 calls rewritten in the client; `03_admin.js`'s four are P6-10's. `window.alert` is kept as a one-way shim to the toast, for a call arriving from outside this file. |

## 2026-09-27 — Build and account recovery

| # | Decision | Consequence in the code |
|---|---|---|
| D-11 | **No npm build, no `src/` tree, no frameworks.** The code stays in the numbered split files (`header.js`, `00_`–`26_`), `python build.py` builds `worker_entry_combined.js`, and that one file is pasted into the dashboard. No `package.json`, esbuild, Vitest/Miniflare, ESLint/TypeScript toolchain, or front-end framework (Preact and the like). `CLAUDE.md` and `AGENTS.md` say the same for every assistant. | Where the plan names a `src/<area>/<file>.js` module, it names a responsibility, not a file: that code goes in the numbered file that owns the area, or in a new numbered server file after `26_` (`27_…`). `NEXT_VERSION_ARCHITECTURE.md` §7.2 maps each one. The checks stay (`check_sync.py`, `scope_check.mjs`, `render_check.js`, `html_checks.py`, `gen_map.py`), and tests stay on `node --test` with `tests/harness.mjs`. Phase 2 of `NEXT_VERSION_TASKS.md` is rewritten around this. |
| D-12 | **No email recovery.** | Accounts recover with the Creator Key or the recovery answer, and with the one-time recovery codes planned for Phase 3a. No email is collected or stored. |

Also confirmed by the owner on 2026-09-27: the Cloudflare dashboard offers **Queues, R2 and Analytics Engine** bindings on this account (task P0-6). D1 read replication was not checked.

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
