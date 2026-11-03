# failed-readable import retention remains unverified

at `1b63b5706`, `failedTruth` in `apps/web/src/lib/imports/intake.tsx` uses
`item.can_read || item.can_play` to retain a usable failed source. no real failed
but readable or playable intake line has exercised that branch.

a wrong readability decision could hide a usable reader. qualify retention
through an actual permitted source ingress and real reader responses; do not
edit source status to construct the state. if a
branch is unreachable in the authorized runtime, prove that boundary by source
and name the exact remaining limit in the pr as the import spec permits.
