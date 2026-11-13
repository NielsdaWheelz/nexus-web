# running head yields to a clipped heading

on a coarse-pointer phone, the title can yield while almost all of its matching
heading is behind pane chrome. neither copy is then readable at rest.

at `68836fa2f`, chromium lab `20261112-231342-4a8321427af7`, 320px viewport:
the visible band starts at y113; the heading's glyph range spans
y82.390625–115.390625. only 2.39px remains below the obstruction, but the trigger
has `data-yielded` and title opacity 0 after settling.

`text/geometry.ts`'s `offsetAt` counts a glyph whose box bottom reaches below
the visible top; `ReaderNavigation.tsx` faithfully compares that viewport-start
fraction with the section start. the approved formula therefore permits this
boundary. paths are under `apps/web/src/lib/documentReader/`.

reproduce by jumping to a section start with phone chrome shown, then compare
the heading glyph bounds with the occluded visible band. resolution needs an
owner decision on readable-heading visibility versus whole-line membership.
resolved when the title stays readable until its own heading is readable in
the unobstructed band, with no scroll-frame DOM measurement or layout motion.
