status: open
origin: 2026-09-25 notes writing live action probe
area: pdf highlight interaction

two highlights on the same pdf passage can overlap as pointer targets. in the
isolated browser run, playwright could see highlight
`d9a495d2-28b2-4315-a516-fd6de1c7f088`, but overlay
`497b8826-d2b7-46ee-b89b-c57cf8969008` intercepted every click at its
center (`/private/tmp/notes-writing-live-red/w4highlightAction-run.log`).
keyboard focus can reach the intended target; pointer access cannot reliably
choose the covered highlight. this is outside the writing cutover.

prerequisite: decide the interaction for coincident pdf highlights. expose a
deterministic way to select each target without hiding either annotation.

acceptance: create two overlapping highlights on one passage; a pointer user
can open either highlight's actions, and keyboard access still works.
