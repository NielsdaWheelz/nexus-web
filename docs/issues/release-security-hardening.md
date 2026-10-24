# nexus security cutover remains pending

problem: production administration and web ingress need a coordinated cutover
to tailscale and cloudflare tunnel while preserving the public website and all
existing clients. the agreed ownership is this repository for both nexus
targets; implementation and live acceptance are NOT_RUN.

evidence: 2026-10-23 inspection found direct-origin public web access and
source-restricted public ssh, with neither tailscale nor cloudflared installed.
the existing [release contract](../../deployment.md) owns the vps and vercel
promotion; `deploy/hetzner/release.py` checks public api health before it returns.

required ownership and behavior:

- `deploy/hetzner/` owns host tailscale, key-authenticated private ssh, closed
  public ingress, private caddy, the pinned connector, resource/health checks
  and future provisioning. update public-ip ssh coordinates in existing owners.
- `deploy/vercel/` and existing web configuration owners preserve public browser,
  android, extension and anonymous-share access through the existing frontend.
- `deploy/cloudflare/` owns tunnel routing, api certificate, waf/cache settings
  and records of provider-side changes. keep secrets outside committed inputs;
  retain the api's authentication, streaming, ranges and uncached responses.
- `dev-server` owns the shared tailnet grants policy, operator devices and
  retired-device access. nexus declares its production identity and required
  incoming administration; production initiates no peer application traffic.
  do not duplicate the fleet policy here. the agreed boundaries are in the
  [cross-repository specification](../../../dev-server/docs/fleet-security-spec.md).

release prerequisites and ordering:

use a security-only source based on deployed `400e7039e07387b08c23d13d113f9c14a1646bcf`
to retain wire 14. current main uses wire 15 and would force an unrelated native
client/extension upgrade. the repository permits a true merge commit, allowing
the reviewed security commit to become an ancestor of main without deploying
the newer product tree. publish its own first-attempt backend artifact and
stage a production-target vercel build for that exact source before the normal
release. retain exact-source, ancestry and artifact checks.

1. resolve [edge certificate coverage](nexus-cloudflare-certificate-coverage.md),
   verify [console recovery](../runbooks/codex-personal-agent-host.md#release-and-repair) and
   backup recovery, and establish restricted tailscale ssh before
   removing public administration. any certificate purchase or hostname change
   is explicit.
2. pull and verify the pinned connector before stopping writers; retain existing
   resource/disk floors, codex isolation and the normal exact-source release.
3. during the planned no-use window, switch api dns to the prepared tunnel and
   confirm the controller resolves it through cloudflare before invoking the
   release. its public health check must pass before vercel promotion. verify
   both address families are closed to direct-origin connections.
4. complete [maintenance and reboot](nexus-security-maintenance-pending.md),
   including [verified encrypted-state unlock](production-codex-state-unlock-source-unavailable.md)
   and full application recovery.
   repair and rerun the same source, or publish a new reviewed repair commit;
   arbitrary old-source rollback is not guaranteed.

resolved when [direct-origin hardening](nexus-public-origin-hardening.md),
certificate and maintenance requirements pass; both nexus targets and real
client journeys work; and repeat deployment preserves the private boundary.
record actual manual/provider changes with this repository's release work;
plan/proof details belong in its pr body under repository conventions.
