# move nexus compute to the home workstation

open proposal recorded at the owner's request on 2026-11-09. no migration or
host changes were authorized or performed. the owner has an always-on arch
workstation, prefers its available capacity to a larger rented vps, and accepts
occasional home power, network or maintenance outages, including while away.
retaining the tiny vps as an intermediate layer is a tentative preference.

recommend keeping api, workers and postgres together on the home host, with one
authoritative database. preserve existing vercel frontend/proxy, supabase auth,
r2 objects/backups and public application access. choose explicitly between the
existing outbound cloudflare tunnel and a vps relay over a narrow private link;
a relay adds a dependency and cannot serve database-backed requests while home
is unavailable. ordinary clients must not need a vpn.

capacity, disk headroom, upload reliability and incremental cost are unmeasured.
the current compose caps are postgres `512m`, api `384m`, interactive worker
`320m` and background worker `448m`; moving unchanged retains those limits.
[deployment](../../deployment.md) and `deploy/hetzner/release.py` enforce the
current envelope. change configuration, enforcement and contracts together from
measured demand, leaving capacity for workstation use. this does not resolve the
[postgres incidents](production-search-postgres-oom.md) or
[aggregate headroom issue](production-database-connection-budgets-implicit.md).

isolate production storage and service ownership from development and cleanup.
a dedicated linux vm is a proposal, not an approved requirement. adapt the
existing release owner and host coordinates; preserve source/image/schema
identity, private ingress and secret boundaries. establish arch suspend/reboot
behavior and remote recovery, including the encrypted credential volume's
[unlock and mount requirements](../runbooks/codex-personal-agent-host.md).

reuse offsite backups and rehearse a restore. prefer moving the current versions
before an unrelated upgrade. during cutover, stop old writers, verify a final
backup, restore and validate the home database, then switch ingress. simultaneous
connectors must not send writes to independently restored databases. the old
vps database is not safe failback after home has accepted new writes.

resolve when the chosen topology is deployed through the adapted release owner;
external browser, android and extension access, writing and catch-up work;
representative search/import/background demand fits the measured budget; offsite
restore and reboot recovery work; and the vps's role is explicit with competing
writers stopped. none of this home-host qualification has been performed.
