# reader repair compares element ordinals

`reader_publication.repair_reader_html` compares `CanonicalStructure.anchors` and
`apparatus_items` directly. those maps contain internal element indices, not
canonical coordinates. normalizing salvatier's leading table prose adds a flow
wrapper; later heading indices change although their canonical ranges do not.

the real repair refused at `reader_publication.py:409`; offline proof preserves all
13,385 canonical characters and heading ranges `0..2`, `5084..5109`, `7223..7293`.
compare each named target's complete canonical range, retaining exact keys, full
text and x-slot checks. no reference or source capture may be rewritten.

resolved when real reader repair, retained-reference resolution and the mounted
reader's generation replacement pass without relaxing their coordinate proofs.
