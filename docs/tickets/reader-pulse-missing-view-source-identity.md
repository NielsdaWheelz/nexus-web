status: open
origin: 2026-09-13 bounded workspace implementation
area: reader navigation / provenance

`apps/web/src/lib/reader/pulseEvent.ts:8` addresses pulses by media id;
the pending map also keys only media id. `HtmlRenderer.tsx:114` accepts every
matching-media pulse, including independently positioned panes and retained
publication generations. its candidate fallback at line 218 can select an
unrelated first highlight when the requested source range is absent.

prerequisite: finish selected-publication body navigation. use its exact
view/source/window owner for local activation; make cross-pane activation
explicit at the destination owner. do not translate a missing locator into an
unrelated highlight. source-note detail must not call the media-only broadcast.

acceptance: two independently positioned panes of the same media, including
different retained generations, preserve the untouched pane; missing requested
range produces an unavailable result and never pulses a different highlight.
