# palette-11 reads lucide's stroke attribute, not the computed stroke

status: open · origin: 2026-11-02 palette s3/s4 repair · area: lab case (s0), `apps/web/.nexus-lab/cases/palette-11-rooms.spec.ts:71,81` (ignored)

the case takes a row glyph's stroke as `svg.getAttribute("stroke-width") ??
getComputedStyle(svg).strokeWidth`. lucide always writes `stroke-width="2"`, so
the computed value is never read. the contract draws the palette's glyphs at
1.5 by one css rule that overrides the attribute, and bans `strokeWidth` props
(engineering, glyphs; criterion 1); criterion 11 asks for "computed
stroke-width 1.5". the rule is `Nexus.module.css:85`, `:is(.gutter, .glyph,
.trailing) svg { stroke-width: 1.5; }`.

evidence: lab run `20261102-120048-554a7e7740c0`, palette-11 dark chromium:
`glyph stroke 2` for the Moby-Dick row, `search all results` and `use this
text…`, and no other violation (bar, heads, widths, shared x pass).

impact: criterion 11 is red for a reason the contract rules out (observed in
dark; the other rooms did not run, and by reading fail the same way); the only
product change that would satisfy the case is the banned prop.

fix (case author, not the implementer): read
`getComputedStyle(svg).strokeWidth` only.

resolved when palette-11 passes in three rooms and both engines with the css
rule unchanged and no `strokeWidth` prop in palette files.
