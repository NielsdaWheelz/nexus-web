# server-only retention cannot govern offline authored deletion

target gap, not a defect in the current online-first contract: local-first
writing must preserve a note edited concurrently with deletion. a disconnected
device's edits and links are absent from the server's retention census.

evidence: `python/nexus/services/outline.py:582-603` physically deletes a note
after checking server retainers. `python/nexus/services/empty_resource_cleanup.py:85-86,117-128`
qualifies server-empty, unretained roots after seven days.

impact: carrying these rules into offline replication can erase or reject
writing that another device still owns. replicated edit-wins liveness must own
deletion; authored-root cleanup cannot infer global absence from one replica.
this requires merge metadata, not a history/trash/recovery product.

resolved when delete/edit and delete/new-link races converge without losing the
offline writing, in either delivery order and after process restart, and server
cleanup cannot bypass that contract.

status (cutover worktree, unqualified): the server retention census, `outline.py`
consume/remove and `empty_resource_cleanup.py` (with its cli command and periodic
job) are deleted; server deletion is now an observed `delete_resource` through
`services.authored`, and readers hide projections by `authored_visible`. device
convergence in both delivery orders and after restart remains to be qualified.
