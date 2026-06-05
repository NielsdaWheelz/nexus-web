# Web Articles

Web article media is `media.kind = 'web_article'`, but source ownership is split
by provenance.

- `media_ingest.py`: URL transport into the source lifecycle owner.
- `media_source_ingest.py`: durable accepted source attempts for generic web
  URLs, X/Twitter URLs, and browser article captures. It creates the media row
  and `media_source_attempts` row before provider fetch, browser-capture
  sanitization, or indexing work starts.
- `x_identity.py`: X/Twitter URL classification and username normalization.
- `x_client.py`: official X API calls, same-author full-archive search,
  provider timeout budgeting, and typed provider failures.
- `x_rendering.py`: stored X thread/post HTML rendering.
- `x_ingest.py`: X same-author thread persistence, quote-post media, refresh,
  provider event recording, and library assignment; no oEmbed fallback.
- `media.py`: catalog/hydration and fragment listing only for web articles.
- `web_article_structure.py`: sanitization, canonical text, and fragment block
  preparation.
- `web_article_indexing.py`: content-index rebuild and failure marking for web
  article fragments.

Routes stay transport-only. X URLs fail closed through `x_ingest.py`; they do
not fall back to generic web article capture or oEmbed. X author-thread media
uses provider identity `author-thread:<x_author_id>:<conversation_id>`;
captured quote posts use `post:<post_id>`. Provider billing, auth, rate-limit,
timeout, and post-unavailable failures are recorded in `external_provider_events`
with `source_attempt_id` correlation.

Browser article capture persists the raw captured HTML as a private source
artifact at acceptance time, then queues `ingest_media_source`. Sanitization,
no-readable-text, indexing, and metadata failures update the accepted media row
and latest source attempt instead of dropping the capture.
