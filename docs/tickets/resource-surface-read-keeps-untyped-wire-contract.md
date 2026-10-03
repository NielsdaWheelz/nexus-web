# resource surface read keeps an untyped wire contract

status: open; source-verified follow-up, deferred, runtime not_run.
origin: 2026-10-03 cleanup audit, main `8ed951ce`.
area: resource-surface ingress.

`api/routes/resource_items.py:103-108` returns `dict` although
`schemas/resource_items.py:369-373` owns the surface output. the client fetch
(`resourceSurface/api.ts:62-67`) and `resourceItems.ts:317-393` reconstruct its
wire shape; the same conversion also consumes typed command and daily receipts.

the note-body arm performs real canonical prosemirror/value-text conversion
(`resourceItems.ts:338-342`); it must survive a typed cut. its arbitrary JSON
also needs a meaningful numeric-value fixture. pinned fastapi already uses
pydantic serialization for the current `dict` response model: a change from
standard-json float serialization has not been established.

design the complete surface ingress owner separately. resolved when the route
and all current converter callers use its generated contract, actual saved
body bytes and canonical value/text remain qualified, and draft/storage parsing
and mutation contracts are unchanged.
