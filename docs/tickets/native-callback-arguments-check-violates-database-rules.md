# native callback argument invariant belongs at the ledger boundary

status: candidate repaired; qualified artifact pending
origin: 2026-10-02 metadata integration adversarial review
area: native adapter migration

problem: the reviewed candidate `nexus-web-native/migrations/alembic/versions/0254_native_agent.py:87`
added `ck_native_callback_arguments`: `transport_kind <> 'NativeCallback' OR
arguments IS NOT NULL`. this conditional-nullability business invariant conflicts
with `docs/rules/database.md:85–92`. the candidate is unqualified and uncommitted
over `a494f743`; metadata has not installed it.

current evidence: the owner removed the check from the candidate; migration
sha256 is `3539bb4e069877cab931a09b83116b6a50a78f79b15ec425900d6978d46ac08c`.
qualified delivery and installed boundary proof remain pending.

next: verify the qualified adapter retains that removal. `tool_authority.py:340` already
persists the original `{"value": arguments}` wrapper; its replay check and
`native_generation.py:578` validate execution against that original evidence.
reuse those boundaries, including rejected callback replies for invalid raw
arguments. metadata does not edit native migrations or dispatch.

acceptance: qualified adapter migration contains no such check; existing
boundaries reject execution of missing/malformed arguments while retaining
original evidence and legitimate historical rows. combined locked installation
and migration proof pass.
