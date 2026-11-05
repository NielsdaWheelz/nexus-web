# media unit publication claim

`python/nexus/tasks/media_unit_build.py:_OWNED_HEAD` checks the queue execution with
an unlocked `exists`. both success publication and `_fail` can therefore read an
old running execution before waiting for the summary head, then commit after the
claim is revoked. serializable publication does not replace an explicit queue
fence against the read-committed expiry/settlement owner.

retain the media/summary lock order, then lock and validate the exact running
queue execution before either success or failure writes. remove the redundant
unlocked claim predicate. prove expired/replaced claims cannot update the summary
or claims, including a publication blocked behind its owner row during revocation.
