# resource activation output does not own canonical ref validation

status: deferred; source-verified, runtime not_run · origin: 2026-10-04 chat native-read review; updated 2026-10-09 web dead-code sweep
area: resource activations / typed wire

`ResourceActivationOut` in `python/nexus/schemas/resource_items.py:255–269` checks the `kind`/`href` relation but declares `resource_ref` as plain `str`. the browser decoder that additionally required `parseResourceRef(resource_ref)` (`decodeResourceActivation`) had no live caller (its only path was the unreferenced `decodeCitationOut`) and was deleted on 2026-10-09; no browser path validates the ref today. no malformed server output was observed.

when this shared output owner is revised, make canonical resource-ref validity its explicit contract at the server boundary, then prove valid activations retain their wire bytes and malformed refs fail at that boundary. keep the existing `kind`/`href` relation.
