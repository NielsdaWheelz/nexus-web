# The coherent-fault owner digest omits the imports and support modules the standard says it pins

**Status:** open
**Origin:** Imports workspace cutover, Phase 9 review, 2026-09-10
**Area:** `python/nexus_test_control/proof_owner.py`, `python/nexus_test_control/policy.py`, `docs/local-rules/testing-standards.md` §3

## What is wrong

`docs/local-rules/testing-standards.md` §3 says the manifest "MUST also pin the
SHA-256 of version-stable source slices for that exact test plus its imports and
non-test module support" for a `changed_owner_red: coherent-fault` proof.
`python_exact_proof_owner_sha256` hashes only statement slices of the owner test
file itself. Phase 9 strengthened
`python/tests/testkit/background_process_containment_probe.py` (the executable
target and forbidden-module list that `test_background_worker_process_containment.py`
imports) and the pin for `document-import-time-dimension-bypass` did not drift, so
the explicit review the standard mandates never engaged.

## Evidence

- `python/nexus_test_control/proof_owner.py:18-45` (`python_exact_proof_owner`,
  `python_exact_proof_owner_sha256`): the source argument is the owner test file only.
- `python/nexus_test_control/policy.py:1947-1951`: the pin is compared against that
  single-file digest.
- Phase 9: `_FORBIDDEN_MODULE_NAMES` gained two names in the probe; the manifest's
  `changed_owner_sha256` for the fault stayed valid.

## Prerequisites

None.

## Proposed fix

Either extend the digest to the owner's test-local imports and `tests/testkit`
support modules it names (the standard's wording), or narrow the standard's
sentence to what the implementation pins. Whichever is chosen, a kernel case
must show a support-module edit producing owner drift (or the standard must stop
claiming it does).

## Acceptance

Editing a `tests/testkit` module imported by a coherent-fault owner either fails
policy with owner drift, or the standard no longer says it will.
