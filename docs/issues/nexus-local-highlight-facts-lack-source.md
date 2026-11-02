# a local highlight row has no source title in its facts line

status: open · origin: 2026-11-02 palette s1 · area: web / nexus rows, notes presentation

`authoredItem` projects `preview.source: null` for every local resource
(`apps/web/src/lib/notes/presentation.ts:61`), so `rowFacts` →
`resourceMetadataText` has no source title or location label for a highlight
matched by the local worker. the row sheet's highlight facts (`source title ·
location label`) cannot be met from the local projection; the server's row for
the same highlight carries them.

impact: a local highlight row reads as its quoted literal alone; two highlights
from different books with similar text are indistinguishable until opened.

fix: thread the source title through `LocalMatch` (the authored store's
resource projection knows the owning source ref; its title is in the local
graph) into `authoredItem(..., source)`, or omit the fact. owner: s1's rows.ts
for the row, `lib/notes/presentation.ts` for the projection (unowned by the
split).

resolved when a local highlight row's facts line shows its source title.
