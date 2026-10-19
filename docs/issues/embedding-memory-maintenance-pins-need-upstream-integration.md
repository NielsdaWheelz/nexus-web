# integrate the embedding import fix upstream

status: open · origin: 2026-09-15 pr #270 · area: dependency maintenance · oi-133

nexus consumes provider-runtime97fbac7fece4f1ea54651b7d6344df9fac3b2791,
based on its existing df12d54 revision. only runtime.py changes: generation
engines load on first generation use, leaving embeddings independent.
kernel0c400beeae075ee47e7a8563d00f9117e920380e, based on86504b5, changes only
the matching provider requirement and lock. both immutable commits are on
`maintenance/nexus-embedding-memory` in their respective upstream repositories.

these are published maintenance revisions, not merged upstream main. the newer
provider main includes unrelated agent-control changes; adopting it during the
memory repair would broaden release scope. no upstream hosted checks were run;
nexus's sole devbox check and separate allocation evidence own this integration.

port the small provider fix to current upstream main and review its generation
and embedding behavior there. align the kernel dependency when adopting that
revision. close after the fix is merged upstream and nexus consumes a reviewed,
qualified dependency lineage without losing the import regression.
