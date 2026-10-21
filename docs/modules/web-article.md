# Web Articles

Web article media is `media.kind = 'web_article'`, but source ownership is split
by provenance.

- `media_source_ingest.py`: durable accepted source attempts for generic web
  URLs and X/Twitter URLs. It creates the media row and `media_source_attempts`
  row before provider fetch or retrieval work starts.
- `media_upload_sessions.py`: browser article captures. The extension uploads
  one immutable article packet through the upload-session lifecycle; the media,
  placements, source attempt and job exist only after the packet is verified.
- `x_identity.py`: X/Twitter URL classification and provider ids.
- `x_client.py`: official X API v2 snapshots (lookup, same-author full-archive
  search, quote lookup) over `net/http_retry`; provider failures become their
  `E_X_*` error where the response is seen.
- `x_rendering.py`: literal canonical post HTML and escaped article prose. threads compose saved post sources.
- `x_ingest.py`: canonical post publication, revision aliases, proved thread
  membership and supersession. it reuses `web_article.prepare_article` and
  `replace_article_fragments`; threads and quotes compose those saved sources.
- `media.py`: catalog/hydration and fragment listing only for web articles.
- `web_article_structure.py`: sanitization, canonical text, and fragment block
  preparation.
- `source_adapters.py`: detached acquisition and explicit per-family
  prechecks, preparation and fenced publication ([ingest](ingest.md)).
- `source_outcome.py`: native contributor targets, follow-up intent and pdf text
  availability; one public job-result projection excludes private observations.
- `web_article.py`: fetched-article acquisition (egress, then the node filter)
  and the shared article transaction projection for fetched pages, browser captures,
  native x articles and emails: prepare outside any transaction, then one fenced serializable
  phase that discovers pre-existing embed children before locking, replaces
  fragments/blocks/apparatus, replaces (or, without embed extraction, purges)
  the embed artifact, and applies metadata (title overwritten when non-blank;
  description and publisher filled only when empty; edition date when it parses).
- `content_indexing.py` + `media_content_reindex_job`: durable, revision-fenced
  retrieval indexing after readable source artifacts commit; one block per
  canonical line, chunked and embedded by `content_chunking.py`.
- `node/ingest/ingest.mjs`: a readability filter over bytes python already
  fetched (protocol 2, below); `article_extraction.mjs` owns readable-document
  selection (the extension bundles it). Mozilla
  Readability is the default extractor. x article pages instead require the
  qualified `twitterArticleReadView` root and its rich-text body; unsupported
  layouts refuse rather than invoking Readability. authored metadata and source
  evidence come from that root too. A unique authored `main` landmark owns
  its input so longer related-content cards cannot outscore the page body;
  absent, multiple, or unreadable main landmarks fall back to the whole
  document. A source-shape-specific pre-extraction for Wikisource proofread
  pages (`.mw-parser-output .prp-pages-output`) keeps page-body text ahead of
  reference sections before the normal Python source-normalization path.

Routes stay transport-only. X URLs fail closed through `x_ingest.py`; they do
not fall back to generic web article capture or oEmbed. X author-thread media
uses provider identity `author-thread:<x_author_id>:<conversation_id>`;
captured quote posts use `post:<post_id>`. Provider billing, auth, rate-limit,
timeout, and post-unavailable failures surface as their mapped API error and a
`x_provider_failure` warning log.

A browser article capture is one immutable packet (`schemas/extension_capture.py`:
`url`, `base_url`, `title`, readable `content_html`, bounded embed and note
evidence in `source_html`, and nullable metadata), uploaded and verified through the
upload-session lifecycle and referenced only by the attempt's
`source_payload.storage_path`. `source_adapters.acquire`
decodes that packet with the same strict model, composes
`prepare_web_article_fragment` with the packet's base url and evidence, and
persists title, byline, excerpt, site name and published time from the packet at
publication. Retries carry the payload unchanged, so the packet reference is
never lost. Sanitization, no-readable-text, and metadata failures update the
media row and latest source attempt instead of dropping the capture. Captures,
fetched pages and emails publish through `web_article.publish_article`; native
x articles and matched browser replacements use `PreparedNativeArticle` in the
source runner's terminal transaction. Retrieval
failure never rewrites successful source truth; its current durable job is
pending, running, or visibly suspended.

## native x articles

native identity is `provider=x`, `provider_id=article:<id>`, with a verified
`canonical_source_url` and null `canonical_url`. only the submitted carrier's
article is admitted alongside its independent author thread. the official api
supplies actual `article.plain_text`; blank, missing, malformed or teaser-only
responses fail. line breaks are preserved, html escaped, and formatting/media
are not inferred. source title/byline/date are absolute, nullable observations;
native articles never receive generated metadata.

