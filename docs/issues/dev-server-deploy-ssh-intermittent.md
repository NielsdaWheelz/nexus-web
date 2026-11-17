# deployment ssh intermittently stalls

five canonical `4ea24bcaf` releases failed before backend mutation: one archive
transfer stopped at 42,562,048 bytes with ssh exit 255; the next completed web
prepare, then a backend preflight connection timed out; the third transferred
the whole archive, then timed out starting web prepare; connection reuse failed
during the fourth transfer and left an abandoned remote lock holder.
[its recovery and lifecycle defect](paired-release-lock-transport-loss.md) are
separate. the fifth, using only daemon dialing, failed during a fresh ssh
banner exchange before acquiring the release lock. the serving cohort remained `e6ee83f67`. tailscale direct pings stayed around 25–28 ms and public
http remained responsive. neither observation establishes the ssh cause.

impact: reliable deployment and operator inspection are interrupted. no evidence
attributes the application read regression to this transport problem.

three tiny connection pairs passed with both default packet marking and client
`ipqos none`. the temporary host-specific
`ipqos none` trial was ineffective: tiny metadata and web-prepare connections
also failed. that trial was removed. preserve authentication
and host-key checks.

a subsequent 64 mib hash-only upload through the daemon dialing path
(`ProxyCommand .../Tailscale nc %h %p`) completed intact in 303.346 seconds.
an ordinary metadata connection timed out while the alternate path completed
in about 300 ms. this qualifies a narrow mitigation, not a root cause or a
tcp-stack-bypass claim; native route mtu was 1280 and magicdns returned only
the correct ipv4 address. no server configuration changed.

a 35-second server-only tcp-header capture later observed a successful native
connection, with no capture-kernel drops; it did not capture the intermittent
failure. local bpf capture required unavailable privileges. the installed
tailscale capture has no filter or snap limit and requires a custom dissector;
no unrelated payload was captured and no capture privileges were changed.

private release logs: `~/.local/state/nexus-read-responsiveness-20261116/`.

resolve by attributing failed connections at the client/server/network boundary
and verifying the responsible repair with an ordinary canonical transfer and
release. do not increase timeouts or bypass paired activation to manufacture a
successful release.
