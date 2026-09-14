status: open
origin: 2026-09-13 bounded evidence implementation audit
area: retained reader evidence / passage quote resolution

`passage_anchors.resolve_current_location` loads the complete stored selector and
`locator_resolver.resolve_passage_selector` resolves normalized source text. the
quote has no 512-codepoint bound. `reader_publication_resolve.py`'s new cursor
selector query intentionally serves a different, bounded reader-resume contract.
using it directly would narrow existing authored passage anchors; treating a
foreign/missing locator_hint as no match would also regress uniquely locatable
quotes. hints are supplemental geometry, not the source of anchor identity.

implement an anchor-id + selected-generation query at the existing quote owner:
read bounded candidate prefixes/coordinates, verify arbitrarily long stored
quotes against bounded normalized source chunks, and return only exact scalar
locations or actual ambiguity/no-match. preserve normalization and original
canonical coordinate mapping. no full Python quote/source hydration, no inferred
current generation, no new 512 limit or silent loss of known locatable facts.

acceptance: long unique quotes, changed hints, repeated/ambiguous quotes,
cross-unit whitespace and astral text agree with the existing semantic oracle;
maximum source/history queries qualify before exact evidence ordering/counts and
overview projections claim readiness.
