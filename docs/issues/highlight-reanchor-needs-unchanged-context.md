# a highlight re-anchors after refresh only with unchanged context

status: open (reader read half, 13b)
origin: 2026-10-20 reader python ingest harness (`2026-10-20/rpy/harness/defects.txt` N7)
area: highlights / text quote matching

after a web article refresh a highlight re-anchors by quote only if its
64-codepoint normalized prefix and suffix are unchanged:
`find_quote_candidates` (`python/nexus/services/text_quote.py`) uses them as
filters, not as tie-breakers. removing a footnote marker in the sentence before
the highlight left it on the deleted fragment's id at its old offsets after the
document map's repair.

impact: a refreshed article silently loses highlights whose neighbourhood
changed though the highlighted text is intact. evidence: harness journey
`R3.article-refresh-republishes` (first version), `prep/renorm.mjs`.

resolved when a highlight whose exact text survives once in the refreshed
fragment re-anchors there even when its prefix or suffix changed, and an
ambiguous exact still stays unanchored.
