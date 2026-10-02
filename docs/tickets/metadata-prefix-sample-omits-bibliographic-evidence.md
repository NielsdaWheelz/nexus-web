# normalized metadata input needs live research qualification

status: open
origin: 2026-10-01 metadata council; checkout a494f743eb402b0cbb6069066fca4143b24036f0
area: metadata input construction

2026-10-02 candidate: 1,000 normalized opening words, complete credits and the
whole utf-8 budget pass local checks. useful ordinary research and follow-up reads
remain NOT_RUN. the evidence below describes the baseline; the remaining fix is
live qualification, not another context builder.

problem: the default sample is 2,000 characters (`python/nexus/config.py:403–405`), sliced before cleanup and selected from only the first nonempty source tier (`metadata_enrichment.py:178–243`). raw markup consumes the window; titles, copyright pages and identifiers outside the prefix are absent from the initial packet. the prompt asks the model to compensate through local tools but acceptance does not establish that it did. this is a research-quality gap, not the cause of the eight failed production lewis jobs.

fix: supply known metadata and about 1,000 normalized opening words through the existing sampling owner; preserve bounded source reads and bound the complete encoded input. let the model use existing local/web tools when it needs more. the owner rejected a dedicated bibliographic evidence-packet builder and front-matter classifier; neither is required. see `../metadata-enrichment-plan.md`.

acceptance: representative books/collections/essays get the larger normalized opening within the wire budget; ordinary live runs demonstrate useful metadata and follow-up reading where needed. no universal optimum or historical accuracy is inferred from the sample size alone.
