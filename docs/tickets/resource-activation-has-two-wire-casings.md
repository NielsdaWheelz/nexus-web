# ResourceActivationOut has two wire casings

status: open · origin: 2026-09-28 typed-wire foundation (size/typed-wire, claude session); updated 2026-09-28 cleanup pr-08 (cleanup/dossier-latest-revision) · area: resource graph / chat SSE / oracle / typed wire

`ResourceActivationOut` (`python/nexus/schemas/resource_items.py`) is a
`CamelModel`. typed routes (the dossier head since pr-08, via
`identity.activation` and `current_revision.citations[].activation`) dump it by
alias (`resourceRef`, `unresolvedReason`), and the wire dump now generates that
camel form. the chat `citation_index` and `context_ref_added` payloads and the
oracle `passage` payload dump it by field name (`resource_ref`,
`unresolved_reason`) through `chat_run_event_payload_json` and
`oracle_event_payload`. to keep one schema per name, `nexus/wire_schema.py`
no longer lists those three payloads, so they have no generated type; the web
decodes both key sets in `apps/web/src/lib/resources/activation.ts`.

impact: one concept, two shapes; three SSE frames stay hand-decoded.

fix: dump the three payloads by alias (their web decoders move in the same PR),
list them in `SSE_PAYLOADS_BY_NAME` again, and drop the snake branch of
`activation.ts`.

resolved when: the model has one wire casing, the three payloads are listed in
the wire dump, and `activation.ts` decodes one key set (or is deleted by the
typed-wire rule).
