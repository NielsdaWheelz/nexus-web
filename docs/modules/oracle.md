# Oracle

Oracle has two service owners.

`python/nexus/services/oracle.py` owns readings: question validation, current
corpus and library retrieval, plate selection, LLM prompt/call/parse, persisted
folios, and SSE event emission.

`python/nexus/services/oracle_plates.py` owns plate assets: URL construction,
metadata lookup, ETag metadata, and byte-size-checked storage reads.

Oracle has one current corpus. Runtime code does not select among corpus
releases, persist provider request hashes, or store DB-only passage
provenance objects.

## Folios, Citation Edges, And Concordance

A reading persists one `oracle_reading_folios` row per phase (descent / ordeal /
ascent) carrying the generated content (attribution, marginalia, locator label).
Each folio references its citation `resource_edge` by `edge_id`: in the same
per-phase transaction `oracle.py` calls
`resource_graph.citations.record_citation` to mint an `origin='citation'` edge
whose source is the `oracle_reading:<id>` and whose target is the cited resource —
a stable `oracle_corpus_passage:<id>` for public-domain text or an
`evidence_span:`/`content_chunk:` for user media. The edge owns identity and the
display snapshot (excerpt, deep link); the folio owns the generated prose, not
duplicated on the edge.

Concordance ("other readings that drew the same source") is
`resource_graph.citations.concordant_sources` scoped to `source_scheme='oracle_reading'`:
identity equality on the cited `(target_scheme, target_id)`, so two readings that
drew the same public-domain passage share one target id by construction.

## Plate Contract

- Frontend URL: `/api/oracle/plates/[id]`.
- Backend URL: `/oracle/plates/{id}`.
- Frontend type contract: `OraclePlateImageSrc`.
- BFF helper: `proxyPublicToFastAPI`.
- Backend route auth: internal header only; no viewer bearer and no cookies.
- Storage key: `oracle/plates/<stable plate key>.<jpg|png|webp>`.
- DB owner: `oracle_corpus_images`.

`oracle_plates.py` releases the DB session before reading object storage.
Matching `If-None-Match` requests return `304` from validated DB metadata
without touching storage. The ETag is route metadata, not a content hash.

## Operational Rule

Oracle seed objects are deployment preconditions. The backend deploy runs
`ensure_oracle_seed_objects.py` before Alembic. Runtime request handlers do not
seed, repair, or fall back to fixture files when an owned plate object is missing.
