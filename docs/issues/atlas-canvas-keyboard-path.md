# the atlas canvas has no keyboard path

**problem**: the sky is a canvas (`role=img`). a keyboard user reaches works and folios
only through the visually hidden screen-reader list; nothing visible takes focus, so a
sighted keyboard user cannot pick a star.

**impact**: accessibility. every work and folio is reachable (the list opens each in the
pane), but not by sight without a pointer.

**evidence**: `apps/web/src/app/(authenticated)/atlas/SkyCanvas.tsx` (pointer events only),
`GrandAtlasPaneBody.tsx` (the `srOnly` list).

**resolved when**: a sighted keyboard user can move across stars (arrow keys over the canvas
with a visible focus ring and the hover label) or the list becomes visible on focus, and a
harness journey picks a work and a folio with the keyboard alone.
