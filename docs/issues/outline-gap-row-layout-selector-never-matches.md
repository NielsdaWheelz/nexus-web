# the gap-row layout selector targets the wrong element

source finding at `fcd6843db` on 2026-11-15; visible impact was not measured.
`apps/web/src/components/notes/OutlineEditorRow.module.css:97–101` makes
`.content[data-gap]` a wrapping flex row. in
`apps/web/src/lib/notes/outlineController.ts`, `.content` belongs to `body`,
while `content.dataset.gap` (lines 2154–2155) sets the attribute on its inner
field. the gap button is in the field's sibling presentation element.

impact: the intended wrapping and column gap never apply. whether the current
block layout needs that rule is still unknown.

resolved when: the selector and attribute address the intended layout element,
or the unused rule is removed after confirming that the gap row needs no such
layout.
