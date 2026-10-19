# downloaded reader reserves a desktop map rail on phones

status: open
origin: 2026-10-11 mobile scrollbar investigation; baseline `39dfa94568`
area: downloaded reader / mobile layout

`apps/web/src/shelf/ShelfReader.tsx:211-214` mounts `MapRail` beside the reader
at every viewport width. `shelf.module.css:277-282` reserves a separate grid
column; `lib/documentReader/chrome/chrome.module.css:4-12` makes it 32px wide.
the hosted reader instead excludes the rail on mobile
(`app/(authenticated)/media/[id]/chrome.tsx:249-259`) and uses `PositionRibbon`.

impact: the downloaded phone reader loses 32px of reading width even with
native overlay scrollbars. this is a separate overview control, not a scrollbar;
the global scrollbar correction does not remove it. evidence is source review,
not a downloaded-reader device observation.

proposed fix: use the existing phone position ribbon on mobile and retain the
overview rail on desktop, preserving downloaded Contents and section navigation.

acceptance: the packaged reader on phone portrait and coarse landscape reserves
no side column for the overview; Contents, section jumps and return-to-spot still
work. desktop retains its overview. record device and artifact identity.
