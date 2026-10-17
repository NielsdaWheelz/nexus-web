# contributor apply does not consume the reviewed preview

status: implemented in merged #613; final-artifact apply qualification pending
origin: 2026-10-14 book-repair planning at `75b17c030`
area: contributor maintenance / approval fence

at the planning base, `python/scripts/repair_epub_contributors.py:119–184` recomputed the plan in
each apply invocation. its internal source/credit snapshot fences that run,
not the preview reviewed beforehand. `epub_contributor_repair.py:287–328`
also resolves proposed person identities separately for preview and apply;
an alias winner can change while the source and current media credits do not.
its counts and moved/added descriptions did not identify the full proposal.

prerequisite met: the bounded 245-item source audit found one proved
frankenstein `raw_role` correction; the historical original-244 audit yielded
five unchanged and 239 unresolved. four later deletions are accounted offline. no apply may proceed until this fence is qualified.

[merged #613](https://github.com/NielsdaWheelz/nexus-web/pull/613) implements
this contract. static and historical clone controls are retained separately;
final-artifact drift/apply and preservation proof remain pending.

implemented contract: follow the [book-repair plan](../book-repair-plan.md). bind
viewer/media, source, ordered existing credits/manual state, and complete
proposed rows/person identities in a preview digest. require it and exactly
one media id for apply. compare inside the locked serializable transaction,
before allocation or writes and on every retry; materialize the checked plan.
reject the old bare apply path. no new public endpoint or repair framework.

acceptance: changing only a proposed alias winner after preview refuses with
zero person/alias/credit allocations. source/credit drift also refuses; an
unchanged reviewed proposal applies once and then previews unchanged. reader
state, manual/unrelated credits and existing person identities stay intact.
