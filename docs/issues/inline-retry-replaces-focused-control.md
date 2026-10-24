# inline retry replaces the focused control

feature-local recovery presenters remove their retry control when an unknown
write is retried. keyboard focus can fall out of the recovery view before the
request settles. the writer still owns the exact request; this is a presentation
gap, deferred from the shared workspace feedback cutover.

present on main `a0db94b3fa9167c9972a418503ce406d225b1962`:

- `apps/web/src/components/resources/ResourceComposer.tsx:147`: the
  `unconfirmed` notice becomes the pending “saving…” status at line 154.
- `apps/web/src/components/connections/useConnectionAttachments.tsx:88`:
  `showLinkState` clears `task.failure` outside `unconfirmed`, hiding its inline
  recovery actions.
- `apps/web/src/app/(authenticated)/media/[id]/SelectionDock.tsx:432`:
  retry actions require `write.read().kind === "unconfirmed"`.
- `apps/web/src/components/notes/NoteNotices.tsx:96`: the uncertain retry
  becomes a saving status at line 104; `lib/notes/texts.ts:353` clears failure
  on queued/sending.

reproduce by losing an acknowledgement, keeping the local editor open, focusing
its exact retry, and holding the retry response. resolution requires that same
connected control to keep focus and expose busy through queued/sending until
settlement, without changing the writer's request or retry ownership.
