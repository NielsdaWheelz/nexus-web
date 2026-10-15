# storage transfers serialize per process

**problem.** `python/nexus/storage/client.py` holds one process lock across every sdk
call that can open or use a connection and across every chunk read (#576: botocore
reloads ca certificates into the shared tls context when it opens a connection). a
whole `put_object` (a reading copy up to 100 MB, an epub asset, a remote file) and
each ≤ 8 MiB body read hold it for their full duration. signing no longer waits: it
sends nothing and runs outside the lock.

**impact.** in one api process, heads, epub asset reads, share pdf reads and other
transfers wait behind a slow transfer: a 100 MB reading copy (up to three tries) or a
stalled chunk read (up to the 30 s read timeout per chunk). signed urls answer.

**evidence.** `StorageClient._call` and `stream_object`'s chunk loop. journey
`P-STO.sign-while-a-read-stalls` (platform harness) proves signing answers
while a read is stalled; nothing proves body i/o safe outside the lock. the harness
serves minio over plain http, so it cannot reproduce the #576 tls race.

**resolved when** a tls harness (minio or r2 over https with a harness ca)
reproduces #576 and proves body i/o on an established connection safe outside the
lock, or puts go multipart with each part under the lock and a `media/` abort rule
in `deploy/cloudflare/r2-lifecycle.example.json`; and a probe shows an epub asset
read answered while a 100 MB reading copy uploads.
