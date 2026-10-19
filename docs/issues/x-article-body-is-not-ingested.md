# official x article structure is unavailable

full native article import remains blocked by the official read contract.
authenticated `GET /2/tweets/2111872142417793248` with `tweet.fields=article`
returned 200 on 2026-10-19: `plain_text` (2,695 characters), `preview_text`,
`title`, `cover_media`, `media_entities`, and `entities`. it supplies no heading,
quotation or emphasis nodes, link text ranges, or media positions. carrier
`entities.urls.expanded_url` establishes article `2111872137065824256`.

the [official schema](https://docs.x.com/openapi.json) declares `article` as an
unspecified object; article endpoints create/publish, with no rich-content read
or `article.fields` selector. media expansions provide assets, not placement.

the provider owner (`python/nexus/services/x_client.py`) now discovers articles
before thread search and explicitly refuses their unqualified bodies. the thread
and failed article have independent attempts and recovery; no teaser-only article
is published. the approved integration remains official-only.

resolved when a supported official response qualifies identity, authored title,
body ending, ordered structure, links and media placement against the rendered
source, and the native article's reader/search/refresh acceptance passes. neither
plain prose nor third-party retrieval proves that contract.
