# deferred search lab runner cutover

the six-slot runtime and host policy are integrated through nexus #770 and
dev-server #194. current main uses the qualified harness and the unchanged
docker allocation. one old worktree remains outside the cutover by owner request.

`/Users/nnandal/Documents/code/nexus-web-search-latency`, inspected at head
`7e55c59ae5cf2b6f398a1e0baf82235fa72fd3c0` with 89 modified tracked files,
uses a pre-admission `python/scripts/disposable_runtime.py`: dynamic ports,
no host slot locks or capacity policy, and uncommitted custom postgres build
and `pg_search` preload changes. its runner can bypass the six-slot budget and
cannot be excluded by a current runner's all-slot lock.

the owner explicitly requested leaving that worktree and runner untouched while
its feature pr is in progress. no backport, parking wrapper or compatibility
path was added. host-wide capacity and measurement exclusivity remain unproven
while that old runner can start; drain it before performance measurements.

after the feature work settles, integrate the current harness with its postgres
requirements and qualify canonical bootstrap, shared admission and teardown.
delete this record when the old runner is retired or upgraded and all active
labs use the current admission contract. preserve unrelated work and images.
