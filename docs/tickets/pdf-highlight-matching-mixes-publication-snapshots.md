# pdf highlight matching mixes publication snapshots

status: open · origin: 2026-09-17 package typecheck cleanup, base `352653689` · area: pdf highlights · oi-167

`pdf_highlights.py:_compute_write_time_match` uses cached `Media.plain_text`,
but `is_pdf_quote_text_ready` and `_get_page_span` query current database rows.
nonempty cached text can therefore be matched with a replacement publication's
page offsets. the resulting prefix/suffix and stored match offsets can be wrong.

the same snapshot gap affects `media_read_map.py:247-280`: `read_page_range`
loads text, then checks readiness and fetches page bounds in separate statements.
replacement text/spans published between those reads can select the wrong text.

`media_source_ingest.py:2060` permits source refresh from `ready_for_reading`;
`pdf_lifecycle.py:96` and `pdf_ingest.py:1844` replace text and spans under the
reader publication owner's media-row lock. highlight matching takes no matching
snapshot fence. the current typecheck fix handles cached missing text as pending;
it does not make nonempty cached text and fresh spans coherent.

fix: first reproduce a reader session retaining old nonempty text while another
session publishes new text/spans. choose one coherent publication read at the pdf
highlight write owner. preserve ordinary create/update/no-op/conflict behavior.

acceptance: that reproduction stores quote context and offsets from one complete
publication; no mixed old-text/new-span match is possible.
the public page-range reader must also select text and bounds from one publication.
