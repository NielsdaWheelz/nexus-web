# `pr` sensitivity cannot accept a new or repointed vitest proof owner

**Status:** open
**Origin:** Imports workspace cutover, final gates, 2026-09-11
**Area:** `python/nexus_test_control/sensitivity.py` (`workflow_sensitivity_request`, `behavioral_red`), `docs/local-rules/testing-standards.md` §3

## What is wrong

The `pr` workflow's sensitivity capability replays every changed proof owner
against BASE and requires the replay to fail with
`proof_result=behavioral_assertion_failure`. A vitest owner that is new on the
branch, or that now imports a module BASE does not have, fails at module
resolution instead, so `behavioral_red` raises "did not fail at its behavioral
assertion". The standard's escape hatch, `changed_owner_red: coherent-fault`,
is limited to "one exact module-level Python proof"; `_valid_exact_python_owner`
rejects every other runner. So a hard cutover that adds a vitest owner (this one
adds `ImportsWorkspace.browser.test.tsx`, `ImportsPaneBody.browser.test.tsx`,
`NavRail.browser.test.tsx`, and repoints `Nexus.browser.test.tsx`,
`ingestionClient.unit.test.ts`, `DesktopNexusSelection.browser.test.tsx`) cannot
turn `pr` green, although each owner has a registered fault that reddens it at
its pinned fingerprint (`prove --against fault:<id>` passes for all six).

The hosted PR job runs `changed --base`, which has no sensitivity capability, so
the gap is only visible to whoever runs `pr` by hand.

## Evidence

- `test-results/runs/d39bf5b0ab67324c` (`pr` on e4e731d4 against e3c6098e):
  sensitivity fails on the first BASE-routed owner; 27 owners were routed, 19
  coherent-fault, 8 BASE, 6 of them vitest.
- `sensitivity.py:488-540` (`workflow_sensitivity_request`), `:560-575`
  (`_valid_exact_python_owner`), `behavioral_red`.

### reader native hard cut, 2026-09-12

the same changed-non-python BASE restriction also blocks the reader cutover.
`NEXUS_TEST_BASE_SHA=7fa89b88c8342bca9edfb46a6d20053c49555fb2 ./scripts/test pr`
at `faba868779` fails in `f5e5b75ff8fbd0cb` before all normal gate capabilities.
the selected `OfflineReadingSharedContractTest.kt` compiles, then current
reader2 fixtures reach the base reader1 verifier's
`UnsupportedOfflineReadingPackageException` at `verifyAssembled:251` before
the source-path assertion. the host portfolio reports 185 tests, 3 failures;
the companion store test also hits an unsupported-state cast at line 940.
these are not behavioral reds and must not be reclassified as assertions.
retained evidence is the summary's sensitivity capability and its referenced
`sensitivity/e939e8b941339594/red/1-android-host-1.log/android-host-1.log`.

candidate product-only native faults already demonstrate the actual contracts:
literal paths `2cb243a45b4aeeb2`; pending-progress preservation on final assets
`c5fae5708c454ef1`. the owner must also define coherent native hard-cut routing;
keeping reader1 fixtures/decoders or weakening assertions is not an acceptable
repair. no native, browser or repository gate waiver is claimed.

## Prerequisites

None.

## Proposed fix

Let a fault-owned vitest exact owner opt into coherent-fault the way a Python one
does: pin the owner file's SHA-256 (vitest has no statement-slice owner, so the
whole file is the owner) and route the red through the registered fault. Amend
testing-standards §3 to say so, or state explicitly that `pr` is Python-only for
sensitivity and that the fault sweep is the vitest witness.

## Acceptance

`pr` on a branch that adds one fault-owned vitest owner passes its sensitivity
capability through the fault, and the standard names the mechanism.
