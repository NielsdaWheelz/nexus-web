# append delivery can outrun the open outline filter

in `PagePaneBody.tsx`, the `AppendNote` delivery is claimed, the filter is
cleared, and `appendAtTail` runs in the same effect. the controller
refuses append while its filter is nonempty. the next render clears the
filter after the delivery has already been consumed.

this is a source finding from the two parents of the notes home merge
`a333f0c2c`. return to a filtered page by activating the add-note action.
verify the filter clears and the original delivery creates and focuses
one tail note. let the unfiltered outline admit the delivery before claiming it.
