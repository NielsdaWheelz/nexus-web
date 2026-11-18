# a citation can briefly disappear when it moves between source batches

an outline with more than 100 distinct highlight sources resolves sorted groups
of 100. admitting another source can move an existing citation into the next
group. that group has no prior answer for the source, so its citation can lose
one line until the local read returns. the excerpt and annotation stay mounted.

`OutlineEditorRows` partitions the source refs. `HighlightCitations` and
`useResolvedRefs` retain the overlap within each group. the local `resolve` query
in `node/authored/src/queries.ts` caps each request at 100 refs. this follows
from the source. the forty-highlight live case uses a single source.

close when inserting a new source ahead of a full first group keeps the text
and height of a mounted citation that crosses the boundary throughout the read.
