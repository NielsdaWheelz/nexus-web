# partial table selection gives a generic reason

the reference-quotes content contract requires `select the whole table to quote
it.` for an incomplete table. the browser refuses such a selection before any
draft or server admission: `python/nexus/services/reader_text_slice.py:150-151` marks structurally cut
tables `data-nexus-incomplete-table="true"`, then
`apps/web/src/lib/documentReader/text/excerpt.ts:63` formerly threw the
undifferentiated `UnsupportedExcerpt`. `text/geometry.ts:362` folded that into its
generic rejection, so `DocumentReader.tsx` could not show the specific instruction.

impact: legitimate browser selection preserves table completeness but gives the
wrong refusal copy. the server's `E_READER_SELECTION_PARTIAL_TABLE`
(`python/nexus/services/resource_items/evidence.py:396-398`) is unreachable on that native
path because no capture exists to submit.

the current change preserves the refusal and carries a typed partial-table reason
through native excerpt capture, geometry and the reader's existing feedback.
browser and server qualification remain pending. prove the
specific copy before any draft, retain whole-table capture, and separately prove
the server's authority check on real clipped reader data. resolve after those
browser and server checks pass; do not admit a partial table to reach the server.
