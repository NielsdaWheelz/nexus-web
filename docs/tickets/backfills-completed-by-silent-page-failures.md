# backfills completed by silent page failures cannot be redone

status: open · origin: 2026-10-10 podcasts python reauthor (design D3) · area: podcasts / backfill data

Before `0270`'s release a history page that failed to fetch or parse ended the
backfill as `Complete` (the non-strict fetch read the failure as the last page).
The rewrite fails such a backfill and offers "Retry backlog"
(`python/nexus/services/podcasts/backfill.py`), but rows already completed that
way are indistinguishable from honest completions: nothing in
`podcast_subscription_backfills` records the swallowed failure, and Retry only
replaces a Failed backfill.

impact: some production subscriptions may hold truncated history with no way to
walk it again short of unsubscribing and subscribing.

fix: an operator command that reseeds one subscription's backfill at its cutoff
(`backfill.seed` after deleting the current row), or a user-facing "walk history
again" for terminal backfills.

acceptance: an operator can reseed one subscription's backfill at its original
cutoff and it walks the feed again to completion.
