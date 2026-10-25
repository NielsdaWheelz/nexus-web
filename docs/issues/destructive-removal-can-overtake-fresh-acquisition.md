# delayed document removal can overtake fresh acquisition

remaining scope: documents through generic `DELETE /media/{id}`. podcast episodes
now refuse that route and use frozen removal preview/destination guards; a stale
episode removal refuses a newer save or unprocessed addition. episode unfiling
preserves catalogue identity and authored work.

problem: document removal identifies its target without an expected acquisition
generation. a delayed destructive request can remove a later explicit save.

evidence: `python/nexus/api/routes/media.py:83-87` takes only media id.
source-derived on 2026-10-22. the corresponding subscription issue is tracked
[separately](podcast-unsubscribe-can-delete-new-subscription.md).

reproduce: delay an old removal before its transaction, acquire the target again,
then release the removal. the newer intent has no precondition protecting it.

scope: the libraries plan fences old acquisition after committed removal, not
this reverse direction. solve destructive-command ordering separately using the
observed resource generation; do not mistake a per-user removal revision for it.

resolved when a stale destructive request refuses after a later acquisition,
with explicit behavior for accepted no-ops.
