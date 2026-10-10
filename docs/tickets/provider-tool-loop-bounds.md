# provider tool-loop bounds were chosen without evidence

status: open · origin: 2026-10-10 generation rewrite (design D3/R4) · area: generation / provider runtime

a provider generation was unbounded before the rewrite (`max_turns=None`, a
per-turn deadline only). it now stops at `PROVIDER_MAX_TURNS = 24` turns
(`output_limit`) and at its operation timeout, 900 s for chat, for the whole
generation (`python/nexus/services/generation/policy.py`). neither number comes
from observed tool loops; a legitimately long loop fails instead of finishing.

prerequisite: turn counts and durations of real provider chat loops
(`llm_calls.terminal->'evidence'->>'turns'`, `created_at`/`completed_at`).

proposed fix: set both bounds from the observed distribution with headroom, or
make the chat failure card name the limit so the user can split the task.

acceptance: the bounds cite measured loops, and no normal chat hits them.
