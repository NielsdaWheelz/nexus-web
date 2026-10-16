status: open
origin: 2026-10-16 chat controls capability qualification
area: provider-runtime dependencies

the upstream `llm-calling` dependency audit reports locked `mcp==1.29.0`
against `CVE-2026-59951`, with fixes reported as `1.30.0` or `2.2.0`.
the dependency predates the chat controls change; this prevents claiming a
clean upstream audit despite passing source, typing and runtime checks.
evidence: `pip-audit` in the isolated upstream capability checkout; unchanged
upstream dependency lock. no exploit assessment was performed.

the upstream dependency owner should review the advisory, update the affected
cohort and qualify the native adapter. acceptance: the locked upstream audit
passes and nexus consumes the reviewed replacement pin.
