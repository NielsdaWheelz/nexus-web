# chat alternatives repeat identical prompt labels

status: open
origin: 2026-10-16 chat viewer design audit
area: web / chat / branch navigation

regenerate and rerun copy the original user content and parent into a sibling
pair (`python/nexus/services/chat/admit.py:153-163`). the inline alternative
strip uses only the user's fork title or prompt for its primary label and
adds current/status (`apps/web/src/components/chat/Forks.tsx:17-18,39-66`).
completed alternatives for an unchanged prompt can therefore have identical
titles and status. every option is also rendered as a permanent card in the
transcript (`:34-70`).

impact: the reader sees repeated prompts and cannot identify the desired
answer from those labels. this follows from source; no live regenerated
conversation was created during the audit.

prerequisites: none. preserve the durable tree and present one compact local
alternatives control. its opened chooser should distinguish candidates with
answer preview, model, state and stable local ordering. retain the full forks
outline and named forks. do not infer a new persisted revision type from equal
prompt text.

acceptance: three completed alternatives with the same prompt can be told apart
before opening each answer; current path is explicit; selecting an alternative
preserves the intended reading anchor. the closed control does not render a
card per alternative in the reading flow.
