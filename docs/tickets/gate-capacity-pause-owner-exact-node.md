# Register an exact canonical node for the capacity-pause proof owner

**Status:** open
**Origin:** PR #203 takeover, 2026-09-06 (acceptance audit finding PP-2 and the
BASE-coherence pass)
**Area:** test control plane, `testdata/proofs.json`, spec section 9

## Summary

`python/tests/service/test_generation_capacity_pause.py` is registered in
`testdata/proofs.json` as a whole-file proof owner with no exact canonical
node. The controller gates a changed owner with BASE sensitivity only when its
canonical registered owner is one exact node or carries a registered fault
(`nexus_test_control/cli.py::_canonical_selection` computes
`sensitivity_required = canonical_proof(p) != p or declared_fault_for_proof(...)
is not None`). A whole-file owner with neither resolves to itself, so `pr`
never produces a red/green pair for it.

Until 2026-09-06 the file could not be gated anyway: its module-level
`_SHIPPED_DAWN_SELECTION = CodexPersonalSelection(...)` and the `_runtime`
default argument `generation_policy.GENERATION_POLICY` evaluated cutover names
outside the `_CUTOVER_PRESENT` guard, so BASE failed at collection with a
`NameError`, which the controller rejects as `setup_or_execution_failure`.
Commit "Reach the base assertion before candidate imports in the gated
generation proof owners" hoisted both into the guard (`_shipped_dawn_selection()`
is built lazily; `policy` defaults to `None` and resolves in the body). Every
node in the file now opens with `assert _CUTOVER_PRESENT, "..."`, so BASE
collection is clean and the first failure is behavioral. The only remaining
gate condition is registration.

## What to do

1. Pick the canonical node. The file has three:
   `test_background_admission_persists_exact_capacity_pause_and_ready_clears_it`
   (exact durable `CapacityPaused`, ready admission clears it),
   `test_capacity_pause_reschedule_preserves_retry_budget`, and
   `test_rebuild_admission_reads_current_policy_and_never_alters_frozen_work`.
   The first is the section 9 "Background capacity admission" row's primary
   scenario and the natural canonical node; the other two stay routed through
   the whole-file entry.
2. Add the exact node beside the whole-file entry in the owning priority risk
   (the repository pattern used for `test_generation_catalog.py`,
   `test_generation_backend_runtime.py`, and `test_generation_chat_api.py`).
   Policy forbids a second exact node per path (`proof-sensitivity-owner`), so
   exactly one node becomes canonical; sibling nodes stay priority-routed
   through the whole-file entry.
3. Recompute `PRIORITY_RISK_OWNERSHIP_SHA256` in
   `python/nexus_test_control/model.py` with the formula `policy.py` enforces
   (`sha256(json.dumps({id: {field: sorted(...)}}, sort_keys=True,
   separators=(",",":")))` over `source_globs`, `proofs`, `capabilities`).
   `TEST_ROUTING_SHA256` does not change.
4. Update the spec: section 9 RED currently lists this file among the owners
   that are not sensitivity-gated ("a whole-file owner with no exact canonical
   node; its nodes reach their base assertion, so registering one canonical
   node would gate it"). Remove it from that list and name the node in the
   "Background capacity admission" row.
5. Run `./scripts/test pr` with `NEXUS_TEST_BASE_SHA` set to `main` and confirm
   the new node appears in the sensitivity entries with method `base`.

## Acceptance

- `./scripts/test changed --base origin/main` policy capability passes with
  the new digest.
- The node is listed under `sensitivity` in a `pr` summary with method `base`
  and the run passes.
- Section 9 no longer names the file as ungated.

## References

- Spec: `docs/cutovers/generation-backends-hard-cutover.md`, section 9 RED and
  section 11 (whole-file owner trade-off).
- Controller: `python/nexus_test_control/selection.py` (canonical resolution),
  `python/nexus_test_control/policy.py` (`proof-sensitivity-owner`,
  `fault-canonical-proof`, digest formula).
