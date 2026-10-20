# public search builds typed candidates and then rehydrates items

status: open; cost, not a defect · origin: resource references re-slice (Q7, N13), 2026-10-19 · area: search retriever

`python/nexus/services/search/project.py:126-280` builds typed candidates (captured
evidence, activations, attributions) for every hit; `search/presentation.py:20-94`
then discards them and reads the hits again through
`resource_items.items.resource_items_out`, so a public search page pays for two
projections. the candidates serve chat retrieval and discovery; the item projection
serves every surface.

impact: extra reads per search page; no wrong result.

decision (re-slice Q7): keep one item projection for every surface rather than a
second "what is it" derivation beside items.

resolved when: public search projects each hit once (either the candidates stop being
built for public search, or presentation reuses them without a second derivation),
with the H2 search shape journey unchanged.
