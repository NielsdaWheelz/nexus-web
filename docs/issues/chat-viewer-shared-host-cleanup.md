status: waiting for dependent task release
origin: 2026-10-16 chat viewer qualification cleanup
area: local development infrastructure

the running `nexus-selection-popup-api-20261016` and stopped
`nexus-resource-references-20261016-background` containers mount
`nexus-chat-viewer-20261016-runtime_nexus_codex_run`. these dependencies have
not been released. retain that socket and the viewer project's
`nexus-codex-agent-host` and `codex-egress-policy` services for those tasks.
this is local qualification infrastructure, not canonical production.

after the dependent owner releases the mount, remove the viewer host/proxy
containers, their unused project networks and the unreferenced socket volume.
leave the dependent task's container/images and the existing credential
directory untouched. acceptance: no dependent consumer needs the host and no
viewer-owned host, proxy, network or socket remains.
