status: open
origin: 2026-09-14 pending source admission audit
area: hosted account cache lifecycle

`AuthenticatedShell.tsx:78` mounts `ResourceCacheProvider` without an account
key. `resourceCache.tsx::ResourceCacheProvider` creates its cache in a ref and
has no cleanup. repository search finds actual `cache.clear()` calls only in
the native shelf. hosted account replacement/unmount therefore does not
withdraw pending source deliveries associated with its old cache, and replacement
can reuse cache entries from the preceding account.

bind the existing hosted provider to its exact account. retire that cache through
its existing clear operation, which must preserve charges held by physical reads
and published consumers until they settle. verify strict replay and seeded reads;
do not add a second account cleanup registry or delayed disposal.

acceptance: replace or unmount the actual hosted cache owner with a held source
delivery. the old delivery cannot reach the replacement account, the old request
is withdrawn, and its charge remains until physical retirement. the replacement
has its own seeds and pending input. replay preserves the reader's current work.
