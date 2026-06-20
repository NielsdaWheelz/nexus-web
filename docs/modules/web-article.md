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
- `node/ingest/ingest.mjs`: generic web fetch and extraction. Mozilla
  Readability is the default extractor, with a source-shape-specific
  pre-extraction for Wikisource proofread pages (`.mw-parser-output >
  .prp-pages-output`) so page-body text wins over reference sections before the
  normal Python sanitization/indexing path consumes it.

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

## Reader Apparatus

Web article reader apparatus extraction is owned by the web article structure
pipeline before sanitization strips semantic source attributes. The parser uses
source-authored evidence such as DPUB-ARIA roles, JATS `xref @rid`, Distill
custom citation tags, MediaWiki reference links, and Tufte sidenote structure.
Tufte-style numbered sidenotes and unnumbered margin notes keep explicit
`sidenote` / `margin_note` semantics, and standalone `span.marginnote` elements
may surface as target-only Document Map Citations rows with no synthetic marker
edge. It does not infer apparatus from bare superscripts or client-rendered DOM
heuristics.
The fixture manifest owns exact source support levels and expected counts.

HTML bibliography support is intentionally link-layer conservative. MediaWiki
`sup.reference -> li#cite_note` note graphs are supported, and rendered
`CITEREF...` works-cited entries linked from those note bodies are emitted as
bibliography rows and citation edges. Distill fixtures emit cited `d-cite` /
`dt-cite` targets and Distill footnotes; script-only bibliography records with
no in-document marker are counted as out-of-scope absences and are not
standalone apparatus rows.
