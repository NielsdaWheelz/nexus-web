# the chats/notes sort contract exports more than its callers need

problem: `apps/web/src/lib/collections/updatedTitleIndexView.ts` exports 11
names (a view union, a decoded union, a canonical constant, codec, query and
four option helpers) for four sorts, and both callers
(`app/(authenticated)/conversations/ConversationsPaneBody.tsx`,
`app/(authenticated)/notes/NotesPaneBody.tsx`) translate between the view
union and option ids. the pane chrome re-slice made the module one table but
kept the contract: narrowing it edits `NotesPaneBody`, which the notes re-slice
owns and which the coordinator's ruling leaves to whichever of the two merges
second.

impact: size and indirection only (about 35 lines in the module and 17 in each
caller); no behaviour.

proposed fix: one table keyed by option id, `decodeUpdatedTitleSort(params) →
id | null`, `encodeUpdatedTitleSort(id, current)`, `updatedTitleSortQuery(id)`
and `UPDATED_TITLE_SORT_CHOICES`; each caller holds an option id instead of a
view. the pane chrome design's sketch has all three files
(`nexus-web-campaign-artifacts/2026-10-21/chrome/sketches/tree/`).

resolved when both callers use the narrowed contract and the module exports
only it, with the chats and notes sort journeys (harness S-1) unchanged.
