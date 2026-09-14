# synthetic epub sections have durable references to migrate

status: open
origin: 2026-09-11 reader-map spec adversarial review
area: structure cutover and locator preservation

`python/nexus/services/content_indexing.py:770-785` copies navigation ids,
including synthetic spine sections, into fragment content locators/selectors.
`:442-534` propagates locator data into chunks/evidence. deleting synthetic
section rows while migrating only reader cursors leaves obsolete navigation
hints in otherwise valid persisted passage records.

prerequisites: census owned references before removing synthetic section rows.

proposed fix: migrate removed synthetic section references in content block,
chunk, evidence, retrieval, and passage selector metadata within the same
hard-cut transaction. remove obsolete section hints where the exact fragment
address survives. preserve fragment/offset identity, source anchors, quote,
provenance, and row ids. abort records without a provable exact address.

acceptance: formerly unsectioned imports remain readable, saved passages and
citations resolve exactly, and no retained navigation consumer references a
deleted synthetic section. no source re-ingest or fuzzy repair occurs.
