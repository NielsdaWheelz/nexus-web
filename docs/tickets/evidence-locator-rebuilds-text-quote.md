# evidence locator rebuilds the text quote

status: open · origin: 2026-09-28, pr-05 cleanup/search-locators review (claude session) · area:
search / locator resolver

`locator_resolver.py` builds a span's text quote twice from `selector.text_quote`.
`evidence_resolution` (`python/nexus/services/locator_resolver.py:281-287`) builds the
highlight's quote; `locator_from_resolution` (`:416-421`) builds the retrieval locator's
`text_quote_selector` (and the pdf `exact`/`prefix`/`suffix`). they normalize a missing
`prefix`/`suffix` differently: `""` in the highlight, `None` in the locator. every
current writer (`content_indexing._text_quote`, the `prefix: ""` literals in
`content_indexing.py` and `note_indexing.py`) writes all three keys as strings, so the two
agree today; a change to one builder, such as trimming `exact`, would silently split the
evidence-route highlight from the search and citation locator.

prerequisite: `reader_targets` calls `locator_from_resolution` without a status gate, where
`highlight` is `None` for an unresolved span, so the locator cannot simply read
`resolver.highlight.text_quote`. settle that first
([citation-target-pdf-without-geometry](citation-target-pdf-without-geometry.md)).

fix: `evidence_resolution` returns the quote once at the top level; the highlight and
`locator_from_resolution` both read it. pick one normalization for a missing
`prefix`/`suffix` (`""` matches every writer).

acceptance: one quote builder in `locator_resolver.py`; search and
`GET /media/{id}/evidence/{span}` return the same json as before for writer-produced spans.
