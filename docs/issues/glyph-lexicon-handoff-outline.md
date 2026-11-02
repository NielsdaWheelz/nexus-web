# outline redesign draws from the glyph lexicon

`docs/outline-spec.md:105` sizes the disclose chevron at 10px, as lucide
`ChevronRight` until the lexicon lands, and `:72`, `:110` and `:340` name
`CornerLeftUp` for the terminal row. the lexicon has landed. when the outline
redesign is built:

- the disclose slot draws `<Icon.Disclose open={…} size={12} />`: a glyph outside
  a slot sits on the scale in `docs/modules/visual-system.md`'s glyphs section, and
  10 is off it. the stroke is global, so the row sets no `strokeWidth`.
- the terminal row draws `Icon.Locate` (go to the spot), the sign
  `OutlineEditorRow.tsx` and `ResourceOutlineRow.tsx` already draw for
  `show earlier occurrence`.
- reference rows draw `<ResourceTypeIcon type={resourceType(scheme, kind)} />`
  (`lib/resources/type.ts`), as both rows do now, not `resourceIconForScheme`:
  the type layer draws a held media kind's medium, which authored stubs will
  carry once `note-editor-references-lack-media-kind.md` resolves.

resolved when the outline redesign merges with `--check-swept` and
`./scripts/test` passing.
