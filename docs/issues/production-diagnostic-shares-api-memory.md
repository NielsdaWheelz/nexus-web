# diagnostic process exhausted the running api's memory budget

problem: application-import diagnostics run with `docker exec` share the live
api container's 384 mib/no-swap limit. a read-only diagnostic can kill the
serving process before its database work produces evidence.

evidence: during the 2026-10-28 machine-link investigation, a diagnostic python
process imported the deployed resource-item service inside `nexus-api-1`.
at 18:53:27 utc, the kernel reported `CONSTRAINT_MEMCG` and killed `uvicorn`
(pid 3409834, anonymous rss 292204 kb). the same cgroup contained the diagnostic
python process. the exec exited 137; docker restarted the api automatically
and its restart count became 1. this interruption was caused by the diagnostic,
not evidence of the original machine-link failure.

recovery was observed: docker reported `health=healthy` and the public api's
`/readyz` returned `{"data":{"status":"ready"}}`. the replacement diagnostic
ran the deployed application source locally with one read-only database
connection over an ephemeral ssh tunnel, which was closed afterward. it
reproduced the link defect without another process inside the api container.

fix: keep source execution off the serving container. prefer bounded read-only
sql for production inspection, or run the exact deployed source in a separate
local process against an explicitly read-only connection. do not increase the
production memory limit to accommodate diagnostics. if the operator runbook
adds service-level diagnostics, give them an explicit independent execution
boundary and resource budget.

resolved when the documented diagnostic path cannot charge extra application
imports to the serving api cgroup and service-level inspection is qualified
without interrupting production.

2026-11-04 chat-send investigation: a read-only `docker exec nexus-api-1
python -c 'from nexus.api.edge import WIRE_REVISION; print(WIRE_REVISION)'`
exited 137. no cause attribution was established; subsequent wire inspection read
the source file without importing the application. avoid application imports in
the running api container during qualification.
