# maintenance commands lack the native control setting

on deployed dbaa832ea at schema 0341, a canonical `migration` one-off invoking
`get_session_factory()` fails before connecting:
`pydantic_core.ValidationError: NEXUS_CODEX_CONTROL_ENDPOINT Field required`.
`nexus.config.Settings` now requires this field globally, but
`deploy/hetzner/docker-compose.yml` supplies it only to api/workers/native host.
alembic does not construct Settings, so application deployment succeeds while
ordinary maintenance commands (including the documented catalog sync) fail.

an explicit per-invocation
`-e NEXUS_CODEX_CONTROL_ENDPOINT=unix:///tmp/codex-daemon-10001/control.sock`
lets database-only maintenance bind its normal role; it grants no host socket
mount and performs no native call. the live atlas rebuild used that bounded
configuration. fix the maintenance configuration owner or narrow setting
requirements to actual consumers; do not add an implicit compatibility default.

resolved when ordinary canonical maintenance commands initialize their database
role and execute without an undeclared caller override.
