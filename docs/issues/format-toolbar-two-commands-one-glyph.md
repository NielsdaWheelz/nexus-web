# two formatting commands share an indistinguishable glyph

source finding at `fcd6843db` on 2026-11-15. in
`apps/web/src/components/notes/NoteEditor.tsx`, `FORMATS` paints `Icon.Code` for
inline code (line 236), and the body-presentation button paints the same glyph
(line 1812). one changes the selection's mark; the other changes the whole body.

impact: neighbouring commands with different scopes are distinguishable only
by their tooltips. the shared gloss "code" is not itself a glyph-law violation,
but it does not communicate the choice here.

resolved when: the toolbar communicates selection versus whole-body code before
activation, using the glyph/label owners rather than a private drawing. the
choice of distinct sign or visible label remains open.
