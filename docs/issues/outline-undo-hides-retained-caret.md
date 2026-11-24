# undo can leave the focused outline caret below the viewport

in lab `20261124-032102-2af155acd5ed` at `ef655b018`, android 15 and
gboard, an outline ended in two sibling notes. indenting the last one and
undoing restored its depth, focus and exact caret. a real keypress inserted
at that caret. the measured scroll height rose from 1129 to 1897 css px,
with an “earlier writing” gap under the preceding sibling. the caret
bottom was at 1048 css px in a 554 css px viewport. the keyboard remained
visible and the last item could still receive text while out of sight.

investigate the outline's paging and caret reveal after undo. resolve when
the same live indent, undo and typing sequence restores the caret to view
without a corrective scroll. retain the focus and original insertion offset
and check another expanded sibling.
