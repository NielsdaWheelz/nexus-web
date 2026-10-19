# devbox services interrupted memory diagnosis

status: open · origin: 2026-09-15 restoration release · area: devbox operations

## evidence

the existing github runner stopped successfully at 20:42:02 utc with
`Restart=no`; its service is
`actions.runner.NielsdaWheelz-nexus-web.nexus-dev-server-2.service`.
rootless docker/user services then restarted around 20:45:32–38. the kernel
uptime continued; this was not a host reboot. the service journal mentions an
oom-killed process in app.slice, but the cause and affected process remain
unresolved. the process that requested the stops has not been identified.

the concurrent source-overlay diagnostic exited 137 before api readiness,
with `OOMKilled=false`. retain it as an interrupted environment, not a product
memory result. private evidence:
`/tmp/nexus-release-255/memory-incident-5acb211a/tcp-transfer-overlay/`
(`user-journal.log`, `receipt-recovered.json`).

pr #267's queued check found the runner offline. starting that same service
restored it; check 35023610840 and publisher 35024039138 then passed. this task did not change service
configuration, resize the vm or reboot it. this restores availability
without identifying the interruption's owner or cause.

## follow-up and acceptance

inspect the dev-server fleet owner and system journal for the two stop events.
identify whether maintenance or resource pressure caused them and correct that
owner if needed. preserve unrelated fleet/session state. close when the cause
and intended runner/docker lifecycle are established; successful nexus retries
alone do not establish that.
