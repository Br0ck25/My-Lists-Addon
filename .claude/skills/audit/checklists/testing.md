# Testing audit checklist
A project having 2,000 passing tests doesn't necessarily mean it's reliable.
Tests can pass while testing the wrong things. Prove test strength with
experiments in a scratch copy, never by editing the working tree.

**Not in this audit:** the bugs themselves (bugs audit). A bug noticed here goes under "Unverified hunches" with a note.

| Area | What it examines | How to check |
|---|---|---|
| Test Coverage | Which areas have tests and which don't | Map test files to source files and routes; list routes, jobs and features no test touches |
| Test Quality | Whether tests actually verify meaningful behavior | Read assertions on the most important features: do they check results, or only "no error" / status 200 / that a string appears? |
| Missing Tests | Critical functionality without coverage | Sign-in, saving lists, catalogs, sync, account deletion, payments, admin access: name the untested ones |
| Regression Testing | Whether previously working functionality stays working | Do fixed bugs in earlier audits and RELEASES have a test that fails if the fix is reverted? Revert a few fixes in a scratch copy and run their tests |
| Integration Testing | Whether components work together | Tests that run the built Worker with storage and jobs together, vs. tests of single functions |
| End-to-End Testing | Whether complete user workflows work | Is there any browser test of a whole workflow? Try the main workflows with Playwright and note gaps |
| Test Reliability | Flaky, inconsistent, or environment-dependent tests | Run the suite 2-3 times; look for timing budgets, real network, dates, random data, shared state between tests |
| Test fakes | Whether stubs and fake services behave like the real thing | Read the test harnesses and fake services: do they accept anything (any element ID, any request) so a test can pass while checking nothing? Compare fake responses with the real service's shape |
| Always-failing tests | Tests that are red so often that everyone ignores red | Any test that fails on every run or is listed as a known failure: does it still guard anything, and how could it be made reliable without loosening it? |
| CI/CD Testing | Whether automated checks reliably catch problems | Does CI run the same checks as `verify.sh`? Can a failing check be merged or deployed anyway? Do scheduled checks alert anyone? |

Mutation spot-check (strongly recommended): in a scratch copy, break 5-10
important lines (flip a condition, drop an ownership check, return early) and
run the related tests. Every break no test catches is evidence for a finding.
