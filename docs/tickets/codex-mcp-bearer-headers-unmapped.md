# codex mcp bearer headers are unmapped

status: open · origin: 2026-09-25 latest-model cutover probe · area: provider authorization

## problem and evidence

`llm-calling` rejects codex mcp `header_refs` in its session owner and emits
only url, required flag and tool filters in the native mcp configuration.
nexus frozen mcp requires a per-generation bearer, so the present adapter
cannot authenticate its scoped remote tool server. codex 0.157.1 accepts
`http_headers`, but its native client silently skips invalid header values.

## prerequisite and acceptance

after the native-tool authority path is proved, resolve the existing secret
reference at the provider boundary, validate http names and values, and pass
only the scoped bearer in the per-thread mcp configuration. keep it out of the
child environment and logs. prove an authorized call succeeds and missing,
wrong or expired grants fail before any tool effect.
