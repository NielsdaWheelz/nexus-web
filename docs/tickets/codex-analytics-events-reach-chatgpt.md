# codex posts analytics events to chatgpt.com

status: open · origin: 2026-10-10 codex host harness (journey C16) · area: codex host egress

the egress allowlist denies codex's telemetry hosts (`ab.chatgpt.com`, sentry) by
name, but codex 0.160.0 also posts analytics to
`chatgpt.com/backend-api/codex/analytics-events/events`, which the allowlist must
admit: the proxy sees only the sni. one harness run recorded 43 such posts
against 20 model turns (fake log, every `REQ chatgpt.com POST
/backend-api/codex/analytics-events/events`). the binary documents analytics as
off by default for app-server and offers `[analytics] enabled = false` in
`config.toml`; idk why it posts anyway (a first-party default, or a different
event stream).

fix: decide whether nexus wants codex analytics off. if so, pass the config
through the host's argv (`-c analytics.enabled=false` beside
`model_catalog_json`, which changes the spec's i3 argv) or a managed
requirement if codex has one, then rerun the harness.

acceptance: a full harness run records no `analytics-events` request, or the
owner accepts the posts and closes this.
