# failed gutenberg epub retains the obsolete web adapter

status: open
origin: 2026-09-26 processing-failure investigation
area: source admission / recovery

production `7dc68929b4d5ddfd77eb1a50228d477fa0148b5d`, database `0241`:
media `08d23b86-7042-4c72-bfe6-7faa5a696bee` failed on
`https://www.gutenberg.org/ebooks/38145.epub3.images` as `generic_web_url`,
kind `web_article`, with `E_INGEST_FAILED` on 2026-07-03.
`services/remote_file_ingest.py:15-22,33-40` now recognizes this epub suffix,
but `services/media_source_ingest.py:610-634` clones the old source type and
payload on retry. the offered retry therefore preserves the wrong adapter.

first inspect the current remote artifact and any existing filing or reader
state. repair through explicit owner-controlled reclassification or a linked
replacement epub acquisition. preserve filing and historical identity; do not
silently mutate a published document's kind or repeat the article fetch.

acceptance: this exact source reaches the epub owner, publishes a readable
book, preserves intended filing, and leaves no misleading failed duplicate.
