# codex frozen mcp authority not enforced

status: open · origin: 2026-09-26 pinned 0.157.1 source audit · area: codex tool authority

## problem and evidence

the cutover requires exactly the host-frozen mcp tools and no native or
delegation effects. pinned codex 0.157.1 source at `36650394c5b38c2990ccf2a3457165ca3e9d9726`
registers `list_mcp_resources`, `list_mcp_resource_templates`, and
`read_mcp_resource` whenever any mcp server exists
(`codex-rs/core/src/tools/spec_plan.rs:1090-1095`). their default exposure is
direct (`codex-rs/tools/src/tool_executor.rs:113-115`); direct entries become
model-visible (`codex-rs/core/src/tools/spec_plan.rs:528-555`). the read handler
accepts a server and uri and calls `resources/read`
(`codex-rs/core/src/tools/handlers/mcp_resource/read_mcp_resource.rs:68-84`).
the provider's mcp `enabled_tools` derives from the frozen `allowed_tools`
(`llm-calling/src/provider_runtime/agent_runtime/codex_adapter.py:2149-2157`);
it does not include these helpers. the registry can enforce `ToolPolicy`, but
app-server v2 `thread/start` has no policy parameter
(`codex-rs/app-server-protocol/src/protocol/v2/thread.rs:62-155`) and thread
start inserts only selected roots
(`codex-rs/app-server/src/request_processors/thread_processor.rs:1464-1468`),
so ordinary sessions default to unrestricted policy
(`codex-rs/core/src/session/session.rs:965-973`). `code_mode_only` is not a
substitute: `model_info.tool_mode` takes precedence over the feature flag
(`codex-rs/core/src/tools/mod.rs:73-82`), as the pinned native test confirms
(`codex-rs/core/src/tools/spec_plan_tests.rs:2936-2949`). prior successful mcp
turns prove transport, not the exact model-visible tool set or pre-effect
exclusion. tool-bearing codex must remain ineligible under
`docs/latest-models-cutover-plan.md:165-173`.

## prerequisite and acceptance

find a supported pinned native boundary that excludes all unapproved tools
before model exposure and execution, including resource helpers and native or
delegation tools under model metadata. prove the exact offered schema
and denied effects with frozen mcp tools present in text and strict-json modes.
if 0.157.1 cannot enforce this, retain ineligibility and block cutover.
