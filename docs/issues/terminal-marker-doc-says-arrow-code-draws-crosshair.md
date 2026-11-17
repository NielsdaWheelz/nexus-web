# notes.md calls the terminal marker an arrow; the code draws a crosshair

found 2026-11-15 at fcd6843db, surveying the notes for a redesign.

## problem

docs/modules/notes.md says terminal occurrences use "the earlier-occurrence
arrow". `OutlineEditorRow` draws `Icon.Locate`, lucide `LocateFixed`: a
crosshair, glossed "go to the spot". the doc names a drawing the code does not
have, and neither gloss says "earlier".

## impact

a reader (or a redesign) working from the doc expects an arrow back to an
earlier row. the marker actually says "go to the spot".

## evidence

- `docs/modules/notes.md:634-635`: "terminal occurrences the earlier-occurrence
  arrow".
- `apps/web/src/components/notes/OutlineEditorRow.tsx:99`:
  `row.terminal ? <Icon.Locate size={14}/> : ...`.
- `apps/web/src/lib/ui/icons.tsx:47,125`: `export const Locate: Glyph = LocateFixed; // go to the spot`.
- `docs/issues/outline-reference-glyph-size.md` carried the same stale name
  (`CornerLeftUp`) and is corrected alongside.

## resolved when

the doc and the code name the same marker, either by describing the crosshair
and its gloss or by drawing the arrow the doc promises.
