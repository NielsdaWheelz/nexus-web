# codex native patch blocks mcp-only tools

status: open · origin: 2026-09-25 latest-model cutover · area: codex agent authority

## problem and evidence

the pinned codex 0.157.1 app-server registers native `apply_patch` when an
execution environment exists. pre-tool hooks fail open on their own errors.
an explicit empty environment removes native shell/patch registration in the
pinned source, while mcp registration is independent. a bounded live probe
accepted `experimentalApi=true`, empty thread and turn environments, and
`agents.enabled=false`. it listed one mcp tool; a direct app-server mcp call
returned its unique fact. gpt-6-luna and gpt-6-sol/high turns emitted no
`mcpToolCall` and said the tool was inaccessible. model-visible mcp under this
configuration is therefore unproved. the codex adapter keeps tool-bearing
admission closed.

## prerequisite and resolution

establish a model-callable external mcp path with native patch, shell and
delegation absent before effects, or a contained permission boundary with the
same property. do not replace prevention with later event filtering. prove the exact pinned
binary and account protocol, then run forbidden native-patch/delegation and
authorized mcp tool journeys on linux. prove both text-with-tools for chat and
strict-structured-with-tools for the existing background operations before
advertising either combined mode. tool-bearing codex becomes ready only after
those checks pass.
