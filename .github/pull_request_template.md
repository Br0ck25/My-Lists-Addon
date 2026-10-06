## What changed and why
<!-- Plain words. What did the owner or a user ask for, and what does this do? -->

## Checklist (every box ticked, or say why not)
- [ ] I edited the numbered source files, not `worker_entry_combined.js`, then ran `python build.py` and `python check_sync.py`.
- [ ] `node --check worker_entry_combined.js` and `node --test tests/*.test.mjs` pass.
- [ ] If I added or removed a function: `python gen_map.py`.
- [ ] If I added a route: it is in `tests/route-access.json` with the right class (`admin`, `account`, `public`, ...), and an admin or account route checks the login.
- [ ] If I changed what a user sees: I followed `AI_UI_RULES.md` and `DESIGN_SYSTEM.md` (existing button/card/modal classes, tokens only, no hex colours), and I attached a screenshot (light, dark, phone width).
- [ ] If a shared component's look changed on purpose: I ran `node tests/ui-contract.mjs --update` and the `tests/ui-contract.json` diff is only what I meant.
- [ ] If I added a new design token or button variant: `DESIGN_SYSTEM.md` is updated in this change.
- [ ] If I changed the database: there is a new numbered file in `migrations/`, and `schema.sql` matches.
- [ ] If the Worker needs a new variable, secret or binding: it is written in `docs/OPERATIONS.md` and `wrangler.toml`'s comments.
- [ ] If this is a release: `WORKER_RELEASE` (`00_constants.js`) is bumped and `docs/RELEASES.md` has its entry.
- [ ] A bug fix has a test that fails without the fix.

## Deploying (owner)
After this merges: paste the new `worker_entry_combined.js`, then check `/admin` shows the same **Release** and **build** value that `python build.py` printed. Keep the previous pasted file until the soak in `docs/DEPLOY_CHECKLIST.md` is over.
