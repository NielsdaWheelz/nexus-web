# release certificate-trust updates

status: #715 already shipped in production `dc12792e0` (schema 0312, wire 14).
the deployed source pins certifi `2026.10.19` and uv `0.13.4`, and requires patched
debian ca-certificates in both build and runtime layers.

remaining runtime acceptance: record that the actual deployed python clients
reject both compromised-chain diagnostic hosts while normal https succeeds.
source deployment does not establish those diagnostic results. node/bun and any
separately bundled native-agent trust paths need their own recorded qualification.

delete this record when that runtime evidence is recorded. container trust
changes continue through immutable images and the canonical controller.
