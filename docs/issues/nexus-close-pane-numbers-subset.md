# nexus close pane numbers the subset

problem: a nexus resource row's menu labels its close commands "close pane N",
where N is the pane's index among the panes showing that resource, not its
position in the strip or the manage-panes list. the current pane still takes an
index, so with the current pane first the others read "close pane 2", "close
pane 3".

impact: the number names nothing the user can see. with two panes on one
resource at strip positions 2 and 5, the menu offers "close pane 1" and "close
pane 2"; choosing either is a guess.

evidence at branch `fork-gesture-pane-noun` (base `4a5b1c710`):
`apps/web/src/lib/nexus/rows.ts:277` (`index + 1` over the `panes` argument),
`:283` and `:290` (`resourceRow` passes the same-resource `matching` subset),
`:331` and `:336` (the open-pane fallback in `candidateRows` does the same).
`apps/web/src/components/nexus/NexusRow.tsx:84` renders the labels verbatim.

proposed fix: number by workspace order (`state.panes`, which is strip order),
for instance by passing each pane's position on `NexusPane`, or name the pane by
a fact that tells same-resource panes apart.

resolved when, with one resource open in panes at strip positions 2 and 5 and
neither current, the row menu reads "close pane 2" and "close pane 5", and each
closes the pane at that position.
