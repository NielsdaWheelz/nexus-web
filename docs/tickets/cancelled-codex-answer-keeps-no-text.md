# a cancelled codex answer keeps no text

status: open · origin: 2026-10-04 chat rewrite (design L8) · area: chat / generation

Stopping a Codex chat run saves the assistant message with empty content. The
live overlay showed partial text; the terminal read replaces it with the saved
answer, so the user sees only "Cancelled — This response was cancelled." and
Rerun. Provider-API runs keep their partial text.

impact: the partial answer the user was reading disappears on Stop.
evidence: harness C5 (baseline and rewrite) records "saved partial 0 chars"
after a cancelled Codex run; `docs/modules/chat.md` assumption 10 no longer
promises partial text on Codex.

resolved when: the Codex cancel path persists the text the run had produced
(or the owner decides it should not), and C5 shows the saved partial equal to
what was streamed before Stop.
