# remaining pane-controls accessibility verification

status: open
origin: 2026-09-25 pane-controls implementation; narrowed 2026-10-15
area: collection controls / manual accessibility verification

the earlier search and podcast credential/fixture blockers are resolved by the
real 2026-10-13 isolated qualification. partial/retained/failed continuation,
reset/focus, two-pane ownership, unsupported/resolving native find, physical
android keyboard/chrome and publisher coverage were also exercised. current
observations and methods: #578.

the toolbar qualification (#628) adds actual
firefox 158 page zoom and text-only zoom at 200%, with measured 320px query
panes. native select values, including unsupported order, remain readable.
this supersedes the earlier root-font userstyle evidence for query geometry.
it does not qualify reader navigation, other os settings or spoken feedback.

remaining debt: spoken screen-reader behavior and enlarged reader/navigation
interactions not covered by the query-toolbar observations. unrelated old edge
states without a current witness are not silently promoted to pass.

prerequisite: an operator using the supported screen reader and actual text
settings. exercise labelled fields/groups, inline disclosure, changed result
announcements, clear/reset/chip-removal focus and the narrow reader/query rows.
record the real observations and file concrete defects at their owners.

acceptance: those remaining interactions stay understandable and reachable
with spoken feedback and actual accessibility settings. close only after
observing them; native html semantics do not establish spoken behavior.
