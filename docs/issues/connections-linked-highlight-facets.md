# an owned highlight and its link do not share facet membership

the companion-density content contract says a linked highlight counts under both
highlights and links and survives while either facet is enabled. the inherited
model does not supply one such root: `media/[id]/annotations.ts:54-55` removes
owned remote highlights and authored facts; `evidence/EvidencePane.tsx`'s
`entryFacets` gives local highlights only highlights and local links only links.
adding an owner-media link creates a separate local link occurrence.

impact: the new glyph facets retain this behaviour, but the contract's example
is unmet. the lab's linked-highlight fixture has children; it does not demonstrate
dual facet membership. remote multi-facet filtering is source-reviewed only.

resolved when: the annotations/evidence owner defines one occurrence and count
contract for a highlighted-and-linked item, and real toggles demonstrate that
contract without duplicate roots or counts. changing authored root composition
is outside the density work.
