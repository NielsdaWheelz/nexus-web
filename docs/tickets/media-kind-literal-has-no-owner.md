# media-kind contracts still duplicate the canonical owner

status: open · origin: 2026-09-08 imports cutover; refreshed 2026-10-02 typed media detail cleanup · area: media contracts

`db/models.py:76` already owns the five-value `MediaKind` enum. media summary
and the typed detail schema use it, but `schemas/imports.py:45` and
`schemas/consumption.py:19` still repeat the same values as separate literals.
`services/imports.py:942` casts stored values to its duplicate alias;
`services/consumption/_lectern_store.py:44` derives supported kinds with
`get_args(ConsumptionMediaKind)`. the old library-specific kind contract is gone.
`services/tool_runtime/declarations.py:244` also repeats all five values in
`ResourceInspectSuccess.media_kind`; `tool_runtime/handlers.py:586` hides its
source kind with `cast("Any", document_map.kind)`.

impact: adding a kind can leave independent wire inventories and authority
membership checks inconsistent. the current detail cut closes its own enum
boundary; it does not resolve these remaining owners.

fix: reuse `db.models.MediaKind` at the remaining full-kind boundaries, validate
stored values with enum construction, and update the literal-based membership
check explicitly. do not import `schemas/media.py` into consumption: media's
player descriptor dependency would create a cycle. retain narrower reader-kind
contracts where their subset has a separate meaning.

acceptance: one owner for the complete media-kind inventory, no duplicate
full-kind literal or cast that hides invalid stored kinds; imports/lectern wire
values and supported-kind decisions unchanged; `./scripts/test` passes.
