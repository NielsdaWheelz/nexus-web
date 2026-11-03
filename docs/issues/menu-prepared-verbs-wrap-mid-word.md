# menu prepared verbs wrap mid-word

the desktop `more` menu breaks its labels inside words: `Unsubscr ibe`, `Transcrib e
all episodes`, `unfinishe d`.

evidence: a show header's `more` at 1280x720 in the lab, in chromium. main at
`61562d112` shows the same wrap. the row separators stop well short of the panel
edge, so the rows hold a narrower width than the panel draws. the sheet is fine.

the glyph lexicon's sign-off saw it again on its branch, which leaves the menu files
alone: a show header's `more` in a single-pane workspace at 1600px opens 160px wide,
`ActionMenu.module.css:9`'s `min(10rem, …)` floor, in every room at 1x and 2x, while a
row's menu in the same pane opens 266px. so something narrower than the viewport bounds
the panel's shrink-to-fit width when it opens at the right edge.

afaict the width is published from the first rows, `Refresh` alone, and the prepared
verbs arrive later. `ActionMenu.module.css:73` makes content wrap to the published
width rather than widen the panel. not traced.

impact: every podcast header menu reads badly on desktop, on the surface that holds
unsubscribe.

resolved when every label in that menu breaks only between words, and the separators
reach the panel's padding.
