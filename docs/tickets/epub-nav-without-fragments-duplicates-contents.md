# epub nav without fragments duplicates contents

status: open · origin: 2026-09-24 reader-inspector-controls live verification, branch `reader-inspector-controls` · area: epub ingest / reader contents

an epub 3 whose nav hrefs name whole spine documents (`ch1.xhtml`, no
`#fragment`) is not merged with each document's leading heading. navigation
returns every chapter twice (publisher section + heading section): contents
lists each title twice and the counter reads `1 / 10` for 5 chapters. the
publisher sections bind to heading elements only through href fragment anchors
(`python/nexus/services/epub_structure.py`). this is a common real-world shape.

fix: bind a fragmentless publisher entry to its spine document's leading
heading (or to the document start) so one section results.

acceptance: an epub with fragmentless nav hrefs shows each chapter once in
contents and the counter counts chapters.
