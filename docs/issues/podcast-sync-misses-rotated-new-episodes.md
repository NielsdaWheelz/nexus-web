# podcast refresh misses new episodes beyond the current feed head

after downtime or a high-volume publication interval, post-subscription episodes
that remain on later rss pages can be permanently absent. ordinary refresh
never traverses those pages, and the initial history walk excludes them.

evidence: `python/nexus/services/podcasts/sync.py:136-163` fetches only the recent
provider window and one rss page; `python/nexus/services/podcasts/backfill.py:165-169`
only imports episodes at or before the subscription cutoff (plus undated
items). source-derived, not a reproduced provider outage.

resolve at feed traversal ownership: support bounded, resumable catch-up over
available pages and preserve episode alias deduplication. publication timestamps
alone cannot prove completeness, and the publisher may have removed history.
record incomplete coverage rather than promising unavailable episodes.

acceptance: after more than a provider window of new episodes and rss head
rotation, refresh acquires the missing episodes still available on later pages;
retries preserve progress and create no duplicates; unreachable history gets a
truthful coverage notice.
