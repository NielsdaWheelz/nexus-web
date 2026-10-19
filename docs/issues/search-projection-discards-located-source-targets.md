# search projection discards located source targets

source baseline: `69c00182c8328f46cec893517971f87f03cdbf16`; still present at `origin/main` `ff57128842b470510446b3edca54922ebcace41e` on 2026-10-16. line numbers refer to the original baseline unless stated otherwise.

status: open
origin: 2026-10-16 resource-reference architecture audit
area: search / resource activation

problem: search results receive a typed locator, but their view-model retains
only the activation href. a target whose href encodes only its owner therefore
opens the source without its passage; a bare fragment href names its start but
does not mark its extent. the same resource can reveal differently from a chat
citation and from search or a connection.

evidence: `python/nexus/services/search/project.py:203-217` publishes both
activation and locator; `apps/web/src/lib/search/searchViewModel.ts:124-149`
discards the locator, and `apps/web/src/lib/search/types.ts:11-28` cannot carry it.
`python/nexus/services/resource_items/routing.py:231-242` projects note evidence
and chunks to bare note routes. fragment routes at `:146-149` name only the unit;
`apps/web/src/app/(authenticated)/media/[id]/hostedReader.ts:186-193` resolves those
to a point with no decoration. source-confirmed; no live execution.

prerequisite: the shared resource activation must preserve the existing located
target independently of the short display snippet.

proposed fix: carry the owned source locator through the common activation and
destination-scoped reveal path. resolve complete fragment extents from the
loaded source. keep the href useful for native browser navigation and deep links;
do not recover targets by searching the truncated display text.

acceptance: opening the same located note chunk, fragment, and evidence span
from search, connections, and citations reveals the same full source extent.
whole-resource targets remain whole-resource targets. missing/changed targets
report unavailability rather than implying an exact match at the source start.
