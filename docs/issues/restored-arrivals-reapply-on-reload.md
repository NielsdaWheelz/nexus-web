# a reload re-applies a restored reader's old arrival

problem: entry delivers `InspectSource` for every restored pane whose current
href carries an arrival (`?loc=`, `#fragment-`, `#highlight-`, …): the store
seeds `pendingPaneEntryDeliveryByPaneId` from `sourceTargetFromHref` of each
initial pane (`apps/web/src/lib/workspace/store.tsx:176-182`). a reader that the
user has since scrolled is moved back to the arrival on every reload, over its
durable reading position.

impact: every reload of a workspace with a located reader. exposure on the
0292-era backup (count-only census, 2026-10-21): 5 current `/media/` visits
with arrival params and 3 with a hash, across 6 rows.

decision owed (owner): deliver arrivals only for the entry href (a deep link),
or keep re-applying them as the restored pane's last explicit location. the
pane chrome re-slice kept main's behaviour (its Q6).

resolved when the owner decides and the code and `docs/modules/workspace.md`
say which.
