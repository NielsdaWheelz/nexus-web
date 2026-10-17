# failed gutenberg epub retains the obsolete web adapter

status: open mechanism; historical per-id recovery obligation retired
origin: 2026-09-26 processing-failure investigation
area: source admission / recovery

production `7dc68929b4d5ddfd77eb1a50228d477fa0148b5d`, database `0241`:
media `08d23b86-7042-4c72-bfe6-7faa5a696bee` failed on
`https://www.gutenberg.org/ebooks/38145.epub3.images` as `generic_web_url`,
kind `web_article`, with `E_INGEST_FAILED` on 2026-07-03.
current source `702ba2b826` recognizes this suffix during fresh URL admission
(`services/remote_file.py:23-46`, `services/media_source_ingest.py:126-133`).
`media_source_ingest._admit_successor:593-620` still copies the prior source type;
`retry_source:634-673` uses it, and `source_adapters.acquire:86-95` dispatches
`generic_web_url` to article acquisition. this establishes the conditional
mechanism, not a surviving current reproduction.

the historical media and original were subsequently removed by successful
ordinary teardown. its recovery obligation is retired; do not fetch or
resurrect it. evidence: `book-repair/coordinator/missing-originals-current-deletion-disposition.json`,
sha256 `c71f1e37272b5c04680e104a07de32ab86db01bcbc072d7b3f23273fd031caa8`.

prerequisite: demonstrate the adapter mismatch on a surviving current failed
attempt and inspect its filing/reader state. repair through explicit
owner-controlled reclassification or a linked
replacement epub acquisition. preserve filing and historical identity; do not
silently mutate a published document's kind or repeat the article fetch.

acceptance: a reproduced surviving case reaches the epub owner, publishes a
readable book, preserves intended filing and leaves no misleading failed
duplicate. the deleted example is not a recovery target.
