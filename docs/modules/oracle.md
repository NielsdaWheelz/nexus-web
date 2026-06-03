# Oracle

Oracle has two service owners.

`python/nexus/services/oracle.py` owns readings: question validation, corpus and
library retrieval, plate selection, LLM prompt/call/parse, persisted folios, and
SSE event emission.

`python/nexus/services/oracle_plates.py` owns plate assets: URL construction,
metadata lookup, content-addressed storage-key validation, ETag metadata, and
integrity-checked storage reads.

## Plate Contract

- Frontend URL: `/api/oracle/plates/[id]`.
- Backend URL: `/oracle/plates/{id}`.
- Frontend type contract: `OraclePlateImageSrc`.
- BFF helper: `proxyPublicToFastAPI`.
- Backend route auth: internal header only; no viewer bearer and no cookies.
- Storage key: `oracle/plates/<64 lowercase sha256>.<jpg|png|webp>`.
- DB owner: `oracle_corpus_images`.

`oracle_plates.py` releases the DB session before reading object storage. Matching
`If-None-Match` requests return `304` from validated DB metadata without touching
storage.

## Operational Rule

Oracle seed objects are deployment preconditions. The backend deploy runs
`ensure_oracle_seed_objects.py` before Alembic. Runtime request handlers do not
seed, repair, or fall back to fixture files when an owned plate object is missing.
