# codex native patch blocks mcp-only tools

status: open · origin: 2026-09-25 latest-model cutover · area: codex agent authority

## problem and evidence

the pinned codex 0.157.1 app-server registers its native `apply_patch` tool
when the patch type exists. shell has a feature gate, but the native patch has
no documented disable in `ToolsToml`. the current external mcp route needs
`workspace_write` or `unrestricted`; `read_only` with network disabled does
not establish the mcp tool path. therefore nexus cannot prove that only its
frozen mcp tools can cause effects before native execution. the codex adapter
keeps tool-bearing admission closed.

## prerequisite and resolution

establish an upstream-supported pre-effect native-tool disable while retaining
the scoped external mcp publication, or a contained permission boundary that
provably prevents native patch effects and allows the required mcp path. do
not replace prevention with later event filtering. prove the exact pinned
binary and account protocol, then run forbidden native-patch/delegation and
authorized mcp tool journeys on linux. prove both text-with-tools for chat and
strict-structured-with-tools for the existing background operations before
advertising either combined mode. tool-bearing codex becomes ready only after
those checks pass.
