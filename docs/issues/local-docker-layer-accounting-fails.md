# local docker layer accounting fails

problem: docker disk accounting fails for an unrelated container whose writable
layer snapshot is missing. current healthy disposable applications still list
and run; this does not establish a product defect.

evidence: on the mac host, 2026-10-20, `docker system df` returned
`failed to retrieve container list: rw layer snapshot not found for container
1303c215bf960cd4f0ce7f293dbf90d13b1753f9171b2c202b1511635e15d349`.
`docker ps` simultaneously listed healthy task-owned and unrelated services.

impact: docker's aggregate image/container accounting cannot establish available
headroom. use host free-space checks while qualifying this change. do not prune
unrelated containers, images, caches or volumes.

resolved when the host owner repairs the exact stale container/snapshot ownership
and `docker system df` succeeds without disturbing unrelated services.
