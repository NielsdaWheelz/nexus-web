# transcript highlight relocation requires a nonexistent generation

transcripts have no reader publication generation. `update_highlight` in
`python/nexus/services/highlights.py:1047` rejects every cross-fragment relocation
with a null generation, including an unresolved transcript quote after canonical
transcript replacement. the current reader supplies null correctly.

permit null only for podcast/video transcript relocation under the existing media
lock. retain the unresolved-only restriction, exact-quote comparison, current
fragment membership, offset validation and expected highlight version. prose still
requires its publication generation.

resolved by relocating an unresolved transcript highlight to matching current
text after canonical replacement, retaining its identity and note, while stale
fragment ids and null-generation prose remain refused.
