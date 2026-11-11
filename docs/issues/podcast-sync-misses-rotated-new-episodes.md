# rotated feed catch-up still needs runtime qualification

source repaired; the recorded rotation/retry qualification remains open.
`python/nexus/services/feeds/sync.py` owns separate head and archive runs;
`feeds/traversal.py` commits one page and follows its linked frontier under the
feed lock. `8aa22f123` (#920) replaced the old one-page podcast sync and cutoff
backfill. those former owners are not instructions for a new implementation.

after downtime and more than a provider window of new episodes, observe refresh
recover episodes still available beyond the rotated rss head. interruption and
retry must retain progress and avoid duplicates. removed or unreachable history
must remain an explicit coverage gap; publication timestamps cannot establish
completeness. this is the unresolved proof boundary, not a newly reproduced
missing-episode incident.

contracts and activation requirements live in [feeds](../modules/feeds.md) and
[the release record](release-feeds-selection.md). resolve after those journeys
on identified artifacts or an explicit owner disposition. no runtime or
deployed qualification was performed in this cleanup.
