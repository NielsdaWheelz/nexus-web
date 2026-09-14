# themed reader marginalia invents a second progress history

status: open
origin: 2026-09-11 reader-map council audit
area: reader overview progress semantics

`apps/web/src/components/reader/ReaderDocumentMapOverviewRail.tsx:95` starts a local five-second history timer from `visibleRange`, with no reading intent, source revision, or progress-reset input. `:113` records viewport reach and `:121` records dwell; cleanup records reach again (`:148`). find preview, restore, and a jump therefore advance this history even though canonical progress explicitly distinguishes those intents (`apps/web/src/lib/reader/readerDocumentPosition.ts:7`). `MediaPaneBody.tsx:7249` keys it by media id alone. its monotone local-storage merge (`ReaderDocumentMapOverviewRail.tsx:488`) cannot reflect a canonical reset or changed publication.

the displayed furthest value is loaded once (`:99`) and not updated when the timer advances its store (`:115`); rendering uses that stale snapshot plus the current viewport end (`:164`). the purported furthest-read vine can shrink during a session and grow again after reopening. this layer is shown by the elvish theme; collection runs for every mounted rail.

prerequisites: decide whether historical read coverage is a supported product fact or remove it from orientation chrome.

proposed fix: keep the map a presentation of canonical position. remove rail-owned collection and storage; if history is retained, consume an explicitly owned, intent-aware, revision/reset-aware read model from the existing progress/activity boundary and distinguish coverage from current position.

acceptance: preview, restore, and unadopted jumps do not claim reading; reset and source replacement cannot resurrect old map history; navigating backwards cannot shrink a displayed high-water mark; theme choice does not introduce another recording owner.
