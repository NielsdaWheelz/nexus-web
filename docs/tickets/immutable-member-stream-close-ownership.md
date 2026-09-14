# immutable member streams lack explicit close ownership

status: open; source audit, cancellation behavior not yet reproduced
origin: 2026-09-14 bounded-workspace publication asset review
area: object storage response lifetime and read admission

`python/nexus/api/routes/reader_publications.py:557` passes a synchronous storage
iterator directly to `StreamingResponse`; the range branch at 546 does the same.
`StorageClient.stream_object` closes its SDK body in the generator's finally
(`python/nexus/storage/client.py:252`), but the installed Starlette
`iterate_in_threadpool` and `StreamingResponse.__call__` do not explicitly close
that iterator on send failure/disconnect. reaching EOF closes it; prompt close
on early retirement currently relies on generator/reference cleanup.

`ReadAdmission.serve` holds the enclosing ASGI task. that is not by itself proof
that an inner cancelled synchronous `next()` or `close()` has physically settled
before the permit is removed. no actual socket leak or early permit release is
claimed from this inspection.

before reusing this response composition for EPUB assets/oracle plates, establish
one narrow storage-response close owner at the existing transport boundary.
preserve source authorization/metadata and await any active synchronous step
before closing. no general streaming framework or unmeasured budget change.

acceptance: actual production response plus storage SDK body boundary proves
success, late integrity failure, send error, disconnect and permit deadline all
close the body exactly once; a blocked next/close keeps admission occupied until
released, while lightweight requests still finish. sensitivity must expose the
missing-close behavior without substituting a fake response/read-admission owner.
