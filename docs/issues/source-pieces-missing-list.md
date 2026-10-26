# source-piece rows have no list owner

`components/media/containedWorks/Pieces.tsx:88` renders `ResourceIndexRow` directly
inside the pieces `<section>`, interleaved with candidate articles and the contents
tree. `components/resources/ResourceIndexRow.tsx:94` delegates to `ResourceRow`,
whose default root at `components/ui/ResourceRow.tsx:42` is `<li>`. paths are under
`apps/web/src/`. no `<ul>` or `<ol>` owns these list items.

the authored outline therefore exposes invalid list semantics; assistive readers
may lose list context. this is outside the complete-index change's authored-outline
scope. repair the pieces composition with an explicit semantic list owner without
changing candidate decisions, contents navigation or the reader's layout ownership.

resolved when rendered piece rows belong to a valid list and their actual reader
activation, candidate controls and spoken list semantics are verified.
