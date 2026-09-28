# ResourceActivationOut has two wire casings

status: open · origin: 2026-09-28 typed-wire foundation (size/typed-wire, claude session) · area: resource graph / chat SSE / typed wire

`ResourceActivationOut` (`python/nexus/schemas/resource_items.py`) is a
`CamelModel`. routes dump it by alias (`resourceRef`, `unresolvedReason`); the
chat `context_ref_added` SSE payload (`ChatRunContextRefAddedEventPayload`)
dumps it by field name (`resource_ref`, `unresolved_reason`) through
`chat_run_event_payload_json`. the web carries both key sets in
`apps/web/src/lib/resources/activation.ts` to cope.

impact: one concept, two shapes. `python -m nexus.wire_schema` generates the
SSE (snake) shape under the name `ResourceActivationOut`; the first slice that
types a route returning it by alias gets "two different schemas are named
ResourceActivationOut" from the dump and cannot regenerate.

fix: pick one casing. dumping the chat payload by alias changes the
`context_ref_added` frame, so the chat web decoder moves in the same PR; then
the snake branch of `activation.ts` goes.

resolved when: the model has one wire casing, the dump emits it once, and
`activation.ts` decodes one key set (or is deleted by the typed-wire rule).
