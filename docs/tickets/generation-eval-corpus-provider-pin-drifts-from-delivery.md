# generation eval corpus provider pin differs from delivery

- status: open; exact dependency identities reconciled, replay pending
- origin: 2026-09-14, bounded workspace merge audit at delivery `8c0ab400`
- area: generation eval fixtures and dependency identity

The delivery's `python/pyproject.toml` pins provider-runtime
`9abaf6b7a1f907fcf1bdbfa33dd7b343e42ffbdb`, but both
`python/tests/evals/cases/generation_plans.v2.json` and `tool_safety.v4.json`
still declare `8fde23ac56571a63c65cfcff55c73a0976f83eb4`.
This mismatch already exists in delivery HEAD; it is not introduced by the
compatibility rollback reconstruction. The kernel dependency is also retained
at delivery's `fd2d71d8608692babbc4144ca77f65ec34f454a9`.

the two corpus pins now match the retained dependency. independent source review
found only lazy provider-http adapter loading in the provider delta; agent runtime,
model catalog and tool adapter bytes are unchanged. all cases, policy facts and
refusal baselines remain exact. this identity repair does not qualify execution.

Preserve the delivery dependencies. Review the corpus's declared provider
contract against those exact installed bytes before changing its identity;
retain all policy/tool authority facts and independent refusal oracles.

Done when the corpus declares the actual qualified dependency and its existing
ordinary/sensitivity owners run against that composition. Updating a string
alone is not execution evidence.
