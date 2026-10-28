# joining active source work loses the new admission identity

fresh url admission can join an in-flight source attempt without persisting its
client request id. retrying that request can reapply filing or create another
settled receipt after the original work finishes. source-derived; no live proof.

evidence: `python/nexus/services/media_source_ingest.py:479-489` applies filing;
`:497-506` returns the existing active attempt without recording the incoming id.
replay detection at `:341-358` requires that id in source attempts or supersessions.

reproduce with a source that admission can already resolve while processing:
add using a new id, lose its response, change filing, then retry the same id
before and after the existing attempt settles. inspect placement and attempt
effects. native x's unpublished identity lookup provides one such path.

the browser-recovery spec refuses fresh-id busy joins in its new scoped lookup.
the existing general join path remains a separate follow-up: either refuse
unreceipted fresh joins or give acceptance a durable domain identity through the
existing source owner, without a replay ledger. resolved when identical-request
replay cannot reapply filing across source settlement.
