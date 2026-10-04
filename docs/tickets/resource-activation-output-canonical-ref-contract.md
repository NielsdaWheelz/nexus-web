# resource activation output does not own canonical ref validation

status: deferred; source-verified, runtime not_run · origin: 2026-10-04 chat native-read review
area: resource activations / typed wire

`ResourceActivationOut` in `python/nexus/schemas/resource_items.py:255–269` checks the `kind`/`href` relation but declares `resource_ref` as plain `str`. the browser's `decodeResourceActivation` in `apps/web/src/lib/resources/activation.ts:14–48` additionally requires `parseResourceRef(resource_ref)` to succeed. native output typing alone cannot retire that leaf check. no malformed server output was observed.

when this shared output owner is revised, make canonical resource-ref validity its explicit contract at the server boundary, then prove valid activations retain their wire bytes and malformed refs fail at that boundary. keep the existing `kind`/`href` relation. remove the browser check only after its owner is replaced; independently persisted/untyped inputs still need validation.
