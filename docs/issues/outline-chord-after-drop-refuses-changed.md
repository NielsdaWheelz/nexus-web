# a move chord after a settled drop once refused "the outline changed"

priority: deferred prototype inconvenience: retry the chord. investigate on recurrence or when changing arrangement admission.

problem: once, on firefox, a `⌘⇧↑` pressed after an unhurried drop (the drop
painted, selected and announced) refused with `the outline changed; try again`
and the receipt "outline unchanged". the likeliest cause, unproven: the drop's own
sync echo advanced the store revision between the chord's plan and its preflight,
which a settled local gesture should not be refused for.

impact: an ordinary chord occasionally does nothing but say so; the reader must
press it again.

evidence: lab run `20261102-131359-cce04441990f`, case
`adversary-L2-a-focus-pending` (firefox): rows `[b, c, a, d]` with `a` selected,
receipts `outline unchanged`, `the outline changed; try again`. the same case was
green on both browsers in three other runs of the drag fixes and in run
`20261102-144552-8032b008d8f5`.

resolved when the refusal's revision source is identified, and a case that drops,
waits for sync, then chords repeatedly on firefox never refuses `changed` without
a foreign change.
