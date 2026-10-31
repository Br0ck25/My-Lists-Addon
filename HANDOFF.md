# Handoff

- Nuvio manual pulls and automatic folder refreshes only import identifiable My Lists-created collection IDs (`my-lists-collections`, `my-lists-addon`, and `col_mylists_…`). Titles and addon catalog references are not treated as proof of ownership. Previously imported third-party local copies are preserved but cannot be updated through the linked-folder endpoint.
- Nuvio collections writes still replace the whole blob without conditional updates. Explicit writes warn of the remaining concurrent-write risk. Arbitrary upstream provider list mutations and automatic two-way sync remain unsupported; no live account verification has been performed.
- Focused tests pass. Full suite: 2,680 passed, four previously observed account-purge/install-manifest failures, one known TODO.
- Edit numbered split sources and rebuild/check the generated worker as described in AGENTS.md.
