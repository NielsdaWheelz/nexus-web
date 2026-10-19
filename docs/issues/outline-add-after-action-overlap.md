# add-note-after control can be covered by row actions

on 2026-10-19, isolated authenticated chromium on `d8b0d4a730` could not click
`add note after “saved child”` in a desktop page containing one note. the button
was visible and enabled, but `ResourceOutline_actions` intercepted pointer events
through the full 30-second attempt. structural enter still provides insertion.

reproduce: open a page with one note, hover its row, then click its add-note-after
control. `components/notes/OutlineEditor.tsx:482` supplies that control inside
`ResourceOutlineRow` actions; `components/resources/ResourceOutlineRow.tsx:212`
owns the competing actions region (paths under `apps/web/src/`).

resolve the row action geometry/stacking so the visible insertion target receives
pointer input. prove add-after and the adjacent menu work with one and several
rows, including narrow panes, without forcing the click or changing selection.
