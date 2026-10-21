# podcast artwork urls are not refreshed by routine sync

routine podcast refresh updates episodes but never refreshes the show's artwork
url. a changed or retired publisher url can therefore remain stored indefinitely
until another discovery acquisition updates the show. this is a source-derived
freshness gap; no stale live artwork was reproduced in the 2026-10-21 review.

evidence: `python/nexus/services/podcasts/sync.py:131-153` fetches recent episodes
and a feed page, then ingests episodes only. the show writer is
`python/nexus/services/podcasts/shows.py:28-87`; its callers are subscription
acquisition (`subscriptions.py:152`) and episode acquisition
(`episode_acquisition.py:48`). `shows.py:75` also retains the previous image url
when the acquired provider value is null.

resolve at the show metadata owner: define when authoritative artwork is
refreshed and when absence clears an old value, distinguishing absence from
upstream failure. listing or rendering a row must not fetch provider metadata.

resolved when a followed show's changed artwork appears after the supported
refresh, authoritative removal follows the stated policy, and a failed provider
read preserves the last known value. qualify with controlled provider/feed data;
the list-artwork change need not own this separate refresh behavior.
