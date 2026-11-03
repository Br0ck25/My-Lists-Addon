# Security audit checklist
Work in this order. For each area, also note what you checked and found fine.

**Not in this audit:** crashes and logic bugs (bugs audit); timeouts and retries (api); backups (database); how deploys and CI work (deployment). This audit covers only the security side of each.
**Cannot be checked from a cloud session** (list under "Not covered"): the Cloudflare dashboard, production data and secret values. Turn those into a checklist for the owner under Infrastructure Security.

| Area | What it examines | How to check |
|---|---|---|
| Authentication | Login, registration, sessions, token handling | Trace every sign-in path end to end; token generation, expiry, renewal, revocation, cookie flags; brute-force limits |
| Authorization | Whether users can access resources they shouldn't | For every route in the route list: who may call it, and does the handler check that the resource belongs to the caller (not just that someone is signed in)? Try another account's IDs |
| API Security | Endpoint exposure, validation, abuse prevention | Unlisted or debug routes, body size limits, rate limits on expensive or anonymous routes, CORS, CSRF on state-changing requests |
| Input Validation | SQL injection, XSS, malicious input | Every query built with string concatenation; every place user text reaches HTML (server templates and client `innerHTML`); URL/redirect parameters; outbound fetches built from user input (SSRF) |
| Data Security | Sensitive information, encryption, storage | What is stored in plaintext that should be hashed or encrypted; what a stolen database or KV copy would reveal; what error messages and API responses leak |
| Third-party connections | Sign-ins the site keeps for other services | Tokens for Trakt, MDBList, Simkl, Nuvio and media servers: how they are obtained, stored (encrypted?), refreshed, revoked, and deleted with the account; what each allows; what a stolen one exposes |
| Secrets Audit | Exposed API keys, credentials, tokens | `git grep` for key-shaped strings, `.env`-like files, secrets in docs, tests, logs and client code; secrets sent to the browser. Never copy a value into the report |
| Browser storage | What the page keeps in the browser | Every localStorage, sessionStorage and cookie key: anything secret or personal, how long it stays, what the next person on a shared computer could see or use |
| Dependency Security | Vulnerable libraries and packages | List every dependency and where it is used; `npm audit` if a lockfile exists; pinned versions in CI and build tools; scripts loaded from CDNs (SRI) |
| Privacy Audit | Unnecessary collection, exposure, or retention of data | What personal data is collected, why, how long it is kept, whether account deletion really removes it everywhere, what analytics and logs record |
| Infrastructure Security | Server, database, storage, and deployment security | Platform config, security headers/CSP, CI permissions and secrets use, who can deploy, public buckets, backups' protection. Owner-only settings go in a checklist for the owner |
