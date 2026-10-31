# Handoff

- Nuvio collection imports resolve ID-only My Lists sources to existing configured/premade names and URLs by exact catalog ID and media type; other addons and explicitly supplied names are preserved. Linked clean folders refresh this metadata automatically. Catalog IDs remain unchanged.
- Manual pulls and automatic refreshes only import identifiable My Lists-created collections. Previously imported third-party local copies are preserved but cannot be updated through the linked-folder endpoint.
- Nuvio collections writes replace the whole blob without conditional updates; explicit writes warn of the remaining concurrent-write risk. Arbitrary upstream list mutations and automatic two-way sync remain unsupported; no live account verification has been performed.
- Full suite: 2,682 passed, four previously observed account-purge/install-manifest failures, one known TODO.
- Edit numbered split sources and rebuild/check the generated worker as described in AGENTS.md.
