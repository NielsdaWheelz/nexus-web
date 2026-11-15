# memory image qualification

status: open, 2026-11-14; [owning issue](https://github.com/NielsdaWheelz/nexus-web/issues/571).

the dependency repositories now use anonymous immutable revisions. retired
dependency deploy keys and build-secret requirements must not return. build the
current api, worker and worker-checkout targets without credentials and verify
their exact runtime/source identity. inspect the composed memory mounts: client
only in api/interactive, publisher only in background, neither baked into images.
start no installed worker.

resolved when the required real checks pass with synthetic content and task-owned
resources; source/static proof is not live acceptance. delete temporary probes.
