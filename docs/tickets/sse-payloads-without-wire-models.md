# chat tool sse public frames lack wire models

status: open · origin: 2026-09-28 typed-wire foundation (size/typed-wire, claude session) · area: chat sse / typed wire

`python/nexus/wire_schema.py` registers as-is sse payload models, but chat
`tool_call_start`, `tool_call_done`, and `tool_result` still lack public frame
models. their stored `ChatRunToolCall*EventPayload` and
`ChatRunToolResultEventPayload` contain audit fields such as
`binding_policy_revision`, `canonical_input_sha256`,
`tool_contract_revision`, and `error_code` that
`chat_run_public_event_payload` strips before streaming.

impact: `apps/web/src/lib/api/sse/events.ts` still decodes these public chat
frames by hand; generated types cannot catch drift between that decoder and
the projected output.

fix: model the exact projected public frames, emit them as-is, register them
in `wire_schema.py`, and delete their web field decoders. the media
`state`/`done` snapshot is now modeled separately as
`MediaProcessingSnapshotOut` and uses its generated web type.

resolved when: all three public chat tool frames appear as their actual wire
shapes in `wire.gen.ts` and their web field decoders are gone.
