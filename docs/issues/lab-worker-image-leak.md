# lab runs leave their worker images behind

problem: each lab run builds its workers under its unique compose project. that
tags `nexus-lab-<run>-worker-{interactive,background}`. teardown runs
`down --volumes --remove-orphans` without `--rmi` (`python/scripts/disposable_runtime.py:921`).
its verification checks containers, volumes and networks but not images
(`:935-953`).

impact: the tags accumulate and pin their layers, so the builder's gc limit cannot
reclaim them. docker desktop's disk image grows (about 246 gb used on
2026-10-21) toward its 2 tib cap.

evidence:
- 160 `nexus-lab-*` image tags at 2026-10-21 17:05, and 146 about an hour
  earlier.
- `docker system df` reported 55.8 gb of build cache.

fix: runs create no images ([lab-host-budget](lab-host-budget.md) §2), and
cleanup verification includes images (§3). until then, `down --rmi local`.
existing tags go in the maintenance window.

resolved when a lab run leaves `docker image ls --filter reference='nexus-lab-*'`
empty, and the existing tags are removed.
