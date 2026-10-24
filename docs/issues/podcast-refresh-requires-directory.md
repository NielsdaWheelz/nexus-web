# podcast refresh depends on directory availability

a subscribed show's healthy publisher feed cannot refresh when the directory
request fails. directory availability is a hard prerequisite for every sync.

evidence: `python/nexus/services/podcasts/sync.py:136-144` requests recent podcast
index episodes before fetching rss and fails the whole check on either error.
source review only.

proposed owner decision: make publisher rss the continuing subscription source
and define directory enrichment separately. this requires an explicit identity
policy: `python/nexus/services/podcasts/ingest.py:224-241` currently rejects a
known guid on a new enclosure unless a known provider identity accompanies it.
do not remove the directory dependency by guessing identity or silently claiming
equivalent coverage.

acceptance: a healthy subscribed rss feed continues updating during a directory
outage, actual feed failure remains visible, and enclosure changes neither
duplicate nor merge unrelated episodes.
