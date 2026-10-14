# suggestion add can reclaim focus after the user moves it

status: open (source-confirmed hazard; browser reproduction pending)
origin: 2026-10-14 quick reads review
area: web / suggestions accessibility

`apps/web/src/components/collections/SuggestionsSection.tsx:143` captures
`ownsFocus` before awaiting add and refill. lines 175-177 schedule focus using
that old fact whenever survivors remain; the layout effect at lines 129-138
then calls `focus()` without checking the current active element or pane.
moving focus elsewhere during a slow add can therefore be undone by completion.

prerequisites: reproduce with a delayed add/refill and another focusable control.
use current focus ownership when removing a row. reuse the collection owner's
disconnected-target and active-context checks where possible
(`CollectionView.tsx:102-124`), keeping a section-level handoff only when the
whole section disappears.

acceptance: completion preserves focus moved to another row, pane or dialog;
when the removed control still owns focus, focus moves to a sensible survivor
or pane control. do not copy the old captured-focus logic into quick reads.
