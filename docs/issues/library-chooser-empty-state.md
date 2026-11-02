# the library chooser says "no libraries yet" to a member who admins none

status: open · origin: 2026-11-02 import content sheet (slice 2), open point 9 · area: libraries / copy

`DestinationChooser`'s empty state reads `no libraries yet`
(`apps/web/src/components/libraries/DestinationChooser.tsx:90`). its catalog,
`GET /libraries/destinations`, is only the libraries the viewer admins, beside
non-default and non-system (`python/nexus/services/libraries.py:506-528`). a
reader who belongs to libraries but admins none sees a false sentence. the
import page's `into` picker and placement both show it; the extension popup
keeps its own true `no libraries you can file to`.

impact: a member reads that they have no libraries, and may create one they
did not need.

resolved when: the chooser's empty state is true for a member who admins none,
in one spelling across the import page, placement and the popup.
