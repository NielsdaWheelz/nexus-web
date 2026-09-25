# secondary tab close label case

status: open; cosmetic · origin: 2026-09-24 reader-inspector-controls live verification, branch `reader-inspector-controls` · area: workspace copy

`SecondaryPaneShell.tsx:151` labels a transient tab's close button
`Close ${title}`, rendering `Close Search results`, while `PaneShell` labels
its own `Close search`. two nearby controls differ only by casing and suffix.

fix: one casing rule for close labels.

acceptance: close labels follow the same case convention.
