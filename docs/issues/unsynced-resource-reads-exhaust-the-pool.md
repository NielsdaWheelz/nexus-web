# remote row reads can exhaust the database pool

status: open; connections-scroll removes the original local-highlight trigger.

original evidence (2026-11-01 lab): an unsynced profile mounted highlights through
`LocalRow` -> `ReferenceRow`, issuing one `/resource-items` get per mount; 5144
`db_pool_exhausted`, 5006 http 503 responses, requests up to 148s, then
`couldn't open your workspace`. the queueing mechanism was partly inferred.

held placed highlights and links avoid the row fallback; authored embeds resolve
locally. `components/resources/ResourceOutlineRow.tsx:ReferenceRow`
and server-owned embed targets still read the server per mount. the server has no
scroll-aware admission boundary; a sufficiently large remote inventory retains the
load-shedding hazard. a13 checks the repaired local trigger, not this remote bound.

impact: one reader can exhaust the api's database pool. preserve the local-first
cut and bound or shed remote work at its existing server/read owner.

resolved when a fresh-profile remote-heavy pass keeps admission and response times
bounded and produces no pool exhaustion; zero local-highlight reads alone is not
proof of that bound.
