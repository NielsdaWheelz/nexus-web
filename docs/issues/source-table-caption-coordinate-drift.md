# stored table captions still need a publication repair

open data repair; the producer and excerpt adapters were repaired in
`e6ef89a08` (#913). that does not rewrite the stored salvatier fragment
`045c00fa-6c5a-4092-ace0-0fb22b69536a`, media
`d6204c4c-914a-425c-bd7b-732e48d32459`.

the 2026-11-05 production preflight found canonical text of 13,385 characters
but html5 text of 13,383: a newline was lost before each loose table caption.
generation was 1, with no pinned pieces or epub navigation paths and two
`fragment_tables` projections. those are historical observations to recheck,
not permission to assume the current rows are unchanged. the discrepancy can
invalidate reader coordinates even when metadata research succeeds.

use the existing `python/scripts/repair_reader_html.py` publication repair,
under [metadata release](release-metadata-update.md). preserve canonical bytes,
fragment ids/order, anchors, offsets and historical captures; rebuild table
paths and atomically advance generation when html changes. the current
[reader contract](../modules/reader-implementation.md) owns publication identity.
keats' separate excerpt adaptation needs no stored-reader rewrite.

resolved after a fresh preflight, actual browser/parser agreement, retained
reference resolution and mounted-reader replacement at the new identity, with
rollback on any failed repair proof. no production repair was performed in this
cleanup.
