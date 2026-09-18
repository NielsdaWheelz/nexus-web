# two applied data migrations keep service helpers alive

status: open (decision needed) · origin: 2026-09-17 slop sweep (claude session)
· area: canonicalize service · oi-150

`python/nexus/services/canonicalize.py:332-488`
(`repair_historical_html_structure`, `repair_epub_body_anchor`) and `:247-286`
(`generate_canonical_text_with_element_offsets`, with the `element_ids` /
`raw_offsets` fields of `_CanonicalTextTarget` at 139-142 and the capture loop
at 182-185) have no product caller. `repair_historical_html_structure` and
`repair_epub_body_anchor` appear only at their defs and in
`migrations/alembic/versions/0228_reader_semantic_structure.py` (import + one
call each). `generate_canonical_text_with_element_offsets` is called at
`canonicalize.py:260` with a literal `set()` — so `raw_offsets` is always empty
and the function always returns `_canonical_text_without_sources(raw_text), {}`
— and by `migrations/alembic/versions/0208_persist_epub_navigation_offsets.py:37,96`.
their own docstrings say they are one-time persisted-HTML repairs, never
ingestion fallbacks. about 195 lines.

moving them into the migrations does not work: both bodies call the module
privates `_CanonicalTextTarget` (136), `_canonical_structure` (305) and
`canonicalize_structure` (290), so a verbatim move drags roughly 150 private
lines into 0228 or makes the migration import privates — and 0228 already
imports live product code anyway. the only real deletion is gutting an applied
data migration.

production is at 0230. a fresh dev database replays 0208 and 0228 over zero
rows, so gutting them is behaviourally inert except when upgrading a restored
pre-0228 dump that still holds real data.

decision: may applied data migrations be gutted on this box?

prerequisite: the owner's answer. treat both items as one decision.

fix: if yes, delete both repair functions, replace
`0228_reader_semantic_structure.py:38-50` (`_repair_historical_fragment`) with a
plain read of `html_sanitized` and drop its repair block at 585-600; inline the
empty-`element_ids` path into `generate_canonical_text`, delete
`generate_canonical_text_with_element_offsets` and the `element_ids` /
`raw_offsets` fields, and remove the `generate_offsets` parameter and import
from 0208. keep `_canonical_text_with_offsets` — `_canonical_structure` still
uses it. if no, leave all of it and close this ticket as decided.

acceptance: either no service helper survives solely for an applied migration,
or the retention is recorded as a deliberate restore-path guarantee.
