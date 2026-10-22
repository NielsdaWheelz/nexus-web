# lab worker image rebuilds on every commit

problem: lab runs and `make worker-*` build the release `worker` target. that
target bakes application source and `SOURCE_SHA`:
- `docker/docker-compose.worker.yml:5-10` and `Makefile:127-132` build it.
- `docker/Dockerfile.backend:63` declares `ARG SOURCE_SHA` before the
  backend-runtime apt `RUN`.
- `python-builder` installs the project non-editable (`:19-21`).

so any commit invalidates the runtime layers, and any python edit invalidates
the venvs. the compose file's own contract
(`docker/docker-compose.worker.yml:1`) is "checkout source with image-installed
dependencies", and the lab bind-mounts that source over the baked copy anyway
(`:48-51`).

impact: each rebuild writes about 815 mb of new layers (327 + 326 mb venvs,
122 mb node, 16 mb ingest modules, 16 mb chmod), plus containerd store copies. it
is the largest known contributor to docker desktop's 231 gb of writes in 28 h on
2026-10-21, and to cold-build headroom failures
([dev-server-lab-build-headroom](dev-server-lab-build-headroom.md)).

evidence:
- `docker history nexus-lab-20261021-170114-42049dd78ecb-worker-background`
  shows the layer sizes above.
- of the 40 lab `build.log`s written on 2026-10-21 under
  `nexus-web*/.nexus-local/lab/`, 25 rebuilt the worker venv layer (`worker 3/10`
  not `CACHED`).

fix: the `worker-checkout` target with a dependency-hash tag and `--no-build`
starts ([lab-host-budget](lab-host-budget.md) §2).

resolved when two lab runs at different commits with identical dependency inputs
perform no image build, and the image cannot import `nexus` without bind mounts.
