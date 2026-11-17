# undirected traversal can make other heads look like children

design question, not a violation of the current contract. a lab at `839bb918b`
on 2026-11-16 reported that expanding a note filed under two pages shows the
other page as a child; expanding a page can show days that link to it.

`docs/modules/notes.md` defines undirected links and excludes only relationships
already traversed by that occurrence. `apps/web/src/lib/resources/outlineProjection.ts`
projects other incident links; ancestor targets become terminal earlier
occurrences. `node/authored/src/queries.ts` counts those links as eligible
children. repeated manual expansion therefore crosses between heads; the cycle
rule bounds depth, not the breadth of this traversal.

impact: a tree-like presentation suggests containment even where the relation
means "also filed under". there is no separate expand-all command to fix.

open decision: retain this presentation, or distinguish other heads/mentioning
days through the projection owner. changing the stored undirected relationship
is not implied. resolved when the owner records the decision and checks the
doubly filed note and daily-page cases against it.
