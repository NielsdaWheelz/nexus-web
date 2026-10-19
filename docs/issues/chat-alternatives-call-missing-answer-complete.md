# a user-only alternative is presented as a complete response

status: open
origin: 2026-10-16 chat viewer specification review
area: chat / alternative presentation

`apps/web/src/lib/chat/tree.ts:175-185` derives alternative status from
`answer?.status ?? user.status`. `components/chat/Forks.tsx:66,189` displays
that value. deleting an assistant subtree can leave its complete user parent
as a valid leaf (`python/nexus/services/chat/conversations.py:212-267`), so an
alternative without an answer is labeled complete. source evidence only.

impact: the chooser reports a completed answer where none exists.

fix: retain the immediate answer in the derived alternative and render its
actual state; absent answer means `no response`. share the rule with the
inspector outline. do not invent a stored response or copy the user's status.

acceptance: a disposable user-only leaf reads `no response` in both surfaces;
failed/cancelled partial answers remain distinct from complete answers.
