# highlight captures cannot reproduce reader source structure

problem: highlights retain canonical strings and locations, but no source
structure. canonical text is a coordinate system, not a faithful excerpt format.

evidence: source audit at `58e135bf2958bab8ca12971cb3984f77c01c2e66`,
2026-10-28; no browser reproduction. `python/nexus/services/canonicalize.py:1-17,210-213`
collapses whitespace and represents block boundaries and hard breaks alike.
`apps/web/src/lib/canonicalText/domTextCursor.ts:100-145,179-210` mirrors that
mapping. `apps/web/src/lib/documentReader/annotations.ts:140-151` captures slices
of canonical text; `node/authored/src/types.ts:25,35-36` retains no rich excerpt.
pdf capture supplies null prefix/suffix at `annotations.ts:130-134`.

impact: paragraph spacing, hard breaks, lists, emphasis and preformatted
indentation cannot be reconstructed reliably from saved quotes. source whitespace
collapsed into one canonical character also makes partial whitespace selections
impossible to reconstruct from canonical offsets alone.

retain a bounded excerpt from the mounted source with its selected range and
publication in the existing atomic capture. use the reader's sanitized structure
and typography contract; leave canonical coordinates and matching identity stable.
`python/nexus/services/reader_text_slice.py:101-172` provides a useful clipping
invariant but handles element-edge cuts, not arbitrary selection endpoints.
the authored grammar must own accepted excerpt structure: `HtmlRenderer.tsx:2-7`
under `apps/web/src/components/` currently trusts only sanitized api-owned html.
new capture fields also require a coordinated persisted-format conversion;
`python/nexus/services/authored/__init__.py:220-230` forbids changing accepted
command values, so pending retries cannot be rewritten in place.

resolved when source-structure examples survive capture, restart, sync and source
replacement with faithful rendering and copy. prove partial preformatted and
unicode selections, and define pdf fidelity explicitly. historical data must not
claim recovered formatting without provenance proving the original source.
