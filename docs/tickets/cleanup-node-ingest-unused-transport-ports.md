# node article ingest retains unused transport configuration

status: open
origin: 2026-09-21 cleanup audit, main 93563d12b62af0b4f8d84c73269f051cec6555ff
area: ingest-imports / node article acquisition

`node/ingest/accepted_url_egress.mjs:98-105` exports a connector with injectable
socket/request functions; lines 143-159 expose injectable limits, resolver and
connector and thread them into acquisition. lines 452-483 validate these
configurable ports and limits. the sole production caller,
`node/ingest/ingest.mjs:81`, supplies only url and timeout. repository search
finds no consumer of the connector export or overrides. this leaves a
configurable transport framework around one fixed operation.

prerequisites: the existing node ingress/result wire contract remains the
specification. include this in the ingest-imports rewrite: make acquisition one
owned operation with fixed policy and private direct dns/socket helpers; remove
unused configuration, public surface and validation of impossible injected
values.

retain public-destination admission on every redirect, dns pinning, peer
identity checks, tls validation, deadline cancellation, and wire/decompression/
decoded-size bounds. these protect actual untrusted sources and are not the
unused abstraction.

acceptance: the sole entrypoint preserves result/failure shapes; manually
ingest a real article and inspect a redirected article's final url, and confirm
a private-address input returns unsafe-destination before connection. pass
`./scripts/test`; remove all unused transport overrides.
