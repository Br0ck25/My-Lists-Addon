# Performance audit checklist
Earlier work and budgets: `docs/PERFORMANCE.md`.

**Not in this audit:** missing indexes and query plans (database audit); bugs found in slow code (bugs).
**Cannot be checked from a cloud session** (list under "Not covered"): real production traffic and latency. Use the in-process benchmarks and say the numbers come from a shared machine.

| Area | What it examines | How to check |
|---|---|---|
| Hot paths | The busiest routes (catalogs) | Measure with the in-process benchmarks; count queries and fetches per request |
| Database access | Queries per request, N+1 queries, unbounded reads | Count queries per request on hot paths; reads with no limit. Index review belongs to the database audit |
| Caching | Cache hits, cache keys, what is never cached | Cache keys, TTLs, and work done on every miss |
| Outbound requests | Too many, sequential when they could be parallel | Calls per request; batching |
| Payload size | Large responses and page bundles | Bundle budget test; response sizes for typical accounts |
| CPU work | Heavy loops, regexes, JSON on every request | Profile the slowest benchmark |
| Frontend rendering | Slow first paint, re-rendering everything | Playwright timing on the main pages |
| Background jobs | Jobs that grow with user count | What each cron run does as data grows |
| Scalability | What breaks first at 10x users | Platform limits (CPU time, subrequests, KV writes, D1 size) |
