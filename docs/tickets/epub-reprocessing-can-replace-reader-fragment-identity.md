# epub reprocessing can replace reader fragment identity

status: open
origin: 2026-09-26 processing-plan adversarial review
area: source recovery / reader identity

`python/nexus/services/epub_ingest.py:445` assigns fresh fragment ids;
`publish_epub_extraction_plan` at line 558 deletes/replaces previous fragments.
`services/media_source_ingest.py:210` recovery eligibility does not inspect
existing publication or reader state. failed status alone cannot prove a safe
republication. this is a static preservation hazard; current affected rows have
not been established.

the processing plan guards its new operator admission and preflights all epub
repairs. before supporting previously published epub reprocessing, census reader
state and define preservation in the existing publication owner; never reset
positions or discard anchors to admit recovery.

acceptance: temporary real-stack republication preserves existing fragment
identities, cursor positions and anchored content, or refuses without writes;
the actual recovery inventory records which case applies.
