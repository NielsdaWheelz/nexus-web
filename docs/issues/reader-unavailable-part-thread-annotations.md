# part and thread routes without text cannot list their owners' annotations

problem: a highlight belongs to the media that owns its offsets. a part's highlights
belong to its source media; an x thread's belong to each post's media. a part or thread
route whose reader text cannot load (offline, cold, or a failed load before any
publication was mounted) knows only its own media, so its "source isn't available on this
device" list is empty. the authored graph does not replicate source composition, and no
acceptance case needs a retained part/thread-to-owner relation, so none is added.

what still works, by design:
- the owner media's route lists every retained quote with editable attached notes, with
  or without its text (`MediaPaneBody.tsx` `LocalAnnotations`, `createReaderAnnotations`).
- a route that mounted the part or thread first keeps its owner sources when the text
  later fails (`createReaderAnnotations.bind(null)` keeps the bound sources).
- local search finds the quote and note text and links to the owner route
  (`localResourceHref`: `/media/<owner>#highlight-<id>`); with text, that arrival resolves
  locally and inspects the mark (`sourceArrival.ts`, `deliverHighlight`).

residual ux limitations:
- on the part's or thread's own route without text, its annotations are absent; the reader
  must open the owner media (search, a note's reference, or the highlight link) to see them.
- on an owner route without text, a `#highlight-<id>` arrival shows the full retained list
  but does not scroll to or focus that one annotation.

revisit when an acceptance case requires annotations on a part or thread route without its
text, or focused arrival without text; then the owner relation needs an authored or source
stub field, not a reader-side inference.
