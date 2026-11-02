# playback-bar absorbs the glyph lexicon

the lexicon landed every player sign the playback spec planned for lane 2
(`Chapters`, `UpNext`, `Lectern`, `SeekBack15`, `SeekForward30`, `Stop`, `More`,
`Player`), the global stroke and the sweep. `playback-bar` merges main and must:

- lane 2 appends only `Speed`, `PlayPause` and `Effort` to
  `apps/web/src/lib/ui/icons.tsx`, one `export const` per line in the file's
  order, plus their glosses. the stroke rules in `globals.css` are already there.
- rerun the lexicon codemod (attached to the lexicon pr as its first comments) over files the branch rewrote: `--rows-since`
  the lexicon's base with `--paths`, fill signs, sweep, `--check-swept`.
- the skips' 28px lives in `Player.module.css` `.skip`
  (`--control-icon-size: 28px`); lane 4 moves it with the transport's leaf css.
- lane 6 drops `src/components/chat/EffortPicker.tsx` from the raw svg and
  `strokeWidth` owners in `apps/web/eslint.config.mjs` when it draws `Effort`; a
  parametric or dash glyph sets `vector-effect: none` on its own paths.
- lane 8 is retired: the sweep is done.

resolved when `playback-bar` merges main with `--check-swept` and `./scripts/test`
passing and `EffortPicker.tsx` gone from the owners list.
