# shared codex internal networks suppress the published host endpoint

Docker Desktop engine 29.7.2 leaves the running codex daemon without a usable
host endpoint when all of its networks are internal. `HostConfig.PortBindings`
retains the requested loopback `4500/tcp` mapping, but
`NetworkSettings.Ports["4500/tcp"]` is empty. both the isolated bridge setting
and the default internal bridge nat mode reproduce this. private temporary
reproductions are `apps/web/.nexus-lab/cases/shared-host-network.py` and
`shared-host-network-nat.py`.

the host api cannot read the authenticated catalog, so live lab attachment
fails before its driver. the daemon must retain internal-only networks and
allowlisted egress; adding an outbound daemon route weakens that contract.

owner approved: use a layer-four tcp ingress through the existing
nginx egress peer, publishing only on host loopback while workers keep their
direct authenticated daemon connection. this changes the direct-published-listener
architecture; implementation and native topology qualification are pending.

resolved when the approved topology exposes the authenticated native catalog to
the host and both worker lanes, wrong/missing tokens fail, loopback confinement
holds, and denied daemon egress remains denied on the actual Docker engine.
