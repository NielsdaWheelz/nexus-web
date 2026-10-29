# release highlight annotations

implements the [highlight contract](../modules/highlight.md); deployment remains pending.
the change consumes annotation notes and rebinds their references, so old
producers cannot coexist with the converted corpus. release needs coordinated client cutover.

prerequisites and release order:

1. inventory the actual corpus and every provisioned browser/android profile.
   preflight multiple/shared attachments, hidden liveness, references, pair/order
   collisions and existing grants. stop on unresolved records; repair explicitly.
   rehearse the single new migration on the newest restored production backup.
2. commit all editor buffers, drain every device's outbox and catch-up cursor,
   verify accepted prefixes/common head, then close clients. an unavailable
   device blocks cutover until its disposition is explicitly resolved. stop
   server writers/workers through the existing release owner and verify backup.
3. authored format is 3. wire stays 17: live release
   `3d81ef45ef28f637a4de07c66ab172bbab9e22c2` uses 16; this unreleased branch
   already carries the next wire revision. recheck that release boundary at
   deployment. reject old producers before replay comparison. migrate
   canonical resources, references, projections, index owners/jobs and the
   snapshot/feed floor atomically; retain old accepted bytes as inert history.
   register the new-format server replica; conversion register stamps use it.
   advance account/snapshot lamport above all retained registers and preserve old
   replica/prefix records needed to validate retained causal evidence.
4. pair api/workers, web/extension and signed android delivery. retire old-format
   device state only after empty-outbox proof; bootstrap complete new snapshots
   with fresh replica identities. reject below-floor feed requests before
   decoding. add no runtime converter, alias or fallback.
5. qualify deployed firefox and the signed android app on the owner's device:
   local create/edit/reopen, bidirectional sync, migrated
   annotation destinations with source unavailable, search/tool evidence and
   owner-private access. verify post-bootstrap move/unlink/restore uploads against
   converted bindings. separately record static, local, provider, installed
   device and deployed results. static success is not acceptance of these paths.

old external note urls receive no redirect; app-owned saved destinations are
converted. restore, if required, must coordinate stopped writers and matching
database/client versions through the existing recovery owner. never run an old
binary against the new schema or reset a device with pending writing.

resolved after the exact paired release passes these checks. no pending data,
immutable accepted commands or live reference may be silently discarded.
