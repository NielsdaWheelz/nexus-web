# nested note text sits high beside its control

`OutlineEditorRow.module.css` `.content` keeps 2px top padding beside a 24px
control, tuned for 21px note lines. the companion tokens make nested notes
13px/1.35 (17.55px), putting their first line centre about 1.225px above the
control centre. this follows from layout arithmetic, not a separate lab case.

impact: nested text and controls look slightly misaligned. nested gutters and
`OutlineEditorRow` geometry were outside the approved density scope.

resolved when: the row owner centres fine/coarse first lines at both normal and
companion type without changing target minima or nested gutters.
