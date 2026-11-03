# Bug and logic audit checklist

| Area | What it examines | How to check |
|---|---|---|
| Crashes and error handling | Requests or pages that throw instead of failing politely | Fuzz every route with `null`, `[]`, `"x"`, `5`, `{}`, wrong types and invalid JSON, signed in and out; list every 5xx. Unguarded `JSON.parse`, property reads on possibly-null values |
| Logic and calculations | Wrong results, wrong sorting/filtering, off-by-one | Read the business rules behind the most-used features; compare to tests and docs |
| Edge cases and boundaries | Empty lists, huge lists, missing fields, unicode, limits | Hand-test limits and empties with a script against the built app |
| Time and dates | Time zones, DST, "N days ago", expiry | Every date calculation; anything assuming a fixed offset or 24-hour days |
| Races and lost updates | Read-modify-write without a guard, overlapping jobs | Shared records changed by more than one request or job; timers that can overlap |
| Duplicate processing | The same job, payment, or event handled twice | Retries, queue redelivery, double clicks, webhooks sent twice |
| Leaks | Caches, maps, timers or listeners that grow forever | Module-level maps without a cap; listeners added on every render |
| State consistency | Two copies of the same data that drift apart | Client vs server copies, caches vs source tables |
| Regressions | Features that used to work and broke | Recent `docs/RELEASES.md` entries and `git log`; check each recent change's edge cases |
