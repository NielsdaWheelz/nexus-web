# lab runs leave their worker images behind

problem: each lab run builds its workers under its unique compose project. that
tags `nexus-lab-<run>-worker-{interactive,background}`. earlier teardown
left those images behind. `python/scripts/disposable_runtime.py` now removes
its generated images with `down --rmi local` in normal and recorded recovery
commands, including after a partial worker build. cleanup verification checks
the host-wide `nexus-lab-*` image namespace and preserves recovery inputs on
leftovers.

impact: the tags accumulate and pin their layers, so the builder's gc limit cannot
reclaim them. docker desktop's disk image grows (about 246 gb used on
2026-10-21) toward its 2 tib cap.

evidence:
- 160 `nexus-lab-*` image tags at 2026-10-21 17:05, and 146 about an hour
  earlier.
- `docker system df` reported 55.8 gb of build cache.

fix: runs create no images ([lab-host-budget](lab-host-budget.md) §2), and
cleanup verification includes images (§3, implemented). existing tags still
require operator-confirmed removal in the maintenance window. until §2 lands,
old tags and images from concurrent runs fail the host-wide cleanup assertion
even when the current run's resources were removed.

resolved when a lab run leaves `docker image ls --filter reference='nexus-lab-*'`
empty, and the existing tags are removed.
