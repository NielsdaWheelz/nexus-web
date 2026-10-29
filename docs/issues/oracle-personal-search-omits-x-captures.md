# oracle personal retrieval omits x capture chunks

status: open; pre-existing at main `96a3b7bdf` and search `81f08f4c3`.

`python/nexus/services/oracle/readings.py:254-259` admits only media and note-block
owners in `_PERSONAL_CHUNKS`. `content_indexing.reading_chunks_sql` also admits
current immutable x-capture fragment chunks through canonical reading membership.
the oracle personal lane therefore omits eligible captured text. existing oracle
or common-vector proofs do not establish personal x-capture coverage.

repair at the personal eligibility and attribution owners: compose canonical
viewer/readable reading-chunk membership, preserve the corpus exclusion and
dedupe/reading attribution, then project valid captured evidence and activation.
adding `fragment` to a kind allowlist alone would neither authorize occurrences
nor provide correct source attribution. do not widen the domain without those
proofs.

resolved when a normal current-ready capture yields a personal passage through
an authorized reading, unauthorized/corpus-excluded captures remain absent, and
repeated capture occurrences retain the intended owner/dedupe and navigable
evidence. retain full cosine/model/publication semantics and verify with the
existing isolated workflow. this integration records the gap; it does not repair
or qualify that lane.
