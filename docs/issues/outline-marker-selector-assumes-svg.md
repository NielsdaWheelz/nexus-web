# the note dot's selector assumes glyph markers render an svg

problem: `OutlineEditorRow.module.css` tells the note dot from a glyph marker with
`.bullet:not(:has(svg))` (the dot, its transparent text, the hover and
forced-colour rules). that the scheme glyph and the terminal arrow render an
`<svg>` is a fact of `ResourceTypeIcon` and lucide, not of the row module.

impact: none today. a glyph that renders as an image or a font would draw a dot
over itself and hide its own colour, with no type or lint error.

evidence: the presentation review (question 1(a)), by source reading.

resolved when the row marks its own marker kind (a class or attribute set in
`OutlineEditorRow.tsx`) and the css reads that instead of `:has(svg)`.
