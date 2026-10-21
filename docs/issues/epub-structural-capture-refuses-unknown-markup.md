# the epub structural capture refuses books with unknown markup

status: open
origin: 2026-10-20 reader python ingest re-slice (spec L13, design Q14)
area: reader python, epub structure

`bind_epub_source_structure` (`python/nexus/services/epub_structure.py`) marks
every source element with a temporary id, sanitizes the marked copy and requires
its canonical text to equal the unmarked source's. the epub policy turns an
unknown element that carries an id into a `span` and unwraps one without, so the
marking itself changes the capture where the source has id-less unknown
elements (mathml): the whitespace around them differs and the book is refused
`E_SOURCE_NOT_READABLE` "EPUB structural capture changes sanitized source text".

impact: such books never import. evidence: the idpf `linear-algebra` sample
(`2026-10-20/rpy/corpus/idpf-linear-algebra/book.epub`), refused on main and on
the re-slice alike; probes `2026-10-20/rpy/sketches/probes/q_capture.py`.
marking only retained elements fixes the span half, but the book still differs
inside mathml whitespace, so a sound fix needs its own proof.

resolved when `linear-algebra` imports with its structure bound, the identity
corpus shows no other change, and the capture still refuses an ambiguous
correspondence.
