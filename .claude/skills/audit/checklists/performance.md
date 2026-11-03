# Performance audit checklist
Earlier work and budgets: `docs/PERFORMANCE.md`.

| Area | What it examines | How to check |
|---|---|---|
| Hot paths | The busiest routes (catalogs) | Measure with the in-process benchmarks; count queries and fetches per request |
| Database access | N+1 queries, missing indexes, unbounded reads | Each query on a hot path against the schema's indexes (`EXPLAIN QUERY PLAN` in a local SQLite copy) |
| Caching | Cache hits, cache keys, what is never cached | Cache keys, TTLs, and work done on every miss |
| Outbound requests | Too many, sequential when they could be parallel | Calls per request; batching |
| Payload size | Large responses and page bundles | Bundle budget test; response sizes for typical accounts |
| CPU work | Heavy loops, regexes, JSON on every request | Profile the slowest benchmark |
| Frontend rendering | Slow first paint, re-rendering everything | Playwright timing on the main pages |
| Background jobs | Jobs that grow with user count | What each cron run does as data grows |
| Scalability | What breaks first at 10x users | Platform limits (CPU time, subrequests, KV writes, D1 size) |
