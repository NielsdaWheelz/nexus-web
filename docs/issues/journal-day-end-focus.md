# preserve keyboard focus when ending from a journal day

end on the focused journal scrollport goes directly to the oldest date.
a separately tried binding on a focused day article reached that date
but failed to transfer focus while a title edit was synchronizing.

in headless firefox run `20261124-060133-cd7a5b3406f0` at experimental
`c7eb192c8`, the terminal completion day alternated between pending and
admitted details across corpus publications. the new focus target never
settled in the ten-second observation. that article binding was discarded.

resolve when end from a focused day admits and focuses the actual oldest
day during a concurrent durable edit. keep normal end behavior in an
editor and cancel old focus restoration on later input.
