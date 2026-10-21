# the web apparatus budget refuses long articles

status: open (owner: raise the budget or keep it)
origin: 2026-10-20 reader python ingest re-slice (design Q4)
area: reader python, web article structure

`prepare_web_article_fragment` indexes note targets with
`max_retained_utf8_bytes=WEB_ARTICLE_HTML_MAX_BYTES` (2 MiB,
`python/nexus/services/web_article_structure.py`). retained text counts each
target's body, html and backlinks, so ordinary notes cost ~600 bytes and the cap
binds near 3,000 notes, long before the 10,000-target count. since the re-slice
a breach is `E_RESOURCE_LIMIT` (Output), settled at once; before, it was
`E_SANITIZATION_FAILED` "Article could not be prepared".

impact: the readable wikipedia *Alan Turing* article (912 KB, 422 notes,
2.33 MiB retained from a 1.3 MB source) cannot be added, nor can a 0.32 MB
article with 3,000 short endnotes. evidence:
`2026-10-20/rpy/corpus/web-readable-wiki-turing/article.json` (offline identity
case), harness `prep/probe_mem.py`, journey F6.

resolved when the owner decides: keep (this file is deleted with the decision
recorded) or raise the budget with a measured memory envelope for the 448 MiB
background worker.
