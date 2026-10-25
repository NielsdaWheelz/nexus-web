# a concurrent postgres build recreates a running lab's database

every lab builds the one tag `localnexus-postgres:15-search-0.26.2`
(`docker/docker-compose.yml:9`) in its dependency phase
(`python/scripts/disposable_runtime.py:939`), and every build names a new image
id: on 2026-10-25 runs in one clone produced manifest lists `d791aa22…` and
`8f925ef3…`, while other clones' labs ran on `43fc832f…` and `a406b2b6…`. when
another clone's build retags it between this run's stores start (`:1011`) and its
workers start (`:1108`), the workers' `compose up` follows `depends_on`
(`docker/docker-compose.worker.yml:33-35`) and recreates this run's postgres
(`workers-start.log`: `postgres-1 Recreate`). `alive()` (`:489`) then inspects
the store container id recorded at `:1050`, which no longer exists, and the run
stops with `workers: failed: docker failed (1); private output discarded; driver
not started`.

impact: a lab fails before its driver starts whenever any other clone starts a
lab inside its ~35s stores-to-workers window. in `nexus-web-reader-view-menu`,
runs 20261025-121329-8eb9a3a8bbc2, 20261025-121448-c5120b2fd1cf,
20261025-121651-e322a1dace69 and 20261025-121846-f866fe6b29b3 failed this way
while five other clones were starting labs about once a minute; the run that
started next succeeded.

proposed fix: start workers with `--no-deps`, or run each project against the
image id its own build produced rather than the mutable tag, so a later retag
never touches a running project. resolved when a lab started during another
clone's postgres build still reaches its driver.
