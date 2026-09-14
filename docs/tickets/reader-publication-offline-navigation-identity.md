# offline publication navigation loses zero-text unit identity

status: open
origin: 2026-09-13 bounded workspace implementation review
area: reader publication / native source

`ReaderPublicationIndex` in `apps/web/src/lib/reader/publicationContract.ts`
contains section fragment/offset metadata but no exact unit identity. multiple
image-only units can share that offset. hosted navigation resolves through
retained database rows; the native package lacks that mapping.

preserve the publisher's exact target-to-unit key in bounded immutable index
metadata. native navigation must use it without choosing an adjacent unit from
an ambiguous canonical offset.

acceptance: the same retained target opens the same addressed image-only unit
online and offline, including two neighboring zero-text units at one offset.
