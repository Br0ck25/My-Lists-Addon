# Deployment and infrastructure audit checklist
Production, the Cloudflare dashboard and secret values are not reachable from
a cloud session. Check the repo's config and workflows, and turn anything that
needs the dashboard into a short checklist for the owner.

| Area | What it examines | How to check |
|---|---|---|
| Deployment Safety | Failed deployments and rollback capabilities | How a deploy happens, what checks run first, staging, and how to roll back (written down? tried?) |
| Disaster Recovery | Recovery after infrastructure failures | If D1, KV or R2 data is lost or the account is locked: what restores it, and how long it takes |
| Build System | Broken or unreliable builds | Run the build twice from clean; same output? Build tools pinned? |
| CI/CD | Automated deployment and validation | Each workflow: triggers, permissions, secrets use, pinned action versions, failures that are ignored |
| Environment Configuration | Incorrect development/production settings | `wrangler.toml` vs self-host config vs docs: bindings, compatibility date, routes, cron |
| Configuration | Incorrect or duplicated configuration | Same setting defined in several places; defaults that differ |
| Monitoring | Missing logging and error reporting | Would the owner find out about a broken cron, failing backup, or error spike? How? |
| Logging | Missing, excessive, or sensitive logs | Errors with no log line; logs containing keys, tokens, emails or IPs |
