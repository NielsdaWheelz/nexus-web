# two SSE payload families have no wire model

status: open · origin: 2026-09-28 typed-wire foundation (size/typed-wire, claude session) · area: chat SSE / media SSE / typed wire

`python/nexus/wire_schema.py` adds every SSE payload model to the generated web
types. two families are missing because no model is their wire:

- chat `tool_call_start`, `tool_call_done`, `tool_result`: the stored payload
  models (`ChatRunToolCall*EventPayload`, `ChatRunToolResultEventPayload`)
  carry `binding_policy_revision`, `canonical_input_sha256`,
  `tool_contract_revision` and `error_code`, which
  `chat_run_public_event_payload` strips on the read path.
- media processing `state`/`done` (`/stream/media/{id}/events`): a hand-built
  dict in `services/media.py::read_event_snapshot`.

impact: the web keeps hand decoders for these frames
(`apps/web/src/lib/api/sse/events.ts`); tsc cannot see their drift.

fix: in the chat and media-core rewrites, give each frame a public Out model,
emit it as-is, and list it in `wire_schema.py`.

resolved when: both families appear in `wire.gen.ts` and their web decoders
are gone.
