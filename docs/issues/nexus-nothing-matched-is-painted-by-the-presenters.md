# `nothing matched here` is patched in by both presenters and grows the footer

status: open · origin: 2026-11-02 palette s3/s4 review · area: web / nexus rows (s1), controller (s2), both presenters

the contract's zero-principal state arms `search all results` with the detail
`nothing matched here`. no producer makes that row: `DesktopNexus.tsx` and
`SwitchboardTask.tsx` each compute `nothing = typed && rows.length === 0 &&
!pending` and spread the detail onto `Continuation:SeeAll` while rendering.

the detail is a second line, so when `pending` clears with no rows the pinned
`search all results` row grows by a facts line: on the card its title moves up
inside the fixed-height footer; on the sheet the band grows downward. nothing
the user did in that frame caused it (goal 1).

impact: duplicated content logic in two presenters; a ~10px shift of a shown
row when the remote phases settle empty.

evidence: by reading (`DesktopNexus.tsx` and `SwitchboardTask.tsx`, the `nothing`
and `shown` lines in each). the shift is inferred from the row grid (title line
plus a 12px facts line against the 36px/48px row minimum); not measured.

fix: produce the detail in `rows.ts` `continuations` from a settled-empty fact
the controller passes, and delete both patches. whether `search all results`
should carry a facts line while pending (so settling only swaps text) is the
row editor's and motion editor's call.

resolved when: neither presenter names `Continuation:SeeAll`, and a typed query
that settles empty moves no shown row.