`x_article_sources` names the current publication's attempt and completeness.
`x_source.x_article_content_facts` projects one nullable `x_article_content`
value into catalog, reader, public, offline and authorized previews. representation
derives from the publishing attempt: `api_text` or `browser_capture`.
completeness is `unknown` unless a qualified official truncation signal establishes
`incomplete`; no such provider signal is currently qualified. neither browser
extraction nor a plausible ending establishes completeness. reader notices and
preview excerpts stay outside canonical text, selection and search offsets.
representation limits remain visible without opening a disclosure. explicit
busy/progress states inside the qualified x article body refuse capture.

the runner commits body, reader generation, source-owned metadata/credits,
current facts, attempt success and index admission together. failure retains
the previous publication and its facts. matching browser capture replaces the
native resource in place, preserving filing and annotations; ambiguous/missing
quotes and cursors retain their evidence unresolved. manual relocation selects
the retained quote under shared normalization, without rewriting it. browser
publication refuses api refresh and queued api publication; capture again is
the update path. see [ingest](ingest.md) for target binding and retry contracts.

## acquisition and the node filter

python owns every untrusted fetch (`net/safe_fetch.safe_stream`, below). the
article profile sends `User-Agent: NexusBot/1.0 (+https://nexus.example.com/bot)`,
`Accept: text/html,application/xhtml+xml`, `Accept-Encoding: gzip, deflate` and
`Accept-Language: en-US,en;q=0.5`; follows at most five redirects on any port;
refuses a non-html/xhtml media type before reading the body; and caps the
decompressed body at 10 MiB inside one 30-second deadline.

`node ingest.mjs <final_url> <raw content-type or "">` reads the page bytes on
stdin and prints one json line, protocol 2:
`{"version":2,"tag":"Success","final_url","base_url","title","content_html","source_html","byline","excerpt","site_name","published_time"}`
(absent metadata is "") or `{"version":2,"tag":"Failure","failure":"Readability"|"TooLarge"}`.
it decodes as a browser does (header charset, then a `<meta>` in the first 2048
bytes, then utf-8; whatwg labels), refuses more than 10 MiB of utf-8, and runs
jsdom without scripts. a defect prints its stack on stderr and exits nonzero;
python treats that, bad json, a wrong version or shape as an untyped (retried)
failure, and kills the child after 40 seconds (`E_INGEST_TIMEOUT`).
`NODE_INGEST_SCRIPT` declares the absolute script path. its default is the
checkout's `node/ingest/ingest.mjs`; the worker image bakes
`/app/node/ingest/ingest.mjs`. node is resolved on the runtime's own path.
`document_url` identifies the actual page and its authored fragment targets;
`base_url` resolves relative assets and external links, including authored `<base>`.

failures, decided by code alone: blocked `E_SSRF_BLOCKED`, 401/403
`E_SOURCE_ACCESS_DENIED`, 404/410 `E_SOURCE_GONE`, not html
`E_INVALID_CONTENT_TYPE`, too large `E_SOURCE_TOO_LARGE`, no article or blank
prepared text `E_SOURCE_NOT_READABLE`, preparation failure
`E_SANITIZATION_FAILED` (all terminal); fetch or extraction timeout
`E_INGEST_TIMEOUT` and other statuses, network failures and redirect overflow
`E_SOURCE_FETCH_FAILED` retry.

## egress

`net/safe_fetch.safe_stream` is the one untrusted egress (articles, feeds,
chapters, transcript sidecars, remote files, the image proxy, the gutenberg
catalog, browse preview). per hop it applies `url_normalize.validate_requested_url`,
refuses control characters and disallowed ports, resolves the host once, and
requires every answer to pass `url_normalize.is_public_ip` (the iana
special-purpose blocks as data, ipv6 only in 2000::/3). each hop gets its own
httpcore pool whose network backend dials only those vetted addresses, in
order, moving to the next only when a tcp connection cannot be made (each
spends at most its share of the time left); the url keeps the hostname, so the
`Host` header, tls server name and cookies are the host's, nothing resolves
twice, and no connection carries one host's tls identity to another. every
socket read, write and tls handshake ends by one whole-call deadline, so a drip
of headers, chunk framing or empty compressed blocks cannot outlive it. gzip
and zlib bodies inflate with an output bound; wire and decoded bytes each stay
under the byte cap. a cookie set on one hop goes to the later hops it is
scoped to (stdlib cookie policy), never past the call. no environment proxy is
honoured. 404/410 are `Gone`, 401/403 `Denied`; `source_fetch_error` maps
reasons to source-ingest codes.

