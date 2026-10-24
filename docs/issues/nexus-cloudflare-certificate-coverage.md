# nexus api requires a certificate or hostname decision

problem: the intended cloudflare endpoint is
`api.nexus.nielseriknandal.com`. ordinary universal ssl on a full zone for
`nielseriknandal.com` does not cover this deeper hostname. authenticated account
inspection confirms the zone is on the free plan, with no advanced coverage.

impact: switching dns to the tunnel without a suitable active edge certificate
would break https even if the connector and application are healthy. caddy's
current origin certificate does not supply cloudflare's edge certificate.

evidence: 2026-10-23 public dns shows cloudflare nameservers for the apex;
[cloudflare's coverage rules](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/)
limit full-zone universal certificates to the apex and first-level subdomains.
authenticated follow-up found only the active apex/first-level wildcard
certificate, advanced quota zero, and no certificate for the nested api name.
`nexus-api.nielseriknandal.com` and `api.nielseriknandal.com` have no dns records
and fit the existing active wildcard. no dns or certificate setting changed.

resolved when provider inspection and a fresh client handshake prove valid
coverage of the intended hostname. if coverage is absent, decide explicitly
between a certificate add-on and a first-level backend hostname, then verify
the corresponding client/configuration migration. no purchase, rename or tls
bypass is implied by the [coordinated release](release-security-hardening.md).
account inspection is complete; the hostname/certificate choice and live edge
acceptance remain pending. supplied management credentials work through a
narrowly scoped child token; no replacement credential is needed.
