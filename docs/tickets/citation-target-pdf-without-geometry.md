# citation target for a geometry-less pdf span raises

status: open · origin: 2026-09-28, pr-05 cleanup/search-locators (claude session) · area:
resource graph / citations

`reader_targets.reader_target_for_citation_target`
(`python/nexus/services/resource_graph/reader_targets.py:63-80`) maps any readable
media span through `locator_from_resolution` without the `status == "resolved"`
gate that search applies. a pdf page with no dims yields a `no_geometry` span
whose selector has no quads (`python/nexus/services/content_indexing.py:358-368`), and
`PdfPageGeometryLocator.quads` requires at least one
(`python/nexus/schemas/retrieval.py:391`). pydantic's `ValidationError`, a
`ValueError`, escapes the `except NotFoundError`.

evidence: reproduced at the service layer on the pr-05 harness corpus (pdf page 2
dims nulled, reindexed): `reader_target_for_citation_target(evidence_span:<pdf#2>)`
raises `ValidationError ... pdf_page_geometry.quads List should have at least 1
item after validation, not 0`. the pdf#1 span resolves. pr-05 does not change
this path, so main behaves the same. not yet reproduced through a route.

callers that would 500: `resource_graph/citations.py:272` (citation projection for
a page of edges) and `reader_connections.py:169,191` (reader connections for an
`evidence_span` or `content_chunk` ref). chat citations come from search, which
drops such spans; media intelligence claims, dossier, synapse or oracle citations
and user links may not.

fix: gate on `resolver.status == "resolved"` and return `(media_id, None)`
otherwise, so the chip still opens the media.

acceptance: a citation or connection to a no-dims pdf span renders and jumps to
the media without a 500.
