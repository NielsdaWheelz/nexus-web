status: open
origin: 2026-09-13 bounded workspace native conversion review
area: publication / legacy migration capacity

`python/nexus/services/reader_publication_units.py:_index` permanently rejects
source attributes above the candidate unit-byte bound. the existing epub
sanitizer (`epub_ingest.py:_sanitize_epub_attributes`) retains allowed values;
its structural limits bound entry bytes/counts, not each attribute's bytes.
the native migration tokenizer can also buffer one complete attribute value.
streaming ordinary text does not prove this case. this is a contract/source
finding; no memory-kill reproduction is claimed.

inspect existing producer limits and supported installed data. qualify surviving
maximum values or define an explicit bounded display representation preserving
authored source and canonical locations. do not silently truncate a meaningful
attribute or use permanent capacity rejection as a completed migration.

acceptance: a maximum supported retained attribute either traverses through the
qualified reader/converter profile or has an explicitly reviewed, lossless
source-preserving display contract; retained installed data remains recoverable.
