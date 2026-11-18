# atom entries lose authors declared by their containing feed

the simon willison atom feed declares its author on the feed, while its entries
omit authors. `python/nexus/services/feeds/parsing.py:354` reads only the entry's
author children; `python/nexus/services/feed_articles.py:68` stores the resulting
`packet.authors`, so these canonical articles have no author credit.

impact: imported articles lose their bylines, including on the reading record.
[rfc 4287 §4.2.1](https://www.rfc-editor.org/rfc/rfc4287#section-4.2.1) gives
author precedence to the entry, then its contained source, then its containing
feed. integration run `20261117-161701-060f5cd5c3a2` at `b8e6c7782` could not
find a credited article; public xml inspection confirmed the feed-level author.

resolved when atom parsing applies that inheritance at its existing boundary
and an actual imported entry carries its inherited canonical author credit.
