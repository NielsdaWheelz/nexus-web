# background generation context budget is not enforced

- status: open
- origin: 2026-09-14 original-publication hard-cutover adversarial review
- area: generation policy and execution

evidence: `python/nexus/services/generation_service.py:438-441` freezes
`effective_context_budget_tokens`, but `provider_generation_backend.py` passes
only the output-token budget. searching `python/nexus` and `apps/codex_agent`
for `effective_context_budget_tokens` finds no background input admission;
chat consumes it in `services/chat_runs.py:546`. the pinned runtime at
`8fde23a` has model context metadata, not a corresponding application budget
parameter. this is static inspection, not a measured overflow.

prerequisite: decide whether the policy number is an enforced input limit or
advisory metadata. proposed fix: make the generation owner enforce the intended
contract or stop presenting the number as enforced. tool byte reservations
alone do not establish an equivalent token ceiling. no metadata-specific
budget framework belongs in the publication-date change.

acceptance: an oversized background context receives the documented bounded
outcome at its actual enforcement boundary; displayed policy matches behavior.
