# restored-runtime generation catalog unavailable

browser126 records25 `/llm-catalog`503 responses, all
`E_GENERATION_RUNTIME_UNAVAILABLE`; the owner catches `CatalogUnavailable`.
the retained logs do not expose the lower cause. successful query embeddings do
not establish generation-runtime capability.

impact: this restored search run cannot establish normal generation/catalog
operation or traffic. private evidence:
`.nexus-local/search-qualification/runtime126-client/api-diagnostic.private.log`.
resolve with a bounded check of the existing catalog owner and required runtime
configuration before claiming ordinary deployed-host overlap. search ranking
changes do not repair this separate capability.
