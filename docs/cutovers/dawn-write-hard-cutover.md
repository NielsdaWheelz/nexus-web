# Dawn Write

**Status:** implemented product contract

**Generation authority:**
[`codex-personal-generation-hard-cutover.md`](codex-personal-generation-hard-cutover.md)

## Product behavior

At the first hourly sweep after midnight in a user's recorded time zone, Nexus
may publish one current Dawn write above that day's editable note. The write is
grounded only in the user's previous-day highlights, overnight Synapse
resonances, and stale library dossiers. It is short, non-interactive, and can be
dismissed without changing the daily note.

No signals means no Dawn write and no generation. A completed write is unique
per `(user_id, local_date)`; replay republishes the same durable result and does
not create a second generation.

## Generation composition

- Canonical operation: `dawn_write`.
- Fixed plan: `standard` (`gpt-5.6-terra`, `medium`).
- Capability: `Synthesis`; no model tools, MCP, web search, shell, or caller
  override.
- Turn bound: 180 seconds. The population sweep owns a 900-second job lease;
  the bound applies to one user's generation.
- Nexus selects and freezes the evidence, renders the prompt, validates the
  bounded text, and owns publication.
- The shared generation service owns the private UDS dispatch, one `llm_calls`
  row, capacity rescheduling, and `Prepared | Uncertain | Completed` replay.
- `Uncertain` work is never automatically redispatched. The operator must use
  the shared reconciliation contract.
- No database transaction spans generation I/O. The generation terminal and
  journal completion commit before `dawn_writes` publication.

## Data and UI

`dawn_writes` owns the generated Markdown, generation time, local date, and
dismissal state. The API exposes the current write and an idempotent dismiss
action. The daily surface renders it as a separate machine-text artifact above
the note; it is not part of the note document.

## Acceptance

- Time-zone scheduling selects each user at most once per local day.
- Empty evidence performs no generation and writes no Dawn artifact.
- Prompt input contains only admitted, user-owned evidence.
- Publication occurs only after a durably recorded terminal.
- Replay and concurrent sweeps converge on one artifact and one generation.
- Dismissal is permanent for that artifact and never mutates the note.
- The representative real-PostgreSQL Dawn proof establishes transaction
  ownership, terminal-before-publication, and replay behavior.

Detailed generation policy, failure algebra, reconciliation, host security,
and live qualification rules live only in the generation authority linked
above.
