# library admission gates masquerade as running work

at b3057fc0306fb64e8e3791f3fd7f9baf7d29e351,
`apps/web/src/components/libraries/LibraryMembers.tsx:156` uses `busy` for
pending uncertainty, checking, rejected admission, and browser offline alike.
the confirmation consumes it as `aria-busy` at line 231. `Button.tsx:26` and
`control.tsx:70-75` turn that into a spinner, replacing the confirmation label.

open a remove, transfer, or revoke confirmation online; then go offline without
pressing confirm. no mutation has run, but the confirm now spins. cancel and
escape also stop working (lines 207 and 218). an answered unknown also keeps the
spinner after `running` becomes false. this regresses the feedback contract:
blocking transmission is not evidence that a press is being processed.

keep the write gate, exact command, and loss guard. expose actual dispatch state
separately and use it for busy paint. local confirmation dismissal must not
require network admission; it only hides the question and leaves retained work
untouched. the invitation owner's Keep control has the same local-dismissal
admission coupling at `LibraryInvitations.tsx:134`.

source-proven; no new runtime reproduction yet. resolved when both browser
engines show disabled, nonbusy confirm with zero writes after offline, allow
local cancellation, and show busy only during a held pending dispatch while an
unknown outcome retains its held retry and loss guard.
