# Guard the isolation marker in the two remaining whole-file Chat owners

**Status:** open
**Origin:** PR #203 takeover, 2026-09-06 (BASE-coherence pass)
**Area:** `python/tests/service/test_chat_codex_execution.py`,
`python/tests/service/test_chat_run_candidates.py`

## Summary

Both files carry a module-level
`pytestmark = pytest.mark.usefixtures("committed_chat_state_isolation")`
(`test_chat_codex_execution.py:76`, `test_chat_run_candidates.py:23`). That
fixture is defined in the candidate's `python/tests/service/conftest.py`,
which the controller's BASE method does not overlay onto the base checkout
(`nexus_test_control/sensitivity.py::_base_overlays()` copies the proof path,
`testdata`, `docker/docker-compose.test.yml`, `python/tests/conftest.py`,
`python/tests/testkit`, and `python/nexus_test_control/provider_api_contract.py`
only). On BASE, pytest therefore reports `fixture 'committed_chat_state_isolation'
not found` before any test body runs, which the controller classifies as
`setup_or_execution_failure` and rejects.

Neither file is sensitivity-gated today (both are whole-file owners without an
exact node or fault), so the gate is unaffected. The moment either registers an
exact canonical node it will fail exactly the way
`test_generation_chat_api.py::test_exact_selection_and_authority_cross_every_chat_projection`
did on 2026-09-06.

## Fix (already applied to `test_generation_chat_api.py`)

```python
# Keep it out of the BASE fixture closure so every node still reaches its
# `_CUTOVER_PRESENT` assertion instead of erroring on a missing fixture.
pytestmark = [pytest.mark.usefixtures("committed_chat_state_isolation")] if _CUTOVER_PRESENT else []
```
(`python/tests/service/test_generation_chat_api.py:49-51`)

Do not convert the nodes to `request.getfixturevalue("committed_chat_state_isolation")`
inside the body when they also take `db_session`/`authenticated_client` in the
signature: that reorders teardown so the isolation fixture's committed DELETEs
run before `db_session` teardown and can contend with an open transaction.

Apply the same guard, confirm each file collects on a BASE checkout at
`origin/main` with the candidate file overlaid (`pytest --collect-only -q` and
`pytest --setup-plan`), and confirm the first statement of each node is its
`assert _CUTOVER_PRESENT` guard.

## Acceptance

- Both files collect and plan on BASE with the overlay.
- Candidate behavior unchanged (`./scripts/test changed <file>` passes).

## References

- `python/tests/service/test_generation_chat_api.py` (the applied pattern).
- Spec section 9 RED (BASE must reach a behavioral assertion).
