# nexus maintenance and reboot remain pending

problem: nexus reports a required system restart and available package updates.
unattended security updates are enabled, but that does not prove every running
kernel or third-party daemon is current.

impact: loaded software may lag installed fixes. this observation does not
establish a specific unpatched vulnerability; no cached upgradable entry was
classified as a security update during the inspection.

evidence: 2026-10-23 `/var/run/reboot-required` reported a restart; cached apt
metadata listed 51 updates, including docker/containerd. updates were not run.

resolved when native updates and loaded versions are reviewed, required restarts
complete, and the [coordinated release](release-security-hardening.md) production
recovery checks pass. reboot requires the existing encrypted codex volume unlock and
full application/worker readiness proof, not merely ssh availability. the work
needs a planned outage and the existing unlock capability; maintenance and live
recovery acceptance are NOT_RUN.

preflight confirms the volume is currently mounted, but
[its off-host unlock source remains unavailable](production-codex-state-unlock-source-unavailable.md).
also retain [the independent console login](../runbooks/codex-personal-agent-host.md#release-and-repair).
do not reboot or close the existing administration path before those recovery
requirements pass.
