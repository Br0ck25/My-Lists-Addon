# Handoff

- Nuvio collection folders can be manually pulled and edited; linked folders refresh automatically every two minutes while Lists → Collections is open, without replacing local edits or importing new folders. Updates to Nuvio remain explicit, with stale-folder checking and a warning about whole-blob writes. Links are scoped to the My Lists and Nuvio accounts; folders pulled before account scoping must be pulled again to create a new link, and their old local copies remain intact.
- Nuvio's documented API has only full-replacement collections writes, without conditional updates, so a concurrent remote write can still be lost. Arbitrary addon catalog references are not writable title lists; automatic two-way sync and arbitrary upstream list mutations remain unsupported. No live account verification has been performed.
- Focused tests passed. Full suite: 2,679 passed, four previously observed failures in account-purge and install-manifest assertions (unexpected catalog rows), one known TODO.
- Edit numbered split sources and rebuild/check the generated worker as described in AGENTS.md.
