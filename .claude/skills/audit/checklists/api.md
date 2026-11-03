# API and integration audit checklist
Real external services are not called from the audit (network stubbed or
recorded responses only), unless the owner says otherwise.

**Not in this audit:** who may call our own routes (security audit); what users see when a call fails (frontend).

| Area | What it examines | How to check |
|---|---|---|
| API Contract | Incorrect request/response structures | Responses the Stremio/Nuvio/Wako apps and the web page expect vs what routes return; status codes and error shapes |
| Compatibility | Changes that break existing integrations | Old addon URLs, old manifest fields and old client versions still accepted? |
| Data Mapping | Incorrect conversion between external and internal data | TMDB/Trakt/MDBList/Simkl/etc. fields to internal ones: missing fields, IDs of the wrong type, movie vs series mix-ups |
| Integration Reliability | External services failing or changing | What each integration does when the service is down, slow, returns junk, or changes shape |
| Incoming webhooks | Calls other services make to us (media servers, payments, email) | Token checks, body size limits, duplicate and replayed events, junk or out-of-order events |
| Timeout Handling | Requests that hang indefinitely | Every outbound `fetch`: is there a timeout? |
| Retry Logic | Whether failed requests recover properly | Which calls retry, how often, with backoff, and are retries safe (no double writes)? |
| Rate Limiting | API limits and request handling | Our limits on callers, and how we stay within other services' limits (429 handling, caching) |
