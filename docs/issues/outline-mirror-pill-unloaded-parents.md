# the mirror pill counts only loaded parents

priority: deferred complete-count query. qualify the count as loaded occurrences when next changing the label; do not add an incidence query solely for prototype completeness.

problem: the pill that says an item appears under several parents counts the
item's links in the outline's loaded windows plus pending fields
(`OutlineController.mirrors`, the per-rebuild `incidence` map). an item linked
under a parent that is not loaded in this outline (another page, a collapsed
branch never opened) shows no pill, or a count lower than the truth.

impact: the pill is a lower bound presented as a fact. a reader cannot tell from
the row that cutting or unlinking it leaves other occurrences elsewhere.

evidence: source reading; the drag lane's report records the limit, and its
mirror case (`outline-drag-05-mirror`) counts two parents on one page only.

resolved when the pill's count comes from the item's complete incident links (a
bounded count in the window read, not the loaded rows), or the pill says it is
local and the module doc states that; a case links an item under a parent on
another page and observes the decided count.
