# note formatting can be obscured by pane chrome

two inherited lab reports concern the same formatting-toolbar placement:

- at `d8b0d4a730` on 2026-10-19, chromium intercepted a pointer click on bold
  with `PaneShell_controlRow` when selecting the top root note. keyboard
  formatting and paste still worked.
- firefox lab `20261101-171428-20e56342b48d`, 1280×720: selecting any of three
  page-outline rows put the toolbar at the same position above the outline.
  hit-testing the code-presentation button returned the open filter input.

impact: the visible formatting commands could not reliably be clicked, despite
a valid selection.

the current `NoteEditor.tsx` places the bar above the selection for fine input
when it fits the padded scrollport, below for coarse input when it fits, and
uses text marks for the commands. the selection-placement check does not
hit-test every mark with the collation picker open.

resolved when: pointer formatting at the first row and after scrolling reaches
bold, italic, link and code commands without losing the selection or being
intercepted by current pane chrome. include an open collation picker where
that combination is supported.
