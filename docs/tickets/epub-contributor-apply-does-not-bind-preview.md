# contributor apply does not consume the reviewed preview

status: open; implemented in draft #613, clone apply qualification pending
origin: 2026-10-14 book-repair planning at `75b17c030`
area: contributor maintenance / approval fence

`python/scripts/repair_epub_contributors.py:119–184` recomputes the plan in
each apply invocation. its internal source/credit snapshot fences that run,
not the preview reviewed beforehand. `epub_contributor_repair.py:287–328`
also resolves proposed person identities separately for preview and apply;
an alias winner can change while the source and current media credits do not.
the current counts and moved/added descriptions do not identify the full proposal.

prerequisite met: the bounded 245-item source audit found one proved
frankenstein `raw_role` correction; the original 244 remain five unchanged and
239 unresolved. no apply may proceed until this fence is qualified.

[draft #613](https://github.com/NielsdaWheelz/nexus-web/pull/613), source
`bfbe381b9de148d41b70eee12683ab6a0ee8f98e`, implements this contract.
static checks passed; actual clone drift/apply and preservation proof remain pending.

fix if needed: follow the [book-repair plan](../book-repair-plan.md). bind
viewer/media, source, ordered existing credits/manual state, and complete
proposed rows/person identities in a preview digest. require it and exactly
one media id for apply. compare inside the locked serializable transaction,
before allocation or writes and on every retry; materialize the checked plan.
reject the old bare apply path. no new public endpoint or repair framework.

acceptance: changing only a proposed alias winner after preview refuses with
zero person/alias/credit allocations. source/credit drift also refuses; an
unchanged reviewed proposal applies once and then previews unchanged. reader
state, manual/unrelated credits and existing person identities stay intact.
