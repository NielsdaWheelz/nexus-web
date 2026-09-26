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
the current provider v4 catalog reports `supports_frozen_mcp_tools=False`
(`llm-calling/src/provider_runtime/agent_runtime/model_catalog.py:169-184`),
and its adapter rejects nonempty `mcp_servers` before opening a session
(`llm-calling/src/provider_runtime/agent_runtime/codex_adapter.py:564-569`).
the native registry can enforce `ToolPolicy`, but
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

the text-only nexus host also rejects tool-bearing frozen commands before
reserving a slot. this blocks codex-backed chat and the tool-bearing background policies
`metadata_enrichment`, `dossier_library`, and `dossier_idea`
(`python/nexus/services/generation_policy.py:233-246,275-285`). their approved
seed or selection must remain visibly ineligible; neither the catalog nor the
worker may silently substitute a provider api route or strip the tool plan.
moving these jobs to the api also requires a proved `StructuredWithTools`
capability: their output contract is strict json, while the current api catalog
only exposes `TextWithTools` (`python/nexus/services/generation_catalog.py:562-576`).
nexus refuses that combination in `generation_backend.py:314-324` and
`provider_generation_backend.py:329-334`; llm-calling refuses it in
`src/provider_runtime/runtime.py:226-230`. route replacement cannot simply
retag the policy.

## prerequisite and acceptance

find a supported pinned native boundary that excludes all unapproved tools
before model exposure and execution, including resource helpers and native or
delegation tools under model metadata. prove the exact offered schema
and denied effects with frozen mcp tools present in text and strict-json modes.
if 0.157.1 cannot enforce this, retain ineligibility and block cutover.
