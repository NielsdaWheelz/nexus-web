# a dark reader frame re-declares shell geometry and motion tokens

problem: the Press block is `:root, [data-theme="dark"]`
(`apps/web/src/app/globals.css:8-9`) and carries scale, motion and mobile-shell
geometry as well as the palette, against its own comment ("rooms redefine colour,
shadow, grain, hairline, body size, tracking and the section-title font only",
`:3-7`). the reader frame sets `data-theme={profile.theme}`
(`apps/web/src/lib/documentReader/DocumentReader.tsx:289`), so a dark frame
re-declares `--mobile-pane-content-offset: 0px` and
`--mobile-content-bottom-clearance` (`globals.css:109,114`) over the values
`lib/mobileShell/viewport.tsx:129-133` writes on ancestors, and the durations
(`:78-81`) that reduced motion zeroes only on `:root` (`:317-323`). light frames
are unaffected; the scrollports are safe because their insets are inline on the
scrollport itself (`viewport.tsx:154-157`).

impact: on mobile in a dark reader, "opening document…" and "couldn't open" with
retry (`.readerState`, `documentReader.module.css:400-403`) lose header and bottom
clearance. reduced-motion users get 80–600ms durations back inside dark frames,
mostly masked by local guards. the same resets reach the root-inline
`--mobile-header-height`, `--mobile-nexus-bottom-offset` and
`--mobile-overlay-keyboard-inset` (`viewport.tsx:101-112`), and apply inside the
Press plate on `/settings/appearance` too. found by code reading; not rendered.

proposed fix: the Press block keeps exactly the 42 tokens that another room block
also declares; the other 92 move, unchanged, to a `:root`-only block placed before
the reduced-motion `:root` block (`globals.css:317-323`; equal specificity, so
order decides). no resets are added for Solar- or oracle-only tokens.

resolved when, inside every nested dark scope, each moved token computes equal to
its nearest outside ancestor on mobile and desktop with and without reduced motion,
and a 390×844 dark reader shows its opening state clear of the header.
