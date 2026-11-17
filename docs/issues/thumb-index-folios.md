# deferred: progress on open-pane lines

unapproved design proposal from the 2026-11-15 thumb-index exploration: show a
reading position or remaining duration beside an open pane's title. the thumb
index itself is now implemented (`02c38da85`); this proposal is not a missing
part of its accepted contract.

`apps/web/src/lib/workspace/presentations.tsx` `PanePresentation` carries title,
name, detail, media kind and status, but no progress. lectern summaries and the
active player's `barModel.ts` have consumption information for only some panes.
joining those at sheet open would give incomplete coverage; fetching there
would add work to the sheet's immediate paint.

decision needed: whether progress belongs on these lines, and whether missing
progress is an honest acceptable state. if approved, the canonical presentation
owner must supply it without a new sheet-owned fetch. otherwise decline the
proposal and remove this record; no implementation is currently required.
