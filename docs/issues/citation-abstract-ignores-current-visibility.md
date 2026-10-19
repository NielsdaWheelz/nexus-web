# citation abstracts ignore current resource visibility

source baseline: `69c00182c8328f46cec893517971f87f03cdbf16`; still present at `origin/main` `ff57128842b470510446b3edca54922ebcace41e` on 2026-10-16. line numbers refer to the original baseline unless stated otherwise.

status: open
origin: 2026-10-16 resource presentation architecture audit
area: resource graph / citations / authorization

problem: a saved citation can return the target media's current generated
abstract after the viewer loses access. the citation correctly disables its
activation, but enriches its frozen snapshot with newly read private content.

evidence: `python/nexus/services/resource_graph/citations.py:169-180` computes
the missing-ref set and gates activations and jumps. lines 182-184 pass every
media target to `read_batch`, including missing refs; lines 188-204 serialize
that current abstract as `snapshot.summary_md`. the callee explicitly expects
already-scoped ids and has no viewer gate
(`python/nexus/services/media_intelligence.py:132-143`). source trace only;
no live reproduction was run.

reproduce: retain a citation to media that remains stored under another
user's ownership; revoke the viewer's access, keep or regenerate a current
ready media abstract, then read the citation. its activation is unavailable
while `summary_md` can still contain the current abstract.

prerequisites: none. restrict live abstract reads to targets that passed the
current viewer's visibility gate. retain the original stored citation excerpt
under the existing historical-snapshot contract.

acceptance: an inaccessible target returns no live abstract or jump, while
its permitted historical snapshot remains; a visible target still receives
its current ready abstract. verify both after access revocation.
