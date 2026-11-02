# Backend audit prompt

Paste everything below the line into a new Claude Code session (or another
coding agent) opened on this repo. It runs a **read-only** audit and writes
its findings to `docs/BACKEND_AUDIT.md`. Nothing is fixed until you approve
the list. If a session runs out of credits, start a new one with the same
prompt: it resumes from the progress table in the report.

---

You are auditing the **backend** of My Lists Addon: one Cloudflare Worker
(D1 `DB` and `DB_ACTIVITY`, KV `CONFIGS`, R2 `BLOBS`, Queue `JOBS`, Analytics
Engine `ANALYTICS`, `IMAGES`, `send_email`, a cron every 6 minutes). Find
**bugs, runtime errors, security gaps, dead code, duplicated code that should
reuse an existing helper, and slow code**. The owner is not a coder, so every
finding needs a plain-English line saying what a user would notice.

## Ground rules (read first, they override your defaults)

1. Read `CLAUDE.md`, `docs/ARCHITECTURE.md` and `docs/DECISIONS.md` before
   anything else. A behaviour recorded as a decision in `DECISIONS.md` is
   **not** a bug. If you think a decision is wrong, list it under
   "Questions for the owner" and do not count it as a finding.
2. **This is an audit only. Do not edit anything under `src/`, `tests/`,
   `migrations/` or `schema*.sql`, and do not commit fixes.** The only file you
   write is `docs/BACKEND_AUDIT.md`. Throwaway scripts go in your scratchpad
   or temp directory, never in the repo.
3. **Never open `worker_entry_combined.js`** (5 MB, generated). Read only the
   sources in `src/`.
4. Find code cheaply: `docs/FILE-INDEX.md` says which file holds what.
   `grep` `docs/FUNCTION-MAP.md` for a symbol or route (never read it whole),
   then read only that part of the source with offset/limit. Files over 2,000
   lines must be read in chunks.
5. All numbered sources are concatenated into **one shared scope** by
   `build.py`. A function in `05_*.js` can be called from `26_*.js` with no
   import. "No callers" means no callers in **all of `src/`**, including the
   client and page files, which live inside template literals.
6. Before you call something dead, search for **every way it can be reached**:
   - a direct call or reference anywhere in `src/` (including `src/client/`
     and `src/page/` strings);
   - a route string in the router (`src/api/25_api-catalog-routes.js` and
     `26_*.js`, which is the second half of the same router function, so its
     symbol count is 0) and in `tests/route-access.json`;
   - a job type string enqueued or dispatched (`src/jobs/44_*`, `45_*`);
   - a `data-action` / `data-*` attribute or `window.*` handler in client code;
   - a property-name lookup (`handlers[name]`, `obj[key]`);
   - a test in `tests/` that imports it from the built Worker.
   Something that is used only by a test is "test-only", not dead.
7. Every finding needs **evidence**: `file:line`, the exact lines quoted (keep
   it short), the search you ran to prove it, and a concrete **failure
   scenario** (what input or state, and what goes wrong). No evidence means it
   is not a finding; put it under "Unverified hunches" instead.
8. Run `bash verify.sh -q` once at the start and record the result, so known
   failures are not reported as new ones. You may run single test files
   (`node --test tests/<file>.test.mjs`) to confirm a suspicion.

## Scope

**In scope (backend):** `src/header.js`, `src/core/`, `src/catalog/`,
`src/api/`, `src/data/`, `src/jobs/`, the server-side code in `src/admin/`,
`schema.sql`, `schema_activity.sql`, `migrations/`, `wrangler.toml` and
`wrangler.selfhost.toml`.

**Out of scope:** UI look, CSS and client behaviour in `src/client/` and
`src/page/`. Read them only to find callers of backend code and the shape of
the requests they send.

Work through the groups in this order (it starts with what the most traffic
touches) and update the progress table after each file:

1. `core` (00, 02, 04)
2. `api` (25, 26, 27, 28, 31, 32, 33, 61)
3. `catalog` (05, 06, 07, 08, 41, 42, 43, 48, 57)
4. `data` (29, 30, 34, 35, 36, 37, 38, 39, 40)
5. `jobs` (44 to 60)
6. `admin` (03 server routes, 59)
7. schema, migrations and wrangler config

## What to look for

### A. Bugs and runtime errors
- Promises not awaited, or background work not passed to `ctx.waitUntil`
  (it is cut off when the response returns).
- A bare `catch {}` or `catch (e) {}` that hides a `ReferenceError` or
  `TypeError`. Three earlier bugs hid exactly like this (see `verify.sh` step
  3b). Name each swallowing catch that wraps more than one line of logic.
- `JSON.parse` on KV, D1 or provider data with no guard; `.length`, `.map` or
  property reads on a value that can be `null` or `undefined`.
- Optional bindings used without a check. A self-hosted copy may not have
  `DB_ACTIVITY`, `ANALYTICS`, `IMAGES`, `BLOBS`, `JOBS` or `send_email`; the
  code must degrade, not throw.
- Read-modify-write on KV or D1 that loses an update when two requests run at
  once. KV is eventually consistent (reads can be up to about 60 seconds old)
  and has no atomic increment.
- D1 limits: more than 100 bound parameters in one statement, unbounded
  `SELECT` with no `LIMIT`, `batch` assumed atomic across the two databases,
  or across D1 and KV.
- Worker limits: subrequest counts in loops over provider APIs, CPU-heavy
  loops in a request path, large bodies held in memory.
- Queue and cron: a job that is not safe to run twice (queues retry), a cron
  job that can overlap the next run, a job type enqueued but never handled or
  handled but never enqueued.
- Feature flags (`FF_*`): a branch that can no longer be reached, both
  branches out of sync, and a flag read in code but missing from
  `docs/OPERATIONS.md` §3 or the wrangler files (and the reverse).
