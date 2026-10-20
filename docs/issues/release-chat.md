# release: chat re-slice

status: owed at the next release · area: release / chat

- wire: the chat contract changes (fork rename carries the title it replaces and answers
  it, rerun and regenerate answer the admission receipt, `tool_call_done`, `done.usage`
  and the dead trail fields leave the wire) ride wire revision 13, the first bump after
  the 2026-10-19 release (reader connections). web and api deploy together; the apk and
  the extension ship built at 13, as that bump already requires.
- migration `0300_chat_reslice` (provisional number; renumbered at merge) runs with every
  writer stopped, after the migrations before it. preflight on the newest production
  backup restored on the mac: the six refusal counts in the migration (equivalently
  campaign `chat/census/census.sql` C2-C7 plus `refusals.sql`) must all be 0; any
  nonzero count blocks the release until the owner decides those rows. it is
  irreversible: the pre-release backup is the rollback.
- in flight at deploy: a queued or running run keeps its frozen prompt and finishes on the
  new worker; stored `tool_call_done` frames are deleted and `done` frames lose `usage`
  (replay is unchanged).
- owner smoke after deploy: rename a fork in two tabs (the second is refused and shows
  the current name); stop an answer just as it completes (it stays complete, with its
  sources); regenerate and rerun still make siblings.
