# remaining pane-controls accessibility verification

status: open
origin: 2026-09-25 pane-controls implementation; narrowed 2026-10-13
area: collection controls / manual accessibility verification

the earlier search and podcast credential/fixture blockers are resolved by the
real 2026-10-13 isolated qualification. partial/retained/failed continuation,
reset/focus, two-pane ownership, unsupported/resolving native find, physical
android keyboard/chrome and publisher coverage were also exercised. current
observations and methods: [verification](../pane-controls-verification.md).

the remaining verification debt is spoken screen-reader behavior and actual
browser/os 200% accessibility settings. the live 200% layout check used a
browser-applied root-font userstyle; it is distinct evidence. unrelated old
edge states without a current witness are not silently promoted to pass.

prerequisite: an operator using the supported screen reader and actual text
settings. exercise labelled fields/groups, inline disclosure, changed result
announcements, clear/reset/chip-removal focus and the narrow reader/query rows.
record the real observations and file concrete defects at their owners.

acceptance: those interactions remain understandable and reachable with spoken
feedback and the actual accessibility settings. close only after observing
both; synthetic layout and native html semantics do not substitute for them.
