# typed title acknowledgement keeps a hand item decoder

status: open; source-verified follow-up, deferred, runtime not_run.
origin: 2026-10-03 resource-item read audit, main `ab6f7aed`.
area: resource-surface title acknowledgement.

`api/routes/resource_items.py:122-129` already returns
`Data[ResourceTitleMutationOut]`; its item is the owned `ResourceItemOut`
(`schemas/resource_items.py:604-608`). nevertheless,
`resourceSurface/useResourceSurfaceSession.ts:570-575` passes that generated
`ApiJson` item through `decodeResourceItem` (`resourceItems.ts:168-315`). this
rebuilds identical wire fields and checks shape/identity/version positivity;
it performs no prosemirror, date or branded-value conversion.

adopt this acknowledgement boundary separately from the surface read's real
prosemirror conversion. use its generated item directly while preserving
operation/source correlation, title projection, version/replay semantics and
writing-session acknowledgement ownership. qualify the deliberate removal of
client malformed-producer diagnostics.

resolved when an actual title edit and same-id replay retain the accepted item,
title/version state and pending-operation acknowledgement, the shared decoder's
other ingress callers remain correct, and the sole static gate passes.