manual verification: the ingest-url harness (`design.md` §12 in the campaign
artifacts) drives article, redirect, charset, gzip, xhtml, `<base>`, wikisource,
cross-host https, failure and private-address journeys through the product,
and checks pinning against a resolver that answers differently per query. the
repository static gate does not check node javascript.

## Browse And Preview

Browse composes the read-only Brave helper for external Web Article search and
the Nexus adapter for already-owned articles. Brave results carry sealed
discovery targets; Preview safe-fetches current provider/source truth, proxies
remote artwork, and exposes **Open source**. Arbitrary web content is never
framed. Browse and Preview write no Media, source attempt, Library entry, job,
or progress/activity fact.

Owned collisions open the canonical Media pane. External Add supplies the
server-resolved canonical URL to `/media/from-url`, so the existing URL
validation, safe fetch, dedupe, source-attempt, Library assignment, and worker
owners above remain the acquisition path. The read-only Brave helper may also
be composed by chat/Dossier web research; that does not recreate a standalone
Web Search product surface.

## Reader Apparatus

Web article reader apparatus extraction is owned by `html_apparatus.py`, called
from the web article structure pipeline before sanitization strips semantic
source attributes. One generic extractor walks numbered markers to their local
targets: DPUB-ARIA `doc-noteref` / `doc-biblioref` roles, JATS `xref @rid` with
`ref-type="fn"|"bibr"`, and `<sup><a href="#…">` links labelled with a number or a
bracketed group label (wikipedia's `[a]`, `[note 1]`; a note only, never a bibliography
entry) whose target carries a backlink to the link's id or to the id of the `sup`
wrapping it (parsoid, wikipedia's html, gives every element an id of its own, and a
note returns to its `sup`).
Declared semantics give `exact` confidence; link-graph evidence gives `strong`.
Standalone `span.marginnote` elements surface as target-only
`margin_note` source-reference facts in Document Map Evidence with no synthetic
marker edge. They answer the Citations filter without collapsing into generated
citations. The parser does not infer apparatus from bare superscripts or
client-rendered DOM heuristics. An article whose notes exceed the apparatus budget
(10,000 targets, 2 MiB of retained target text, 100,000 backlinks) publishes with no
apparatus: its notes stay inline body text and the publication carries one
`TooManyNotes` source issue.

HTML bibliography support is intentionally link-layer conservative. MediaWiki
`sup.reference -> li#cite_note` note graphs are supported through the link-graph
branch. Bibliography records with no in-document marker are out of scope and are
not standalone apparatus rows.

document embed presentation preserves the published source figure/figcaption
and its highlight nodes as visible canonical text.
`lib/documentReader/text/TextSurface.tsx` renders interactive card metadata/actions
into slots under the renderer-only `data-document-embed-ui` marker;
`lib/documentReader/text/geometry.ts` excludes that subtree from the text cursor
before text or block separators enter offsets. the added UI is nonselectable;
the source caption remains selectable. x compact references wrap the existing
caption nodes in their activation link. `Pending` names a display state, which
also covers resolved children without an authorized href; it does not equate
to a resolving child or introduce polling.

native x article references use the existing `link_preview` card after the
canonical carrier post. the post owns only a renderer-level `x article` caption
and source link. the reader binds `locator.unit_id` to each occurrence; public
projection remaps it before removing private source identities. the card owns
no canonical text span. a child resource identity alone
is not a readable publication: each read derives state and failure from the
authorized child, so retry admission does not depend on a parent cache write.
pending and failed article children expose no provisional
title or local open action; the original x link remains. article body
unavailability has explicit copy and a `view import` action to the authorized
child's imports row for recovery. the card stays outside canonical offsets,
so its state changes do not change the thread's text or indexing.

the visible reader observes each distinct authorized article child through its
existing persistent media processing stream. each state rereads the parent
publication; an unchanged publication identity refreshes its title and
embed presentation while retaining canonical units, measured geometry,
navigation and unsaved progress. a final stream failure makes one such reread.
idle children remain observed, so retries from another pane or tab update the
card. pane reentry receives the current state even if a retry started while the
reader was hidden.

when that child is missing or inaccessible, its identity, metadata, error and
processing state are absent from the projection. nullable resolution/display
fields leave only the parent's caption and source link, without claiming that
the private child is pending or failed.

manual qualification observed the actual pending reader, document map, find,
and two native before/after highlights with persisted offsets; an owner-controlled
resolved transition retained those highlights and controls on reload. six
imported render/cursor cases preserved canonical text; four previously accepted
projections and widget fields/actions matched exactly. unicode/highlight range
roundtrips passed. terminal/x
derivatives were projection-only; external navigation, worker/provider
completion, and actual progress writes were not exercised. static checks are
separate from these observations.
