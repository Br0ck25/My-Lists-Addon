# Repository protection: what is automatic, and the GitHub settings only the owner can turn on

Rules in documents are not enough: people and AI assistants forget them. Everything below is either **enforced by a check** that fails the change, or **a setting** in GitHub that only the repository owner can change.

## Enforced by checks (nothing to do)

| What | Where it runs | What it stops |
|---|---|---|
| `check_sync.py`, CI "Rebuild and fail on drift" | pre-commit hook, CI | a Worker that does not match its sources |
| `scope_check.mjs` | CI | names that do not exist in the shared scope |
| `render_check.js` + `html_checks.py` (page, admin, hostile input, service worker) | CI | broken or injectable pages |
| `tests/design-system.test.mjs` | pre-commit hook, CI | token, breakpoint, hex-colour, contrast, add-button drift |
| `tests/route-access.test.mjs` + `tests/route-access.json` | pre-commit hook, CI | a route nobody classified; an admin or account route that answers an anonymous caller |
| `tests/build-stamp.test.mjs` | pre-commit hook, CI | losing the build stamp that proves which file is live |
| `tests/ui-contract.mjs` + `tests/ui-contract.json` (CI job **ui-contract**) | CI | a button, tab or input that changes size, padding, radius, font or colour (light, dark, phone, desktop) without the contract being updated on purpose |
| `check_bundle_budget.mjs`, `gen_map.py` freshness | CI | a slow first page; a stale function map |
| the full test suite, run twice (plain and `MLA_TEST_V2_LISTS_READ=1`) | CI | behaviour regressions |

Turn the pre-commit hook on once in each clone: `git config core.hooksPath .githooks`.

Changing how a shared component looks on purpose: edit the CSS, update `DESIGN_SYSTEM.md`, run `node tests/ui-contract.mjs --update` (needs `npm install --no-save playwright@1.56.1`), and look at the `tests/ui-contract.json` diff before committing: that diff is the review.

## GitHub settings to turn on (owner only, about 5 minutes)

GitHub, repository **Settings -> Branches -> Add branch ruleset** (or classic branch protection) for `main`:

1. **Require a pull request before merging.** Leave "required approvals" at **0**. You are the only reviewer, and AI sessions push under your account, so an approval requirement would only block you. The pull request is what gives CI a chance to run first.
2. **Require status checks to pass**, and add the checks named **test** and **ui-contract** (the jobs in `.github/workflows/ci.yml`). Tick "Require branches to be up to date".
3. **Block force pushes** and **block deletions** of `main`.
4. Do **not** tick "Require review from Code Owners" unless a second person with write access joins: nobody can approve their own pull request, so it would lock you out. `.github/CODEOWNERS` still documents who owns what and starts applying the day a second reviewer exists.
5. **Settings -> Actions -> General -> Workflow permissions:** set to **Read repository contents** (CI already asks for no more).
6. **Settings -> Code security:** turn on **Secret scanning** and **Push protection**, and **Dependabot alerts**.
7. **Delete old branches** that are merged or abandoned (the `arena/*`, `claude/*`, `audit/*` ones). Nothing in them is needed once their pull request is merged.

## Secrets: one thing to confirm

`.gitignore` records that a full account backup, `my-lists-full-backup1.json`, was once committed with live Trakt, MDBList and Simkl tokens and an Account Key in it. That was before the history of this repository (a search of every commit here, 288 of them, finds no such file or token). If that file lived in the older public repository (`Br0ck25/My-Lists`), the tokens are still readable there, so: confirm they were revoked or rotated, and that the file was removed from that repository's history.
