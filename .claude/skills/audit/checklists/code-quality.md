# Code-quality audit checklist
Out of scope: security and correctness (other audits cover them).

| Area | What it examines | How to check |
|---|---|---|
| Architecture | Code in the wrong place, tangled responsibilities | Compare the file index with what each file really does |
| Large functions and files | Things too big to change safely | Size test and its baseline; the biggest functions |
| Duplication | Twin functions, copied boilerplate | Grep for repeated blocks and near-identical function bodies |
| Dead code | Unused functions, routes, flags, CSS | Full reachability search (see project.md) |
| Naming and consistency | Same thing called different names | Spot-check key concepts across server and client |
| Technical debt | Workarounds and TODOs that never got finished | `TODO`, `FIXME`, `HACK`, retired features still wired up |
| Dependencies | Tooling and libraries: needed, pinned, maintained | Build and CI tools, versions, unused packages |
| Standards | Project rules from CLAUDE.md actually followed | Each rule against the code |
| Documentation drift | Docs that no longer match the code | ARCHITECTURE, OPERATIONS, file index |
