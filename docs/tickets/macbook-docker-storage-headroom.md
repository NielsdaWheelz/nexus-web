# macbook docker storage has little headroom

status: open
origin: 2026-10-15T06:55Z shared qualification outage
area: local development / host storage

a parallel corpus restore exhausted shared storage and interrupted isolated
auth/databases. toolbar postgres reported a read-only filesystem; docker cli
hung. the restore owner recovered the engine without deleting task volumes and
moved large-corpus qualification to its owned dev-server container.

after recovery, `/System/Volumes/Data` reported 100% capacity with 3.9gib
available; at 2026-10-15T07:27Z it reports 8.3gib available, still 100%.
docker's `Data/vms-data/Docker.raw` occupied about 301gib. ordinary
task login and a bff create/delete pass again; the remaining capacity risk is
unresolved and belongs to host operation, not toolbar code.

prerequisite: identify owners of large local artifacts/caches before cleanup.
recover measured headroom for the intended local workloads; retain durable
volumes and keep large corpus restores on the dev server.

acceptance: available host/engine storage accommodates the agreed local
workload with documented headroom; representative normal docker writes remain
healthy. record cleanup/moves and ownership, without global prune/reset.
