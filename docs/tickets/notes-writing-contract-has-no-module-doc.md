# notes writing contract has no module doc

status: open · origin: 2026-10-09 docs-history purge (cleanup/docs-history-purge) · area: notes / documentation

the notes writing acknowledgement, persistence schema/protocol and outline
(bullets) contracts were documented only in two plans deleted as completed:
`docs/notes-writing-plan.md` at `407fcc735` and
`docs/notes-bullets-plan.md` at `407fcc735`.
`docs/modules/notes.md` lifted only the read boundary, the one
clause a live doc cited (`docs/reauthoring.md` notes-pages row). the plans had
already drifted: `normalizeResourceSurface`, which the read boundary named, no
longer exists in `apps/web/src`, so their remaining sections cannot be lifted
unverified.

fix: read the writing, journal and outline owners (`lib/notes/`,
`components/notes/`, `services/notes.py`, `services/note_bodies.py`) and state
their current invariants in `docs/modules/notes.md`, keeping it short.

acceptance: `docs/modules/notes.md` names the owner and invariants of writing
acknowledgement, persistence/replay and outline adjacency, each checked against
current source.
