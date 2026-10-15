# suggestion add refetch can replace its stable survivors

status: open (source-confirmed path; browser reproduction pending)
origin: 2026-10-14 quick reads review
area: web / suggestions interaction

`apps/web/src/components/collections/SuggestionsSection.tsx:159-179` retains
survivors and appends one replacement after add. however, its query is disabled
while adding (line 81) and re-enabled when `adding` clears. a lectern add also
publishes `Consumption` (`apps/web/src/lib/lectern/LecternProvider.tsx:197-200`),
changing that query key. the resulting read replaces all rows at lines 88-90,
so the locally preserved slate can immediately be replaced by a newly ranked
slate. this undermines the stable-survivor contract at lines 39-43 and adds a
full query after the explicit refill query.

prerequisite: reproduce with a slate whose fresh rank differs from its retained
survivors. keep add/refill and background refresh under one explicit section
policy: consume the accepted mutation's invalidation, and preserve survivors
through that interaction; allow fresh ranking on the documented later refresh
triggers. do not generalize this lifecycle into quick reads, whose row remains
eligible after addition.

acceptance: after add and every request it triggers settles, the surviving rows
retain order and at most one replacement is appended. a subsequent independent
refresh still reconciles eligibility. this ticket records a source-level path,
not an observed production incident.

2026-10-14 latency diagnosis: current `SuggestionsSection.tsx:166` awaits
`load()` without a cancellation signal before removing the acknowledged row
and clearing `adding` at lines 185-186. the expensive refill therefore delays
visible add completion as well as starting the duplicate hook read above.
acceptance also requires immediate acknowledged row removal and independently
owned, bounded refill, without reclaiming focus the user has moved.
