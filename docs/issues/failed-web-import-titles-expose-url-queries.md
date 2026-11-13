# source admission retains url queries in placeholder titles

ordinary web admission persists the submitted url as its placeholder title,
including query values that may contain access parameters. consumers using that
stored title can expose them. this is source evidence, without a live denied-url
reproduction.

evidence: `python/nexus/services/media_source_ingest.py` sets `title=url[:255]`
and `_new_media` persists it. the imports register and details now present the
safe hostname/path pointer instead; admission and other title consumers remain.

fix at source admission and existing placeholder conversion. preserve authored
titles and the complete url as source identity and navigation/request data.

resolved when a denied url containing a test access parameter retains its exact
request url while titles, picker labels and error copy omit that value, including
existing placeholders without rewriting authored titles.
