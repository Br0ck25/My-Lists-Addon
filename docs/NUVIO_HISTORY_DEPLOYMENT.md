# Nuvio history and resume deployment

The Nuvio history fix needs the activity database migration `migrations/activity/A0002_watch_event_sources.sql`. Apply it **before deploying the new Worker**, to every activity database shard used by the deployment. For the default production binding, after verifying the configured database name:

```sh
npx wrangler d1 execute mylists-activity --remote --file=./migrations/activity/A0002_watch_event_sources.sql
```

Use the corresponding database and configuration for staging, self-hosted setups, and additional shards. The migration is safe to run more than once. Until it is applied, app-history sync and removal report that A0002 is required rather than advancing the sync cursor without provenance.

Deploy the rebuilt Worker, then use **Sync now** on the correct Nuvio profile. The first Nuvio sync after this update rereads older history so plays already recorded by another source can be linked without duplicating the shared history. Large accounts may continue processing in background jobs.

The integration has not been verified against a live Nuvio account. Unsupported IDs, a different selected profile, upstream limitations, or the 10,000-resume safety limit can still prevent complete coverage. Existing app history is not separated by Nuvio profile when switching profiles.
