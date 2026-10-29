# epub long-text whitespace projection

a valid whitespace-heavy epub can fail before publication with
`E_SOURCE_NOT_READABLE: EPUB structural capture changes sanitized source text`.
lab `20261028-155603-cceb060a3c95`, media
`01a184bb-f762-741f-91e6-3be168dbde02`, attempt
`01a184bc-056f-75dd-a3ed-d2a3f801cca2`: one paragraph containing about 2 mib of
`a  ` repetitions failed `services/epub_structure.py:182`. no excerpt capture ran.

the existing canonicalizer collapses whitespace independently in each libxml
`data` callback (`services/canonicalize.py:214-217`). a long text node can span
callbacks; adding structural attributes can move those boundaries. this is the
suspected cause, pending isolated confirmation. paths are under `python/nexus`.

repair must preserve the canonical coordinate contract: callback boundaries
cannot become source boundaries, while real inline text-node boundaries retain
their existing semantics. inventory stored publication equivalence before
changing canonical policy; do not silently recanonicalize stored offsets.
resolved when the actual long-node epub publishes unchanged literal text and
stable canonical coordinates before/after structural capture, with existing
publication compatibility explicitly proved or repaired by its source owner.
