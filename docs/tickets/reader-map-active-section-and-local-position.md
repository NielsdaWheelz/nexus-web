# reader location does not drive current section or section progress

status: open
origin: 2026-09-11 reader-map council audit
area: reader navigation and progress projection

`apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:5692` marks the loaded epub navigation target as current; `:5701` uses the last selected web section. these values are set by navigation, restoration, and find adoption, not by the semantic viewport. scrolling across multiple headings inside one rendered fragment therefore leaves contents on the old section. `apps/web/src/components/reader/ReaderContentsNav.tsx:24` uses that target for styling and `aria-current`.

the overview marker contract has only a global point (`apps/web/src/lib/reader/documentMap.ts:241`) and the rail accepts only a global visible range (`apps/web/src/components/reader/ReaderDocumentMapOverviewRail.tsx:27`). no section-local projection exists. saved `locations.progression` is `anchorOffset / activeLength`, where active length is the entire fragment (`apps/web/src/lib/reader/DocumentReaderSession.ts:124`), so it must not be relabeled chapter progress when a fragment contains several chapters.

prerequisites: canonical semantic section ranges with explicit nesting and endpoint rules; retain the existing resource-local locator meaning.

proposed fix: derive current semantic section and local viewport/evidence positions from the same canonical point that drives the global projection. keep the loaded resource/navigation target separate from the currently read section. add a section detail projection without another persisted position or geometry owner.

acceptance: scrolling across three headings in one xhtml resource updates current contents and section-local progress; local progress resets at the next section while global position remains monotone; nested boundaries and exact document end have explicit, proven behavior; reflow does not change source positions.
