# tool catalog retains an unused presentation projection

status: open · origin: 2026-10-02 backend cleanup discovery at `496cc4e4d` · area: tool runtime

`services/tool_runtime/catalog.py:179-195` defines and exports
`operation_presented_declarations`, but whole-repository search finds only its
definition and `__all__` entry (`:321`). its two imports
`CHAT_TOOL_DECLARATIONS_BY_ID` and `PresentedToolDeclaration` (`:37-39`) exist
only for that unused function. actual tool presentation is owned by
`tool_runtime/chat_projection.py:137-138,249-250`.

fix: remove the unused function, export and imports. while simplifying this
owner, consider inlining `project_provider_model_tools` (`:198-207`) into its
sole real caller `compose_provider_model_tools` (`:215`); the caller requires a
real operation, so the lowerer's optional-operation branch has no consumer.

acceptance: no unused presentation API remains; frozen tool plan snapshots,
provider declarations and actual chat presentation retain their values;
`./scripts/test` passes.
