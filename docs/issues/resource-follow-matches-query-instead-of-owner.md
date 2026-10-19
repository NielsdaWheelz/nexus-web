# resource follow treats a target query as a different destination

source baseline: `69c00182c8328f46cec893517971f87f03cdbf16`; still present at `origin/main` `ff57128842b470510446b3edca54922ebcace41e` on 2026-10-16. line numbers refer to the original baseline unless stated otherwise.

status: open
origin: 2026-10-16 resource-reference architecture audit
area: workspace / resource navigation

problem: following a message into its already-open conversation does not match
the bare conversation pane, because its target query participates in pane reuse.
this conflicts with the requested resource-level follow and explicit shift-fork
contract. source-apparatus queries have the same distinction for media.

evidence: `python/nexus/services/resource_items/routing.py:142-145` routes messages
with `?message=...`; `:49-50` routes apparatus with queries. reuse compares only
`routeKey` at `apps/web/src/lib/workspace/targetActivation.ts:113-116`, while
`apps/web/src/lib/panes/paneRouteModel.ts:290-292` includes the complete query in
that key. the existing resource-aware activation identity is already defined at
`:321-324`. source-confirmed; no live execution.

prerequisite: distinguish resource-pane identity from an arrival target and from
query-defined collection identity.

proposed fix: retain the central planner and match resource destinations by its
existing resource-aware activation identity; deliver the selected message or
source passage to that visit separately. keep query identity for search and
other collections where the query defines the view.

acceptance: from another pane, follow two different messages in one open chat
and two passages in one open media: the chosen owner pane is reused and each
target is revealed. shift-click always creates a new pane; separate searches
still retain their distinct query identities.