- Wrong HTTP status or headers: errors returned as 200, private data sent
  with a public `Cache-Control`, missing CORS headers on routes Stremio,
  Nuvio or Wako call.
- Off-by-one paging, `skip`/`limit` parsing, dates and time zones, IMDb vs
  TMDB id mix-ups, a movie treated as a show (a movie never has episodes).

### B. Security
- Every route in the router matches `tests/route-access.json`, and every
  admin route checks `isAdminRequest`. List any route missing from the JSON.
- Owner checks: can account A read or change account B's lists, installs,
  history or connections by changing an id in the URL or body?
- SQL built by string concatenation with user input (anything not bound with
  `?`).
- Server-side fetches of a URL the user supplied (SSRF), open redirects,
  secrets or tokens written to logs, Analytics Engine, KV values or error
  messages.
- Secret comparisons that are not constant-time, and rate limits that use
  `consumeRateLimit` where `DECISIONS.md` D-29 says `reserveRateLimit` (or the
  reverse).
- Legacy auth paths (`?config=`, `?creator=&key=`) that were due to sunset
  but are still accepted.

### C. Dead code
- Top-level functions and constants with no reachable caller (see ground
  rule 6).
- Code that only runs behind a flag that is now always on or always off, or
  behind a legacy path whose sunset date has passed (for example the
  retired classic page, `FF_NEW_UI`).
- KV key prefixes written but never read, or read but never written.
- D1 tables or columns never queried, and indexes never used.
- Job types, routes and admin actions nothing calls.
- Comments that describe code that no longer exists.
Per `CLAUDE.md` rule 9 these are **reported, not deleted.** Say whether each
is safe to remove and what would have to be checked first.

### D. Reuse and duplication
- The same logic written two or more times: fetch-with-timeout and retry
  wrappers, JSON and error response builders, provider calls (TMDB, Trakt,
  MDBList, Simkl), id normalisation, HTML escaping, KV get-JSON/put-JSON,
  paging, rate-limit calls, session and owner lookups.
- For each, name the **existing** helper the copies should call (with its
  `file:line`) and list every copy. Do not invent a new abstraction when one
  already exists. `CLAUDE.md` rule 2 forbids refactors for their own sake, so
  report only duplication that has already caused, or can easily cause, the
  copies to behave differently. Say which copy is the correct one.

### E. Performance
- Sequential `await`s in a loop that could run together, N+1 D1 queries,
  KV `list()` scans in a request path, missing indexes for a hot `WHERE`
  (check against `schema.sql` and `migrations/`), work repeated per request
  that could be cached, and anything on the catalog path that adds to the
  cold-catalog budget in `tests/load-performance.test.mjs`.

### F. Docs drift
- Where `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md` or code comments say
  something the code does not do (for example cron cadence, job lists,
  bindings, flag lists). Low priority, one line each.

## Severity

- **P0**: data loss, one account reaching another's data, a secret leak, or
  the addon or site broken for everyone.
- **P1**: a feature broken or wrong for some users, a crash on a reachable
  path, a route with weaker auth than it should have.
- **P2**: an edge-case bug, a race that is unlikely but possible, a real
  performance cost, duplication whose copies already differ.
- **P3**: dead code, small duplication, docs drift, tidiness.

Mark each finding's confidence **High** (proven by reading the path end to
end or by a test run), **Medium** (the path looks reachable but was not
traced fully) or **Low** (a hunch, and it goes under "Unverified hunches").

## Output: `docs/BACKEND_AUDIT.md`

Create it at the start and update it as you go, so the work survives a
session ending. Use this layout:

```
# Backend audit (<date>, build <stamp from python build.py>)

## Summary for the owner
Five to ten plain-English sentences: how healthy the backend is, the worst
problems, and what to fix first. No jargon.

## Baseline
verify.sh result, and any tests already failing before the audit.

## Progress
| file | status (todo / done) | findings |

## Fix first (top 10, by severity then effort)
| # | id | one line | severity | effort (S/M/L) |

## Findings
### BA-001 <short title>
- Category: bug | security | dead-code | reuse | performance | docs
- Severity / confidence: P1 / High
- Where: src/…:123
- Evidence: <quoted lines> and <the search you ran>
- What goes wrong: <input or state> leads to <result>
- What a user notices: <plain English>
- Suggested fix: <smallest root-cause fix, naming the helper to reuse>
- Test that would prove it: <which test file, and what it asserts>

## Dead code (safe-to-remove list)
| symbol | file:line | how you proved no callers | safe to remove? |

## Questions for the owner
Product decisions only (rule 8 in CLAUDE.md).

## Checked and fine
Areas you looked at that are OK, so the next audit does not re-check them.

## Unverified hunches
```

Number findings `BA-001`, `BA-002`… in the order found and never renumber.

## When you finish

1. Re-read every P0 and P1 finding and trace it once more. Remove any you
   cannot prove, or downgrade them to hunches.
2. Run `bash verify.sh -q` again to confirm you changed nothing (only
   `docs/BACKEND_AUDIT.md` should appear in `git status`).
3. Commit `docs/BACKEND_AUDIT.md` alone, with the message
   `docs: backend audit <date>`, and push to your working branch.
4. Reply with the "Summary for the owner" and the "Fix first" table, and ask
   which findings to fix.

## Fixing (only after the owner picks findings)

One finding per commit. For each: write the failing test first
(`CLAUDE.md` rule 10), make the smallest root-cause fix in `src/`, run
`python build.py`, the test file, then `bash verify.sh -q`. Run
`python tools/gen_map.py` if functions were added, removed or moved. Mark the
finding **Fixed in <commit>** in `docs/BACKEND_AUDIT.md`. Never loosen a test
or guard to get green.
