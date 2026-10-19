# the chat prompt layout change is unmeasured on a real model

status: open · origin: 2026-10-10 chat runs rewrite (design R1, B11) · area: chat prompt

the rewrite moved the turn's context (quote `<subject>` and `<reader_selection>`,
a fork's `<assistant_selection>`, the chat's `<resources>`) from the
system/developer instructions to the head of the user input; the instructions are
now the fixed system prompt alone (`services/chat/context.py`). this fixes the
over-long-prompt 500 (D2) at its cause and keeps untrusted resource text out of
the instruction channel, but it may change answer style or citation discipline on
real models. the harness's fake model cannot measure that: C9, C17, C33 and C36
prove only the layout and that citations publish.

prerequisites: the release with migration 0271 is deployed.

what to do: the owner's post-deploy smoke on gpt-6-sol: one quote turn (Ask from a
reader selection) and one resource chat ("Chat about this…" with a question that
needs the resource), each answer citing its source.

acceptance: both answers cite their sources and the citations open them; if not,
revert the layout in `context.assemble` (put the context blocks back into the
instructions with a 32 KiB guard) and reopen D2 as a rejection.
