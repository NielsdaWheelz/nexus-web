# lab runs leave their worker images behind

problem: earlier lab runs built workers under their unique compose projects,
tagging `nexus-lab-<run>-worker-{interactive,background}`. earlier teardown
left those images behind. current runs use shared dependency-hash checkout
images and create no per-run images. `python/scripts/disposable_runtime.py` removes
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

remaining fix: existing tags still require operator-confirmed removal in the
maintenance window. old tags and images from older still-running labs fail the
host-wide cleanup assertion even when the current run's resources were removed.
checkout image reuse and teardown ownership are implemented; their contracts
live in [testing-standards.md](../local-rules/testing-standards.md).

resolved when a lab run leaves `docker image ls --filter reference='nexus-lab-*'`
empty, and the existing tags are removed.
