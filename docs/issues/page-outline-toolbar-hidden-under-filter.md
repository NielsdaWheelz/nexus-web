# the formatting toolbar is unreachable in a page outline

origin: 2026-11-01 annotation emptying qualification, firefox lab · area: web note
editor

selecting text in any row of a page outline (`/pages/:id`) shows no usable toolbar.
`role=toolbar` exists, but `.toolbar` (`NoteEditor.module.css:10`) is absolutely
positioned above the outline's shell, not the selection, so every row puts it in one
box over `Filter page items`. the input wins hit testing: a click on
`Code presentation` times out and the row gets no code. the screenshot shows no
toolbar.

impact: code presentation, and any other toolbar command, cannot be applied by
pointer in a page outline. the highlight detail pane reaches its toolbar.

evidence: lab 20261101-171428-20e56342b48d, firefox 1280x720, three rows: toolbar box
x 593 y 103 258x42 for every row; `elementsFromPoint` at the button's centre returns
the filter input and no toolbar element in its top five.

resolved when selecting text in any page outline row shows the toolbar beside the
selection, and its buttons take a real click.
