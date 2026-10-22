# podcast refresh refetches unchanged chapter sidecars

every rss parse fetches chapter json for every item with a supported chapter
url. a faster subscription cadence multiplies these requests even when neither
feed nor chapters changed; polling cost exceeds one request per show.

evidence: `python/nexus/services/podcasts/feed.py:72-83` fetches and parses every
page, `:214` resolves each item's chapters, and `:263-286` fetches its sidecar.
there is no stored feed validator in this path. source review only.

resolve before materially accelerating polling: define conditional feed reads
and a chapter revalidation policy at the feed owner, including how changed
sidecars at stable urls are refreshed. do not treat unchanged url as immutable.

acceptance: repeated checks of unchanged feeds avoid repeated full chapter
downloads while changed feed or sidecar content eventually updates under the
documented freshness policy. keep network failures and limits explicit.
