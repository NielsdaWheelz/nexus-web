# library unknown sort labels are unbounded

status: open; source-audit hazard, live reproduction pending
origin: 2026-10-15 toolbar merge integration onto `7bc7c8a13`
area: libraries / view-choice content

`apps/web/src/lib/libraries/views.tsx:54` appends an unknown current value as
its own label. both library sort publishers call `offered`; an arbitrary long
`sort` url value can therefore appear in the native select while the server
request is pending, before invalid-view handling hides it. authored labels
fit the verified budget; this raw fallback has no bound. the upstream owner
is unchanged by the toolbar delta.

reproduce with a long unknown sort on `/libraries` or a library detail while
holding its real request; inspect the selected value at 320px/enlarged text.
fix the unknown-choice content at the library view owner, preserving the raw
value, server rejection and reset behavior.

acceptance: invalid sort state remains truthful and recoverable, with a
bounded readable selected label and no wider toolbar.
