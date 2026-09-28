# nexus retrieval defects replace the whole workspace

status: deferred (owner decision) · origin: 2026-09-28 nexus launcher rewrite (size/nexus-launcher-web), verified finding F19 · area: nexus / error policy

`useNexusFind.ts` throws in render when the openables or search response fails its hand
decoder (`ResourceOpenablesContractDefect`, `SearchContractDefect`) or is a same-system
defect such as `E_INTERNAL` (`isSameSystemApiDefect`). the workspace error boundary then
replaces every pane with "The workspace couldn’t load". locally `GET /search` answers 500
without an embeddings key, so typing two characters into the Nexus takes the workspace down
on any box without `OPENAI_API_KEY`. `docs/rules/boundaries.md` prescribes treating
same-system violations as defects, so demoting them to a per-source Retry contradicts the
mirrored rules.

impact: one failing read route takes down the whole workspace, not just the Nexus results.

prerequisites: an owner decision on the boundary rule for read-only, optional sources.
typing the two routes ([nexus-consumed-search-routes-keep-hand-decoders](nexus-consumed-search-routes-keep-hand-decoders.md))
removes the decoder defect classes either way.

fix (if accepted): show a per-source failure row with Retry for `E_INTERNAL` on openables and
search, as the transport codes already do; keep throwing for genuine contract mismatches.

resolved when: the owner has decided; if accepted, a 500 from `/search` shows a Retry in
the Nexus and leaves the workspace intact.
