# Deployment and infrastructure audit checklist
Production, the Cloudflare dashboard and secret values are not reachable from
a cloud session. Check the repo's config and workflows, and turn anything that
needs the dashboard into a short checklist for the owner.

**Not in this audit:** security of headers and secrets (security audit); what the data backups contain and how to restore them (database). This audit covers rebuilding the platform itself.

| Area | What it examines | How to check |
|---|---|---|
| Deployment Safety | Failed deployments and rollback capabilities | How a deploy happens, what checks run first, staging, and how to roll back (written down? tried?) |
| Disaster Recovery | Recovery after infrastructure failures | If the Worker, a binding or the Cloudflare account is lost or locked: how is it rebuilt, from what, and how long it takes |
| Build System | Broken or unreliable builds | Run the build twice from clean; same output? Build tools pinned? |
| CI/CD | Automated deployment and validation | Each workflow: triggers, permissions, secrets use, pinned action versions, failures that are ignored |
| Environment Configuration | Incorrect development/production settings | `wrangler.toml` vs self-host config vs docs: bindings, compatibility date, routes, cron |
| Settings drift | Settings that differ between the repo and the dashboard | Variable and secret names (never values), bindings, cron and routes in the config files vs what the docs say the dashboard holds |
| Configuration | Incorrect or duplicated configuration | Same setting defined in several places; defaults that differ |
| Costs and limits | Platform plan limits and bills | Requests, CPU time, KV/D1/R2 operations and storage against the plan; what happens at the limit; any usage alerts |
| Monitoring | Missing logging and error reporting | Would the owner find out about a broken cron, failing backup, or error spike? How? |
| Logging | Missing, excessive, or sensitive logs | Errors with no log line; logs containing keys, tokens, emails or IPs |
