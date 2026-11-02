# the import page's `into` picker has no `All · always` row

status: open · origin: 2026-11-02 import build, slice 2 lane b · area: libraries / chooser

the content sheet (2.3) gives the into picker a fixed first row, `All` with detail
`always` (spoken `All, always included`), from the prototype. the page renders the shared
`DestinationChooser` (`apps/web/src/components/libraries/DestinationChooser.tsx`), which
lists only the writable named catalog, and placement shares it.

impact: the picker never says that every import also files to All; only the trigger's
empty label `All` does.

resolved when: the chooser can show a fixed, unselectable `All · always` row for the
import page (or for every filing chooser, if placement wants it too), and the page passes
it.
