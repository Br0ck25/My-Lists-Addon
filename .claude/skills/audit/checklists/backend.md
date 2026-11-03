# Backend audit checklist
Server code only. Read client code only to find callers and request shapes.

**Not in this audit:** browser code and UI (frontend audit); contracts with Stremio/Nuvio/Wako and outside services in depth (api); schema and migrations (database); deep security review (security). Note anything obvious from those in one line under "Unverified hunches".

| Area | What it examines | How to check |
|---|---|---|
| Business logic | Server rules that do the wrong thing | Read the most-used routes and jobs first |
| Error handling | Swallowed errors, wrong status codes, unlogged failures | Bare `catch {}` blocks; errors returned as 200; 500s for client mistakes |
| Background work | Jobs, cron, queues that fail silently or overlap | Every job type: retries, failure logging, idempotency, time limits |
| Outbound calls | Calls to other services | Timeouts, retries, failure fallbacks, work not handed to `waitUntil` |
| Data access | Queries and storage use | Unbounded reads, missing limits, writes that can half-complete |
| Dead code | Functions, routes and flags nothing uses | Search every way code can be reached (see project.md) before calling it dead |
| Duplication | Code copied instead of reusing an existing helper | Grep for repeated blocks; name the helper to reuse |
| Slow code | Work repeated per request that could be cached or skipped | Hot paths first (catalog routes) |
| Docs vs code | Comments and docs that disagree with the code | Job timings, limits, route lists |
