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
  wire payload (`routes/reader.py`, `response_model=MediaEvidenceResponse`,
  `extra="forbid"`) and the input to `locator_from_resolution`, which reads
  `resolver["selector"]` for `resource_graph/resolve.py` and the
  `evidence_spans` / `content_chunks` search retrievers. the producer key
  cannot go without splitting that return.

impact: two dead wire fields and one exact-key assertion that couples the two
sides; no user-visible defect.

resolved when: `resolve_evidence_span` returns the wire payload and the
locator input separately (or `locator_from_resolution` takes the locator
directly), `route`/`selector` are gone from `MediaEvidenceResolverOut` and the
web decoder, and a media-evidence open in the reader still lands on the span.
