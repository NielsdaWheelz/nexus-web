# reader apparatus read path carries incidental validation

status: open (for the reader read half, 13b)
origin: 2026-10-20 reader python ingest re-slice (spec N6, N9, design Q6)
area: reader python, apparatus read path

the ingest re-slice left the read path byte-identical. two incidental patterns
remain there for the read half to cut:

- N6: apparatus rows are validated through pydantic `*Out` models and then copied
  field by field into twin dataclasses that are never serialized
  (`python/nexus/services/reader_apparatus.py` read functions), about 40 lines.
- N9: `python/nexus/services/epub_read.py` re-validates its own rows (a
  `ValueError` on an unknown resolution, unpaired extents), about 25 lines; census
  C7 decides whether the guards can go.

resolved when the read half re-cuts these functions against the read model's
contract (no response shape changes), and the reauthoring rows are recounted.
