# servers that send brotli regardless read as unreadable

status: open, design risk 5; no runtime probe.
origin: 2026-10-10 url acquisition reauthor (branch cleanup/url-acquisition-reauthor, base d287e91f7).
area: ingest / web articles.

the article profile asks for `Accept-Encoding: gzip, deflate`
(`python/nexus/services/web_article.py` `_REQUEST_HEADERS`); python has no
brotli decoder installed, so `br` was dropped from the header node used to send.
a server that ignores `Accept-Encoding` and answers `Content-Encoding: br`
yields bytes `safe_stream` passes through undecoded (it inflates only gzip and
zlib); the node filter sees binary, finds no article, and the import settles as
`E_SOURCE_NOT_READABLE` (before the rewrite node decoded it).

fix, if such servers are seen: add the `brotli` package, a bounded `br` branch
beside the inflate in `safe_stream`, and restore `br` in the header; or refuse
an undecodable `Content-Encoding` in `safe_stream` as its own failure.

acceptance: a page served only as `br` imports, or fails with a code naming
the encoding.
