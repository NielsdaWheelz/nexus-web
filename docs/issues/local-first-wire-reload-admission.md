# automatic wire reload bypasses unfinished writing

lab54 on b1 (`20261025-212216-4c293cc5ee65`) held an actual local edit
behind the account command lock, then delivered a genuine server 426. the
browser emitted beforeunload at 9886ms and reloaded at 9890ms. the request's
result vanished and the navigation invalidated two held real browser responses.
the registered loss warning existed; automatic reload admission did not.

at that revision, `lib/api/client.ts` exported `holdWireReload` without a
consumer; its default predicate always permitted reload. the existing
`reloadStrandsWriting` predicate likewise had no consumer. the module contract
requires automatic reload to wait for uncommitted or submitted work.

the work provider now binds that existing predicate for its mounted lifetime.
static verification passes. live qualification must prove a genuine 426 issues neither navigation nor beforeunload
while writing is pending, retains the exact words and terminal admission, then
permits an explicit safe restart after work settles. keep the ordinary user-exit
warning distinct from this automatic-reload fence.
