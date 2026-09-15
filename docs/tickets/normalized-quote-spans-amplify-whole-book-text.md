# normalized quote spans amplify whole-book text

status: open · origin: 2026-09-15 restoration memory investigation · area: reader quote resolution · oi-123

## evidence

source `6baccaee9c053b10f46fb5e270e73f5bc12b5026`:
`python/nexus/services/text_quote.py:133-151` builds a Python character list and
one tuple of integer offsets per normalized character.
`load_normalized_media_sources` at lines230-251 fetches and retains normalized
text for every fragment of the media. reader passage-anchor projection reaches
this owner through `reader_connections.py:321`; missing highlight fragment-cache
repair reaches it through `highlights.py:718`.

this is source-proven memory amplification, not the established cause of
oi-116. the affected production book and article have no passage anchors;
their existing highlights alone do not establish a stale-cache repair.

## next action and acceptance

replace per-character Python tuples/integers with compact offset storage while
preserving exact normalized matching, ambiguity, raw offsets and context.
prove whitespace and unicode behavior through cheap deterministic regressions
and measure a representative full-book quote resolution on the devbox. retain
request-scoped reuse; do not introduce a cross-request book cache.
