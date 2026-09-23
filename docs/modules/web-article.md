# Web Articles

Web article media is `media.kind = 'web_article'`, but source ownership is split
by provenance.

- `media_source_ingest.py`: durable accepted source attempts for generic web
  URLs and X/Twitter URLs. It creates the media row and `media_source_attempts`
  row before provider fetch or retrieval work starts.
- `media_upload_sessions.py`: browser article captures. The extension uploads
  one immutable article packet through the upload-session lifecycle; the media,
  placements, source attempt and job exist only after the packet is verified.
- `x_identity.py`: X/Twitter URL classification and username normalization.
- `x_client.py`: official X API calls, same-author full-archive search,
  provider timeout budgeting, and typed provider failures.
- `x_rendering.py`: stored X thread/post HTML rendering.
- `x_ingest.py`: X same-author thread persistence, quote-post media, refresh,
  provider event recording, and library assignment; no oEmbed fallback.
- `media.py`: catalog/hydration and fragment listing only for web articles.
- `web_article_structure.py`: sanitization, canonical text, and fragment block
  preparation.
- `content_indexing.py` + `media_content_reindex_job`: durable, revision-fenced
  retrieval indexing after readable source artifacts commit.
- `node/ingest/ingest.mjs`: the subprocess request/result boundary;
  `accepted_url_egress.mjs` owns fixed network acquisition policy and
  `article_extraction.mjs` owns readable-document selection. Mozilla
  Readability is the default extractor. A unique authored `main` landmark owns
  its input so longer related-content cards cannot outscore the page body;
  absent, multiple, or unreadable main landmarks fall back to the whole
  document. A source-shape-specific pre-extraction for Wikisource proofread
  pages (`.mw-parser-output > .prp-pages-output`) keeps page-body text ahead of
  reference sections before the normal Python source-normalization path.

Routes stay transport-only. X URLs fail closed through `x_ingest.py`; they do
not fall back to generic web article capture or oEmbed. X author-thread media
uses provider identity `author-thread:<x_author_id>:<conversation_id>`;
captured quote posts use `post:<post_id>`. Provider billing, auth, rate-limit,
timeout, and post-unavailable failures surface as their mapped API error and a
`x_provider_failure` warning log.

A browser article capture is one immutable packet (`schemas/extension_capture.py`:
`url`, `base_url`, `title`, readable `content_html`, bounded embed-evidence
`source_html`, and `Presence` metadata), uploaded and verified through the
upload-session lifecycle and referenced only by the attempt's
`source_payload.storage_path`. `media_source_adapters._run_browser_article_capture`
decodes that packet with the same strict model, composes
`prepare_web_article_fragment` with the packet's base url and evidence, and
persists title, byline, excerpt, site name and published time from the packet at
publication. Retries carry the payload unchanged, so the packet reference is
never lost. Sanitization, no-readable-text, and metadata failures update the
media row and latest source attempt instead of dropping the capture. Retrieval
failure never rewrites successful source truth; its current durable job is
pending, running, or visibly suspended.

## node acquisition contract

the subprocess accepts exactly `url` and integer `timeout_ms` (1–120000) on
stdin. it returns protocol version 1 with a success or modeled source failure
on stdout; invalid invocation and unexpected defects use stderr and a nonzero
exit. success preserves final/base url, raw source html, readable html, and
bounded article metadata. the python adapter owns the outer 40-second timeout.

acquisition admits http(s) urls without credentials or control characters,
removes fragments, and caps urls at 2048 utf-8 bytes. every redirect gets fresh
dns admission: all answers must be public, the first answer is dialed directly,
and the socket peer is checked before the request. tls verifies the original
hostname. five redirects are allowed; automatic redirects and proxy-based
resolution are absent.

only html/xhtml is accepted. identity, gzip, deflate, and brotli bodies retain
separate 10 mib wire, decompressed, decoded-codepoint, and utf-8 source bounds.
charset decoding tries the header, then the first 2048 bytes of html metadata,
then utf-8. the acquisition deadline cancels network work; each hop closes its
response, agent, and socket. extraction runs without executing page scripts.

manual verification: import a public article and its redirecting url through
the node entrypoint, compare final urls and readable/source html, then verify
that a loopback url returns `UnsafeDestination`. the repository static gate
does not check node javascript; report these observations separately.

## Browse And Preview

Browse composes the read-only Brave helper for external Web Article search and
the Nexus adapter for already-owned articles. Brave results carry sealed
discovery targets; Preview safe-fetches current provider/source truth, proxies
remote artwork, and exposes **Open source**. Arbitrary web content is never
framed. Browse and Preview write no Media, source attempt, Library entry, job,
or progress/activity fact.

Owned collisions open the canonical Media pane. External Add supplies the
server-resolved canonical URL to `/media/from_url`, so the existing URL
validation, safe fetch, dedupe, source-attempt, Library assignment, and worker
owners above remain the acquisition path. The read-only Brave helper may also
be composed by chat/Dossier web research; that does not recreate a standalone
Web Search product surface.

## Reader Apparatus

Web article reader apparatus extraction is owned by `html_apparatus.py`, called
from the web article structure pipeline before sanitization strips semantic
source attributes. One generic extractor walks numbered markers to their local
targets: DPUB-ARIA `doc-noteref` / `doc-biblioref` roles, JATS `xref @rid` with
`ref-type="fn"|"bibr"`, and `<sup><a href="#…">` links whose target carries a
backlink. Declared semantics give `exact` confidence; link-graph evidence gives
`strong`. Standalone `span.marginnote` elements surface as target-only
`margin_note` source-reference facts in Document Map Evidence with no synthetic
marker edge. They answer the Citations filter without collapsing into generated
citations. The parser does not infer apparatus from bare superscripts or
client-rendered DOM heuristics.

HTML bibliography support is intentionally link-layer conservative. MediaWiki
`sup.reference -> li#cite_note` note graphs are supported through the link-graph
branch. Bibliography records with no in-document marker are out of scope and are
not standalone apparatus rows.
