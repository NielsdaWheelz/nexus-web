# feedback-homes absorbs the glyph lexicon

feedback-homes was specified before the lexicon. when it merges main:

- `apps/web/eslint.config.mjs` holds the shared lists `LUCIDE_PATHS`,
  `LUCIDE_PATTERNS`, `SYNTAX` and `RAW_DRAWING_SYNTAX`. flat config replaces a
  rule's options per block, so each of L7's per-file `no-restricted-imports`
  blocks spreads the lucide paths and patterns into its own, and any block that
  sets `no-restricted-syntax` spreads `SYNTAX` (and `RAW_DRAWING_SYNTAX` outside
  the raw owners).
- `SYNTAX` already refuses a capitalised literal as `fail`'s title (glyph
  criterion 1). L7 extends that one entry to `say` rather than adding a second.
- L7's lucide `Loader*` guard is unneeded: only the registry imports lucide, and
  it exports no spinner.
- new glyph sites draw through `Icon.*`: `Fact.tsx`'s check is `Icon.Check`,
  `Slips.tsx`'s close is `Icon.Dismiss`. its tuck chevron needs an iconographer
  ruling between `Icon.Down` (more that way) and `Icon.Disclose` (in place).
- the octagon's recovery control at `components/feedback/Feedback.tsx:124` draws
  `Icon.Warning` on main; it leaves with the octagon.
- danger feedback draws `Icon.Warning` in the danger tone; info draws nothing,
  with no sign, no slot and an ink title.

resolved when the feedback-homes cut merges with `--check-swept` and
`./scripts/test` passing, and the tuck's sign is ruled.
