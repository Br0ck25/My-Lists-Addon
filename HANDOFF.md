# Handoff

- Nuvio collection folders can be pulled into the Collections editor and explicitly updated in their original parent. Local edits are preserved on pull, and stale remote folder snapshots are rejected. Nuvio's whole-blob write has a remaining race with concurrent remote writes; the UI warns before updating.
- Provider catalog references are not title lists. Arbitrary upstream provider list mutations and automatic two-way synchronization are not implemented; Stremio's arbitrary-list write API remains unverified. No live account verification has been performed.
- Focused collection/provider/design tests passed. Full suite: 2,678 passed, four failures in account purge and install-manifest assertions (unexpected catalog rows), one known TODO; these also appeared before this change.
- Edit numbered split sources and rebuild/check the generated worker as described in AGENTS.md.
