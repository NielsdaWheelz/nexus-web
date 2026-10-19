status: open
origin: 2026-09-12, reader document map cutover review
area: epub source url encoding

`python/nexus/services/epub_ingest.py:_rewrite_resource_url` writes a decoded
archive path directly into `href`. `epub_read.py:rewrite_epub_fragment_links`
then parses that value as a url. a literal archive filename `chapter#note.xhtml`
becomes indistinguishable from resource `chapter` with anchor `note.xhtml`;
literal `?` has the same problem. removing duplicate percent decoding does not
repair this lost distinction.

prerequisite: original epub bytes for any already-imported ambiguous source.
encode archive paths when serializing urls and decode exactly once at the url
boundary. repair old ambiguous links from their original source; never guess
between a filename and a fragment. preserve canonical text, fragment identities,
and accepted progress, and publish the corrected source atomically.

acceptance: authored epubs with literal `#`, `?`, and `%` filenames navigate to
the exact resource and anchor in hosted and offline readers. an old ambiguous
link without recoverable source aborts repair without changing persisted state.
