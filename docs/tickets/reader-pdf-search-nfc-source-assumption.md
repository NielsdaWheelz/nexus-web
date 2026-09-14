status: open
origin: 2026-09-13 bounded publication review
area: retained pdf quote search / canonical coordinates

`python/nexus/services/reader_publication_search.py:1` assumes all canonical
source is already nfc and only collapses whitespace. pdf ingestion does not
establish that invariant: `pdf_ingest.py:233` normalizes line endings and
whitespace but never applies unicode normalization. `text_quote.py:133`
normalizes to nfc; its comment claiming every owner is already nfc is false for
this producer. a decomposed pdf quote can therefore miss a composed selector;
normalizing retained text without an exact raw-coordinate map can also shift
the returned span and lose combining marks.

prerequisite: distinguish raw literal pdf matching from normalized passage
matching. preserve retained raw bytes and exact page spans; establish an exact
normalization-to-source map for normalized search, or prove another existing
producer guarantees nfc before storage. do not relabel current content as an
old generation or silently alter old coordinates.

acceptance: actual pdf producer with decomposed accents and cross-chunk
combining sequences; composed selectors resolve exact retained source spans,
literal matching stays literal, and replacement generations cannot change the
old result. source and query memory stay within the qualified envelope.
