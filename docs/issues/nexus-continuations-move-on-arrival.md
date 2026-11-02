# the continuation rows move on every arrival and arrivals carry no onset

status: open · origin: 2026-11-02 palette s2 adversary · area: web / nexus desktop (s3)

`DesktopNexus` renders the two continuations (`search all results`, `use this
text…`) as a second `rowgroup` after `Results`, in the same scrollport flow
(`DesktopNexus.tsx` groups loop; `Nexus.module.css` `.group + .group { margin-top }`).
every arriving row appended to `Results` pushes them down, and no row carries
`data-band="arriving"`, so the `onset` animation the motion sheet binds
(`.row[data-band="arriving"] { animation: onset 200ms }`) has no element to run on.

evidence: lab run `20261101-235405-493d47cab729`, palette-05 chromium: `"search
all results" 246.7 -> 401.5` and `"use this text…" 282.7 -> 437.5` under `row
moved between keystrokes`, 25 `arrival without onset`; every arrival is also
`arrival above a shown row` because the continuations set the probe's floor.

impact: law 1 ("afterwards nothing shown moves") fails for two shown rows on
every query with arrivals; criterion 5 ("arrivals appear below with onset")
cannot be green before s3; the motion sheet's §8 `.continuations` is in flow,
so the sheet and law 1 disagree here.

fix, owner's call, named in the pr: (a) s3 pins the continuations outside the
scrollport as the card's last child (the phone's field already sits outside the
sheet's scrollport), so appended arrivals never move them, and marks rows at
index ≥ `list.held` with `data-band="arriving"`; or (b) s0 exempts the
`Continuations` group from palette-05's offset and floor rules and the sheet's
in-flow `.continuations` stands. (a) keeps law 1 whole; (b) keeps the sheet.

resolved when palette-05 records no `row moved between keystrokes` for a
continuation and no `arrival without onset`, on a tree where s3 has landed.
