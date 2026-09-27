# local worker image misses the local node ingest path

status: open; origin: 2026-09-26 reader-reversible-navigation live setup, branch `feature/reader-reversible-navigation`; area: worker / local development

the local worker image carries `/app/node/ingest/ingest.mjs`, but `local_node_ingest_command()` in `python/nexus/services/node_ingest.py:73-81` resolves `/node/ingest/ingest.mjs` from `/app/nexus/services/node_ingest.py`. a normally submitted url import failed with `NodeIngestProtocolDefect: Node ingest script is unavailable` and `E_WORKER_CHILD_DEFECT` in `nexus-reader-nav-worker-background` on 2026-09-27 01:30 utc. browser-capture article packets use another ingestion path.

prerequisite: decide whether the local worker image is a supported composition. if so, make the local command resolve the image-baked script while retaining checkout behavior through an explicit, single composition boundary. do not conceal a missing script with a fallback. acceptance: a normally submitted url article reaches a terminal ingestion result under the documented local worker image.
