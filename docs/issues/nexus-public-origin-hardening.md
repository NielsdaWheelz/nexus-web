# nexus origin is directly public

problem: nexus api dns points directly to its vps; caddy publishes public web
ports. administration depends on public source-address ssh rules rather than
tailscale. neither tailscale nor cloudflared was installed at inspection.

impact: public requests reach the origin without a cloudflare edge, and ssh
access depends on fixed public source addresses. this is exposure, not evidence
of compromise or an application-authentication bypass.

evidence: 2026-10-23 provider/host firewall and docker inspections showed public
tcp `80/443`; dns and a direct-origin request with the correct hostname returned
the api version. fresh external ipv4/ipv6 web connections succeeded.

resolved when the [coordinated release](release-security-hardening.md) named
tunnel serves the chosen public api hostname, direct-origin connections fail in both
families, administration/deployment uses tailscale, and client, resource,
credential, reboot and recovery acceptance pass. implementation is owned by
`nexus-web`; cloudflare account access and a planned release window are required.
implementation and live acceptance are NOT_RUN. the shared tailnet policy is
owned by `dev-server`; this repository owns production's service boundary and
required connections.
