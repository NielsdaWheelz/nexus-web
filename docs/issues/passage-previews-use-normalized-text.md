# passage previews render normalized matching text

problem: reusable passage previews can flatten captured words and context because
their display reads the normalized identity selector rather than literal capture.

evidence: source audit at `58e135bf2958bab8ca12971cb3984f77c01c2e66`,
2026-10-28; no browser reproduction. `node/authored/src/types.ts:35-36` separates
`capture.quote_exact` from normalized identity fields, but
`python/nexus/services/authored/projections.py:132-180` projects only normalized
exact/prefix/suffix into `passage_anchors.selector`. resource previews read those
fields at `python/nexus/services/resource_items/items.py:531` and construct a
captured quote from them at `python/nexus/services/resource_items/locations.py:658-662`.

impact: the same passage can retain line breaks in authored capture yet lose them
in its displayed quotation. normalized context also loses boundary whitespace.
this differs from the identity ambiguity in
`passage-materialization-drops-captured-context.md`.

repair at the passage projection contract: keep matching identity separate from
the frozen excerpt and display only the latter. preserve the existing passage id.
resolved when a captured multi-paragraph passage survives local commit, sync,
reload and downstream quotation with its words and breaks intact while normalized
matching still resolves the intended occurrence.
