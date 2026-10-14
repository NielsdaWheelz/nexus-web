# mounted embed target metadata stays stale

status: open
origin: 2026-10-14 x title implementation review
area: reader / document embeds

`python/nexus/services/document_embeds.py:596` projects a child media's current title into
`target.title`. changing that child title does not change the parent publication
identity. `apps/web/src/lib/documentReader/runtime.ts:229` retains a mounted
same-identity document's embeds;
`apps/web/src/app/(authenticated)/media/[id]/Embeds.tsx:34` displays their cached target title.
a quoted child's generated title therefore appears on a fresh parent open, but
an already mounted parent card keeps its earlier label. this predates the x title
change; the new title-only reload still intentionally preserves embed nodes.

evidence is source-qualified, not a mounted reproduction. no prerequisite.
give mutable embed target metadata its existing resource-level refresh owner,
without republishing parent source or replacing its canonical text/dom nodes.

acceptance: changing a quoted child's title updates its mounted parent card;
parent source identity, viewport, saved spot and selected canonical text remain
unchanged. verify access changes still use the target's authorization projection.
