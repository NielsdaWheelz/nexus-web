# media evidence wire keeps dead route and selector fields

status: open · origin: 2026-09-17 slop sweep (claude session), py-schemas M-ME-01 · area: reader
evidence · oi-166

`MediaEvidenceResolverOut` (`python/nexus/schemas/media.py`) carries `route` and
`selector`, and the web reader never uses either: `mediaEvidenceResolution.ts`
only asserts their presence via `expectExactRecord(raw, ["kind","route",
"params","status","selector","highlight"], …)` and then reads `params`,
`status`, and `highlight`. dropping them is not a schema-only change, which is
why the schemas PR deferred it:

- `expectExactRecord` demands an exact key set, so the python side cannot lose
  a key before the web decoder does.
- `locator_resolver.resolve_evidence_span` returns one dict that is both the
  wire payload (`api/routes/reader.py:46-51`,
  `response_model=MediaEvidenceResponse`, `extra="forbid"`) and the input to
  `locator_from_resolution` (`services/locator_resolver.py:478-563`). the latter
  reads the original selector for resource-graph navigation and both evidence
  and content-chunk search retrieval. keep this internal selector.
- the emitted `route` has no reader in python or web code, including the note
  evidence branch. its only producers are
  `services/locator_resolver.py:374,414`; note routing uses the retained owner
  id and `note_block_offsets` locator instead.
- review at `352653689547f50c4d50ce7df79eb85812c61dd2` also found
  `_RankedContentChunkResult.resolver` (`services/search/results.py:95`) is
  write-only: `retrievers/content_chunks.py:247,317` copy the whole resolver,
  while `services/search/projection.py:514-524` emits the locator and never
  reads that copy. no generic dataclass serialization consumes it.

impact: two dead wire fields, an unused copy on each ranked content chunk, and
an exact-key assertion coupling browser output to internal locator data; no
user-visible defect.

fix: retain one private resolution representation and its live selector. remove
the unused route from both producers and the unused ranked-result resolver
copy. project the browser payload explicitly at the existing media-evidence
api boundary, omitting selector there; remove both fields from the response
schema and exact-key web decoder in the same cutover. no new return wrapper or
locator reconstruction from highlight data is needed.

resolved when: search and resource-graph locators, including note evidence,
remain unchanged; the media-evidence response has neither route nor selector;
the exact-key browser decoder accepts it; and opening media evidence in the
reader still navigates to and highlights the span. keep unresolved and pdf
no-geometry behavior unchanged.
