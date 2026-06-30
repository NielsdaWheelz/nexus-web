# Web article inline embeds hard cutover

## Status

Draft target-state contract. This is a hard cutover plan for source-authored
inline embedded resources in readable documents, starting with generic web
articles and Substack-style articles that contain YouTube videos and X/Twitter
posts.

The final implementation removes silent embed loss as a valid success path. It
does not preserve runtime compatibility branches, reader-side raw-iframe
fallbacks, oEmbed fallbacks for X, or permissive sanitizer behavior for old
clients.

## Summary

Nexus currently treats generic web articles as text-first Readability output.
That correctly protects the reader from arbitrary third-party scripts and frames,
but it silently drops source-authored embedded resources such as:

- YouTube iframes inside Substack articles,
- X/Twitter embedded posts,
- provider-specific iframes,
- native or unknown video embeds.

The target state is a first-class source-authored embedded-resource system:

- raw provider HTML remains untrusted and never enters the reader as executable
  markup,
- embed facts are extracted before sanitization strips source attributes and
  iframe markup,
- each detected occurrence is persisted as a current document artifact,
- supported providers materialize child media through existing source/provider
  owners,
- unsupported providers are visible as explicit unsupported placeholders,
- failures are visible, typed, retryable where the owning source is retryable,
- the reader renders typed embed cards and controlled provider components, not
  raw third-party HTML,
- the Document Map exposes an Embeds lens so missing, failed, unsupported, and
  resolved embeds are inspectable.

The product tradeoff is explicit: for this one-user prototype, Nexus preserves
current embedded-resource structure for the current readable artifact. It does
not preserve historical embed occurrence versions after reprocessing.

## Scope

In scope:

- generic web article URL ingest,
- browser article capture,
- Substack-style articles saved through either path,
- source-authored inline YouTube videos,
- source-authored inline X/Twitter posts,
- unsupported iframe/video/provider placeholders,
- current document embed occurrence persistence,
- child media materialization for supported providers,
- graph relationships from parent media to child media,
- fragment and Document Map API contracts,
- reader inline cards and Document Map Embeds lens,
- security headers/CSP alignment for any interactive frame,
- deterministic fixtures, integration tests, and real-media acceptance.

Out of scope for the first implementation:

- arbitrary provider iframe playback,
- native Substack video playback without a provider-specific contract,
- generic oEmbed runtime,
- historical embed occurrence browsing,
- merging child media text into parent article chunks,
- generated summary or Library Intelligence changes beyond consuming the current
  graph/read models they already use.

## Goals

- Preserve source-authored embedded-resource structure before sanitizer loss.
- Keep the sanitized article reader inert and same-system-owned.
- Make supported embeds visible inline and inspectable in Document Map.
- Materialize supported embedded resources through existing provider/source
  owners.
- Represent parent-child relationships through the resource graph.
- Keep parent document readiness independent from embedded-resource resolution.
- Make unsupported and failed embeds explicit product states.
- Avoid duplicate URL/provider parsing in frontend code.
- Provide a complete schema, migration plan, API contract, test plan, and
  production acceptance checklist.
- Remove the current silent-loss behavior as an accepted final state.

## SME framing

A subject matter expert would not ask "How do we let Substack iframes through?"
That question starts at the wrong layer.

The expert questions are:

- Which source-authored embedded resources exist in the raw source?
- Which parser owns turning raw page markup into typed embed facts?
- Which provider owner supplies provider truth for each fact?
- Which durable current artifact represents the occurrence inside the parent
  document?
- Which child media item, if any, represents the embedded resource?
- Which graph edge relates the parent document to the child media?
- Which target statuses are user-visible when a provider is unavailable,
  unsupported, forbidden, or not yet resolved?
- Which reader surface renders inline content without executing arbitrary
  third-party HTML?
- Which tests prove an embed cannot disappear silently again?

The mature pattern is source-owned extraction into a typed domain model,
provider-owned materialization, and reader-owned rendering from safe same-system
payloads.

## Governing codebase rules

This cutover follows the existing repo rules:

- `docs/rules/boundaries.md`: parse and narrow untrusted page/provider input at
  ingress. Downstream code must not re-parse raw iframe/script markup.
- `docs/rules/cleanliness.md`: one owner per concern, no duplicate
  sanitizers, no fallback branches, no compatibility lanes.
- `docs/rules/database.md`: use a concrete relational table for occurrence rows
  because embedded resources have identity, lifecycle, query, graph, and reader
  behavior. Do not hide this in generic JSON metadata.
- `docs/rules/frontend.md`: frontend components consume same-system API
  contracts. They must not reconstruct backend lifecycle or trust third-party
  markup.
- `docs/rules/testing.md` and `docs/local-rules/testing_standards.md`: verify
  behavior through public service/API/UI surfaces, with real external providers
  mocked only at the true external boundary.
- `docs/modules/web-article.md`: web article apparatus and source-authored
  semantics are extracted before sanitization removes attributes.
- `docs/cutovers/durable-source-ingest-hard-cutover.md`: accepted source intents
  are durable; provider/fetch/sanitization failures do not erase the user-visible
  item.
- `docs/cutovers/x-ingest-provider-hard-cutover.md`: X uses official API capture,
  no scraping, no oEmbed, no generic fallback.
- `docs/cutovers/media-document-readiness-hard-cutover.md`: document readiness,
  retrieval readiness, and feature capabilities are separate.
- `docs/cutovers/current-only-artifacts-hard-cutover.md`: readable artifacts and
  source-derived projections are current-only.

## Existing systems and subsystems

### Source acceptance

Owner: `python/nexus/services/media_source_ingest.py`.

Existing responsibilities:

- URL classification,
- durable `media` row creation,
- durable `media_source_attempts` row creation,
- queueing `ingest_media_source`,
- source retry and refresh,
- post-acceptance failure persistence.

Inline embeds compose with this owner. Embedded child media creation is an
internal source-acceptance command, not a frontend route and not a direct insert.

### Generic web extraction

Owners:

- `node/ingest/ingest.mjs`
- `python/nexus/services/node_ingest.py`
- `python/nexus/services/web_article_ingest.py`
- `python/nexus/services/web_article_structure.py`

Current behavior:

- fetches source HTML,
- runs Mozilla Readability,
- returns `content_html` and `source_html`,
- builds sanitized HTML and canonical text from `content_html`,
- extracts reader apparatus from source HTML when needed,
- persists `fragments` and content blocks.

Inline embeds extend this layer with a source-HTML/source-content embed extractor
that runs before sanitizer loss.

Source-only embeds discovered in `source_html` but absent from the readable
`content_html` are persisted without canonical offsets. They must not be
rendered at an invented end-of-document location; inline cards require an
authored placeholder in the sanitized readable fragment.

### Browser article capture

Owners:

- `apps/extension/content.js`
- `python/nexus/services/media_source_ingest.py`

Current behavior:

- extension sends Readability article content,
- backend persists the captured source artifact for browser capture,
- backend prepares sanitized fragments.

Inline embeds require browser capture parity: the extension must submit enough
source information for embedded-resource extraction, not only Readability
content that may have already lost iframe data.

### Sanitization

Owner: `python/nexus/services/sanitize_html.py`.

Current behavior:

- raw `script`, `iframe`, `object`, `embed`, `svg`, forms, styles, and unknown
  attributes are stripped,
- images are rewritten through the media image proxy,
- `HtmlRenderer` receives only same-system sanitized HTML.

This remains true. The cutover must not allow raw iframes or third-party scripts
through `html_sanitized`.

### X provider

Owners:

- `python/nexus/services/x_identity.py`
- `python/nexus/services/x_client.py`
- `python/nexus/services/x_ingest.py`
- `python/nexus/services/x_rendering.py`
- `python/nexus/services/provider_events.py`

Existing direct X URL behavior:

- direct X URL ingest creates `x_author_thread`,
- provider truth comes from the official X API,
- quote posts are separate child media with `provider_id = "post:<post_id>"`,
- raw oEmbed/widget HTML is not used.

Inline X embeds reuse this provider boundary but represent the source-authored
embed as a single-post child media. The direct URL `x_author_thread` behavior is
not widened to mean every inline post.

### YouTube provider and playback

Owners:

- `python/nexus/services/youtube_identity.py`
- `python/nexus/services/youtube_video_ingest.py`
- `python/nexus/services/playback_source.py`
- `apps/web/src/lib/security/youtube.ts`
- `apps/web/src/lib/security/csp.ts`
- `apps/web/src/lib/security/headers.ts`
- `apps/web/src/app/(authenticated)/media/[id]/TranscriptPlaybackPanel.tsx`

Existing behavior:

- YouTube URL ingest creates first-class `video` media,
- playback source exposes validated `embed_url`,
- frontend validates YouTube embed hosts and paths again,
- CSP and Permissions-Policy allow only the supported YouTube frame origins.

Inline YouTube embeds reuse this model. They do not introduce arbitrary iframe
allowlists.

### Resource graph

Owner: `python/nexus/services/resource_graph/*`.

Current role:

- `resource_edges` is the single durable positive connection table,
- edge origins define the writer and cleanup contract,
- note body `object_embed` references already sync into graph edges,
- reader connections consume graph edges through the Document Map.

Inline embeds need a new graph origin only for materialized child resources.
The occurrence itself is not a graph edge; the occurrence is document structure.

### Reader and Document Map

Owners:

- `python/nexus/services/reader_document_map.py`
- `python/nexus/schemas/reader_document_map.py`
- `apps/web/src/components/reader/*`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/TextDocumentReader.tsx`
- `apps/web/src/components/HtmlRenderer.tsx`

Current role:

- `HtmlRenderer` is the only `dangerouslySetInnerHTML` sink,
- Document Map contains Contents, Highlights, Citations, Connections, and Chat,
- target statuses include `exact`, `container`, `missing`, `forbidden`,
  `unanchorable`, `stale`, `unsupported`, and `partial`.

Inline embeds add a source-authored Embeds lens and inline typed embed slots.

### Search, indexing, and chat evidence

Owners:

- `python/nexus/services/content_indexing.py`
- `python/nexus/services/web_article_indexing.py`
- `python/nexus/services/search/*`
- `python/nexus/services/context_assembler.py`

Current role:

- content blocks and chunks are text/canonical-locator based,
- search and chat evidence require current active index state,
- source-derived projections are current-only.

Inline embeds contribute explicit textual placeholders to canonical text and may
create graph-connected child media. They do not inject child transcript text into
the parent document index unless a later product decision explicitly adds a
cross-resource retrieval mode.

## Target behavior

### Reader-visible behavior

When a web article contains a supported inline YouTube video:

- the article reader shows a visible inline video card at the authored location,
- the card can open/play through the same controlled YouTube embed contract used
  for video media,
- the child video media can be opened as a normal resource,
- the Document Map Embeds lens lists the video occurrence,
- the parent article remains readable if the child video metadata or transcript
  materialization is still pending.

When a web article contains an embedded X/Twitter post:

- the article reader shows a static archived post card at the authored location,
- the card uses official X API snapshot data when available,
- the card never uses X widget JavaScript or oEmbed HTML,
- the child X post media can be opened as a normal resource,
- the Document Map Embeds lens lists the post occurrence,
- provider failure is explicit and does not erase the article.

When a web article contains an unsupported embedded provider:

- the reader shows an unsupported embed card at the authored location,
- the card names the provider or URL when safe,
- the Document Map Embeds lens lists the occurrence as `unsupported`,
- the parent article remains `ready_for_reading`.

When embed extraction itself fails because the source markup is malformed:

- the parent article does not fail if readable prose was materialized,
- the Embeds lens is `partial` or `failed`,
- diagnostics name the owner-stage error without exposing secrets or raw HTML.

When a source is refreshed or retried:

- current fragments, content blocks, document embed rows, and document-embed graph
  edges are replaced as one current artifact set,
- old embed occurrences are deleted, not hidden behind a compatibility path,
- stale reader targets fail closed.

### Security behavior

- Raw iframe HTML is never persisted in `fragments.html_sanitized`.
- Raw provider widget scripts are never persisted in `fragments.html_sanitized`.
- `HtmlRenderer` remains the only raw sanitized-HTML sink.
- Interactive playback is rendered only by typed React components that validate
  provider, origin, path, and permission contract.
- CSP `frame-src` is widened only when a provider has a typed runtime validator,
  a Permissions-Policy entry, tests, and an owner.
- Unknown providers do not get frame permission.

### Product behavior

- Parent article readability is not blocked by child embed provider availability.
- Child embeds are discoverable without opening browser dev tools.
- The user can open materialized child media as normal library media.
- Unsupported or failed embeds are visible content, not invisible loss.
- Direct ingesting the same YouTube/X URL reuses canonical child media where the
  provider identity matches.

## Non-goals

- No raw iframe passthrough in article HTML.
- No raw `script` passthrough in article HTML.
- No X oEmbed runtime.
- No generic oEmbed fallback for X.
- No headless-browser execution of arbitrary article JavaScript as the primary
  generic ingestion path.
- No blanket CSP allowlist for Substack, X, Vimeo, Spotify, or arbitrary hosts.
- No historical replay of old embed occurrence versions.
- No compatibility API that keeps returning old fragment-only shapes after the
  hard cutover.
- No attempt to make every iframe provider playable in the first implementation.
- No child transcript text merged into the parent article's canonical text.
- No frontend-only DOM scan that re-discovers provider URLs after render.

## Key decisions

### Decision 1: introduce `document_embeds`

Inline embed occurrences need first-class relational identity because they have:

- owner media,
- document order,
- locator behavior,
- provider status,
- child media linkage,
- Document Map rows,
- graph composition,
- current-only replacement semantics,
- retry/failure diagnostics.

They do not belong inside `fragments.metadata`, `content_blocks.metadata`, or
`media_source_attempts.source_payload`.

### Decision 2: keep fragment HTML inert

`fragments.html_sanitized` may include only an inert same-system placeholder for
an embed occurrence. It must not include raw provider embed markup.

The placeholder is allowed to carry the stable same-system occurrence id, for
example:

```html
<figure data-nexus-document-embed-id="..." data-nexus-document-embed-kind="youtube_video">
  <figcaption>Embedded video: title unavailable</figcaption>
</figure>
```

Only `data-nexus-*` attributes required for same-system reader slots are
allowlisted. Generic `data-*`, `class`, inline `style`, and provider attributes
remain stripped.

### Decision 3: render typed slots, not widget HTML

The reader receives sanitized fragment HTML plus typed `DocumentEmbedOut`
payloads. Inline rendering binds typed payloads to inert placeholders. The
binding component owns no provider parsing and makes no network calls to discover
what the embed is.

### Decision 4: materialize supported providers as child media

Supported embedded resources become normal media where that matches the existing
domain:

- YouTube video iframe -> child `media.kind = "video"`, source type
  `youtube_video`.
- X embedded post -> child `media.kind = "web_article"`, source type `x_post`,
  provider id `post:<post_id>`.

The parent article points at the child through `document_embeds.target_media_id`
and a graph edge with origin `document_embed`.

### Decision 5: add `x_post` for embedded posts

Direct X URL ingest remains `x_author_thread`. An embedded post represents a
single source-authored post occurrence, not necessarily the full same-author
thread. Add a provider-owned single-post materializer instead of overloading
`x_author_thread`.

### Decision 6: parent readiness is independent from embed resolution

`ready_for_reading` for the parent article means the current readable article
artifact exists. Embedded-resource resolution status is a separate document
embed capability/read model. A failed YouTube/X child must not turn a readable
article into a failed article.

### Decision 7: unsupported is a modeled state

Unknown providers, native Substack video without a stable provider contract, and
malformed embed URLs are modeled as `unsupported` or `failed`. They are not
dropped and they are not passed to the browser as raw HTML.

## Complete system design

### System 1: source embed extraction

Owner:

- new `python/nexus/services/document_embed_extraction.py`

Inputs:

- `source_html`,
- `content_html`,
- base URL,
- source type,
- parent media id,
- source attempt id.

Outputs:

- list of `DetectedDocumentEmbed` domain objects,
- extraction diagnostics.

Responsibilities:

- parse raw HTML with the same HTML parser family used by web article structure,
- inspect source HTML and Readability content HTML,
- detect provider-specific iframe, blockquote, anchor, and data payload patterns,
- treat plain X hyperlinks as links unless they are inside a known
  source-authored embed container,
- normalize to typed detected embed facts,
- assign document-order ordinals,
- compute provisional source locators before sanitization loss,
- preserve only safe URLs and provider identifiers,
- classify unsupported providers explicitly.

Non-responsibilities:

- no provider HTTP calls,
- no database writes,
- no graph writes,
- no reader rendering,
- no child media acceptance.

Supported detector set:

```text
youtube_iframe
x_post_blockquote
x_post_anchor_in_embed_container
generic_iframe
native_video_tag
substack_native_video
unknown_embed
```

Detector output:

```python
DocumentEmbedProvider = Literal[
    "youtube",
    "x",
    "substack",
    "vimeo",
    "spotify",
    "generic",
    "unknown",
]

DocumentEmbedKind = Literal[
    "video",
    "post",
    "audio",
    "link_preview",
    "unknown",
]

DocumentEmbedSourceShape = Literal[
    "iframe",
    "blockquote",
    "anchor",
    "video_tag",
    "provider_json",
    "unknown",
]

@dataclass(frozen=True, slots=True)
class EmbedUrlPresent:
    kind: Literal["present"]
    raw_url: str
    canonical_url: str

@dataclass(frozen=True, slots=True)
class EmbedUrlMalformed:
    kind: Literal["malformed"]
    raw_url: str
    error_code: str

@dataclass(frozen=True, slots=True)
class EmbedUrlAbsent:
    kind: Literal["absent"]
    reason: Literal["not_in_source", "not_applicable"]

EmbedUrlEvidence = EmbedUrlPresent | EmbedUrlMalformed | EmbedUrlAbsent

@dataclass(frozen=True, slots=True)
class EmbedTargetRefPresent:
    kind: Literal["present"]
    value: str

@dataclass(frozen=True, slots=True)
class EmbedTargetRefAbsent:
    kind: Literal["absent"]
    reason: Literal["unsupported_provider", "unparseable", "not_applicable"]

EmbedTargetRefEvidence = EmbedTargetRefPresent | EmbedTargetRefAbsent

@dataclass(frozen=True, slots=True)
class EmbedTextPresent:
    kind: Literal["present"]
    value: str

@dataclass(frozen=True, slots=True)
class EmbedTextAbsent:
    kind: Literal["absent"]
    reason: Literal["not_in_source", "redacted", "not_applicable"]

EmbedTextEvidence = EmbedTextPresent | EmbedTextAbsent

@dataclass(frozen=True, slots=True)
class SourceOffsetPresent:
    kind: Literal["present"]
    start: int
    end: int

@dataclass(frozen=True, slots=True)
class SourceOffsetAbsent:
    kind: Literal["absent"]
    reason: Literal["source_not_offset_addressable", "not_applicable"]

SourceOffsetEvidence = SourceOffsetPresent | SourceOffsetAbsent

@dataclass(frozen=True, slots=True)
class DetectedDocumentEmbed:
    occurrence_key: str
    ordinal: int
    provider: DocumentEmbedProvider
    embed_kind: DocumentEmbedKind
    source_shape: DocumentEmbedSourceShape
    resolution_status: DocumentEmbedResolutionStatus
    source_url: EmbedUrlEvidence
    provider_target_ref: EmbedTargetRefEvidence
    title_hint: EmbedTextEvidence
    authored_text: EmbedTextEvidence
    source_offsets: SourceOffsetEvidence
```

Occurrence key:

- stable only within the current parent artifact,
- deterministic from ordinal, provider, canonical source URL, and nearby source
  context,
- never used as historical identity after refresh.

Boundary rule:

- Detector output is already narrowed domain data. Raw HTML, raw provider
  attributes, and arbitrary stringly source shapes do not cross into persistence
  or API services.
- Absence is represented with owned tagged variants, not naked `None`, at
  detector, domain, API, and TypeScript boundaries. Nullable columns are storage
  details only.

### System 2: safe placeholder rewriting

Owner:

- `python/nexus/services/web_article_structure.py`, using helpers from
  `document_embed_extraction.py`.

Responsibilities:

- replace supported and unsupported raw embed nodes with inert placeholders before
  final sanitization,
- ensure placeholders survive sanitizer with only same-system attributes,
- make placeholders visible in canonical text,
- produce locators into the final sanitized fragment/canonical text.
- preserve source-only detections as unanchored metadata rather than fabricating
  inline placement.

Placeholder text rules:

- YouTube: `Embedded video: <title hint or YouTube video>`
- X: `Embedded X post: <author/text hint or X post>`
- unsupported provider: `Unsupported embedded <kind>: <provider or URL host>`
- malformed: `Embedded content unavailable`

Canonical text must include placeholder text so search, quote context, and
screen readers do not see an empty hole.

### System 3: document embed persistence

Owner:

- new `python/nexus/services/document_embeds.py`

Responsibilities:

- maintain one current artifact-level embed state row for each parent readable
  artifact,
- replace the current embed occurrence set for a parent media item,
- delete prior current rows during reprocessing,
- write the artifact state and occurrence rows after current fragments exist,
- link occurrences to fragments and canonical offsets,
- update target media linkage as child media materializes,
- expose query helpers for fragments, media summary, Document Map, and graph
  cleanup.

Status ownership:

- `document_embed_artifact_states.status` is the canonical aggregate status for
  current embed extraction and child-materialization state.
- `document_embed_summary.status`, the Document Map Embeds lens status, and
  operation diagnostics are projections of that row.
- `empty` means extraction completed and found no occurrences.
- `failed` means extraction failed before trusted occurrence rows could be
  published.
- Occurrence rows own per-embed `resolution_status`; they do not own aggregate
  status.

Public service API:

```python
def replace_document_embed_artifact(
    db: Session,
    *,
    owner_user_id: UUID,
    media_id: UUID,
    source_attempt_id: UUID,
    extraction_result: DocumentEmbedExtractionResult,
    fragment_bindings: Sequence[DocumentEmbedFragmentBinding],
) -> DocumentEmbedArtifactOut:
    ...

def replace_document_embeds_for_media(
    db: Session,
    *,
    owner_user_id: UUID,
    media_id: UUID,
    source_attempt_id: UUID,
    detected: Sequence[DetectedDocumentEmbed],
    fragment_bindings: Sequence[DocumentEmbedFragmentBinding],
) -> list[DocumentEmbedOut]:
    ...

def list_document_embeds_for_fragments(
    db: Session,
    *,
    viewer_id: UUID,
    fragment_ids: Sequence[UUID],
) -> dict[UUID, list[DocumentEmbedOut]]:
    ...

def list_document_embeds_for_document_map(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
) -> list[DocumentEmbedOut]:
    ...

def set_document_embed_target_media(
    db: Session,
    *,
    owner_user_id: UUID,
    embed_id: UUID,
    target_media_id: UUID,
    status: DocumentEmbedResolutionStatus,
) -> None:
    ...
```

Transaction rules:

- `replace_document_embed_artifact` runs in the same transaction that publishes
  the current readable artifact. No public read may observe new current
  fragments with missing or stale embed state.
- If extraction fails before trusted occurrences exist, the same transaction
  publishes the readable artifact with a `failed` artifact state and zero
  occurrence rows.
- Child source attempts may be created after parent artifact publication. Their
  later completion updates `target_media_id` and resolution status in their own
  source-owner transactions.
- Every status update sets `updated_at = now()` in application SQL. No trigger is
  used.
- No helper commits. Callers own the transaction boundary.

### System 4: embedded child source acceptance

Owner:

- `python/nexus/services/media_source_ingest.py`

New internal command:

```python
def accept_embedded_source(
    db: Session,
    *,
    parent_media_id: UUID,
    document_embed_id: UUID,
    actor_user_id: UUID,
    source_url: str,
    source_type: SourceType,
    provider_target_ref: EmbedTargetRefEvidence,
    library_ids: Sequence[UUID],
    request_id: str | None,
) -> EmbeddedSourceAcceptance:
    ...
```

Responsibilities:

- create or reuse child media through the same canonical source/provider identity
  rules as direct ingest,
- create a child `media_source_attempts` row,
- store the parent `document_embed_id` in child attempt `source_payload`,
- enqueue `ingest_media_source`,
- return child media id and attempt id,
- leave the parent article readable even if child enqueue/materialization fails.

Child library assignment:

- child media inherits the parent media's default plus selected library
  destinations,
- child media is normal media and can be opened, searched, deleted, and retried
  through existing capability gates,
- deletion must remove or mark parent embed target linkage through explicit
  cleanup.

### System 5: X single-post materialization

Owners:

- `python/nexus/services/x_identity.py`
- `python/nexus/services/x_client.py`
- `python/nexus/services/x_ingest.py`
- `python/nexus/services/x_rendering.py`

New source type:

```text
x_post
```

Target behavior:

- source URL or provider target ref identifies one post id,
- provider call uses official X API,
- materialized media uses `provider = "x"` and `provider_id = "post:<post_id>"`,
- rendered child fragment is static sanitized HTML from provider snapshot,
- unavailable/private/deleted/rate-limited/provider errors are typed provider
  failures,
- no oEmbed or widget JavaScript.

Reuse:

- factor existing quote-post materialization into a reusable single-post
  materializer,
- direct X URL author-thread capture can continue creating quote children with
  the same lower-level single-post helper.

### System 6: YouTube embed child materialization

Owners:

- `python/nexus/services/youtube_identity.py`
- `python/nexus/services/youtube_video_ingest.py`
- `python/nexus/services/playback_source.py`

Target behavior:

- YouTube iframe `src` and watch URLs normalize to the same video id,
- child media uses `kind = "video"`,
- child source type remains `youtube_video`,
- playback source remains the single embed URL contract,
- iframe rendering uses the same host/path validation and CSP as normal video
  media.

No new YouTube-specific reader iframe code is allowed outside the shared typed
embed component and existing playback validation helpers.

### System 7: resource graph composition

Owner:

- `python/nexus/services/resource_graph/*`

New edge origin:

```python
EdgeOrigin = Literal[
    ...,
    "document_embed",
]
```

Policy:

```text
origin = "document_embed"
writer = "document_embeds child-link sync"
user_id = parent media owner user id
allowed_kinds = ("context",)
source_schemes = ("media",)
target_schemes = ("media",)
ordinal = forbidden
snapshot = forbidden
source_order = forbidden
target_order = forbidden
cleanup = replace with current document embeds; delete with parent or child
search_activation = allowlisted_only
rendering = source-authored embedded resource
```

Rules:

- A graph edge exists only when the embed has a materialized child media item.
- Edges are written once for the parent media owner. The service does not create
  per-viewer edges and does not use the request viewer id as edge ownership.
- Read APIs still apply viewer access checks before exposing child media links.
- Unsupported embeds do not create graph edges.
- The `document_embeds` table owns occurrence order and locator data.
- The graph edge only represents the positive resource relationship.
- `replace_edges_for_origin` must replace only the `document_embed` set for the
  parent media and must not touch user, citation, note body, highlight note, or
  synapse edges.
- `document_embed` must be added to connection visibility allowlists only where
  source-authored child media belongs: `reader_connections.READER_CONNECTION_ORIGINS`
  and `resource_graph.connection_summaries.LIST_CONNECTION_ORIGINS`.
- The policy layer rejects `document_embed` edges with non-media schemes,
  ordinals, snapshots, source/target order fields, or unsupported kinds.

### System 8: API contracts

Owners:

- `python/nexus/schemas/media.py`
- `python/nexus/schemas/reader_document_map.py`
- `python/nexus/api/routes/media.py`
- `python/nexus/api/routes/reader.py`

Hard-cutover API behavior:

- `GET /media/{id}/fragments` returns fragment-scoped embed payloads.
- `GET /media/{id}/document-map` includes an Embeds lens and embed items.
- `GET /media/{id}` exposes derived embed capability/status summary through the
  media capability/read model.
- No new frontend BFF business route is added unless the FastAPI API genuinely
  needs a new public capability.

Fragment enrichment contract:

- The fragment service loads fragments first, then batch-loads
  `document_embeds` by fragment ids in one query ordered by `(fragment_id,
  ordinal, id)`.
- Non-supporting media and fragments without embeds return `document_embeds: []`,
  never omitted fields.
- Target enrichment resolves child permission, href, playback source, retry
  capability, and display content in backend services before serialization.
- If the viewer cannot access a child media item, the embed stays visible with
  `target.status = "forbidden"` and no child href/playback source.
- `DocumentEmbedOut` is serialized from narrowed domain objects; the API does not
  expose raw provider HTML or raw provider attribute bags.

Route and proxy constraints:

- Prefer extending existing FastAPI media routes over adding new `/api/*`
  frontend routes.
- If a new FastAPI route uses a literal `/media/<literal>` path, router ordering
  must keep it above dynamic `/media/{id}` handlers.
- If any new Next `/api/*` route is added, update
  `apps/web/src/app/api/proxy-routes.test.ts` and intentionally adjust
  `API_ROUTE_COUNT`.
- If existing proxied routes are only extended, add route tests proving the BFF
  remains proxy-only and does not gain embed business logic.

### System 8.1: capability contract

Owner:

- `python/nexus/services/capabilities.py`

Capability rules:

- `can_read` answers only whether the parent media's readable document surface is
  available.
- `can_read_embeds` answers whether the current media kind and artifact support
  document embed rows and inline embed rendering.
- `document_embed_summary.status` answers the aggregate state of current
  embedded-resource occurrences.
- The summary status is `DocumentEmbedAggregateStatus`, sourced from
  `document_embed_artifact_states.status`.
- The Document Map Embeds lens uses the same aggregate status enum, including
  `resolving`.
- `document_embed_summary.status` never overrides parent `processing_status`.
- Frontend code consumes `can_read_embeds` and `document_embed_summary`; it does
  not derive embed support from `media.kind`, `processing_status`, or fragment
  HTML.

Aggregate status rules:

```text
unsupported:
  media kind or artifact type cannot support document embeds

empty:
  extraction completed, media kind supports embeds, and the current artifact has
  no occurrences

resolving:
  one or more supported embeds are accepted for child materialization and none
  have failed

ready:
  all detected embeds are resolved or explicitly unsupported

partial:
  a mix of resolved, unsupported, pending, resolving, or failed rows exists

failed:
  embed extraction failed before trusted occurrence rows could be published
```

Fragment response extension:

```python
class FragmentOut(BaseModel):
    id: UUID
    media_id: UUID
    idx: int
    html_sanitized: str
    canonical_text: str
    document_embeds: list[DocumentEmbedOut] = Field(default_factory=list)
    ...
```

Media capability extension:

```python
class CapabilitiesOut(BaseModel):
    can_read: bool
    can_highlight: bool
    can_quote: bool
    can_search: bool
    can_play: bool
    can_download_file: bool
    can_delete: bool = False
    can_retry: bool = False
    can_refresh_source: bool = False
    can_retry_metadata: bool = False
    can_read_embeds: bool = False
```

Media read-model extension:

```python
DocumentEmbedAggregateStatus = Literal[
    "unsupported",
    "empty",
    "resolving",
    "ready",
    "partial",
    "failed",
]

class DocumentEmbedSummaryOut(BaseModel):
    status: DocumentEmbedAggregateStatus
    total_count: int
    resolved_count: int
    unsupported_count: int
    failed_count: int
```

### System 9: reader frontend

Owners:

- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/TextDocumentReader.tsx`
- `apps/web/src/components/HtmlRenderer.tsx`
- new `apps/web/src/components/reader/DocumentEmbedSlotRenderer.tsx`
- new `apps/web/src/components/reader/document-map/ReaderDocumentMapEmbedsLens.tsx`

Target behavior:

- `TextDocumentReader` receives `renderedHtml` plus typed `documentEmbeds`.
- `HtmlRenderer` renders inert same-system sanitized placeholders.
- `DocumentEmbedSlotRenderer` binds typed embed payloads to placeholder ids.
- YouTube cards use existing playback-source validation helpers.
- X cards render from child media snapshot fields and never call X widget JS.
- unsupported cards render accessible static content.
- Document Map gets a first-class Embeds tab under `reader-tools`.
- Mobile uses the same Document Map secondary sheet.

No frontend component may parse iframe URLs from HTML. Provider parsing belongs
to backend extraction/identity services.

Reader integration contract:

- `HtmlRenderer` remains the only raw sanitized-HTML sink. Slot rendering is a
  post-sanitization same-system enhancement over approved placeholder nodes, not
  a second HTML injection path.
- Highlight application runs against canonical text and sanitized placeholder
  text. Highlight spans may wrap text inside a placeholder caption but must not
  split, replace, or remove the placeholder container.
- Quote creation and quote preview use the placeholder text when the selection
  intersects an embed card.
- Focus mode, resume position, scroll restoration, and reader metrics count the
  placeholder as part of the document flow at its canonical locator.
- Document Map activation uses the stored locator/placeholder id and does not
  depend on runtime DOM geometry for identity.
- Inline YouTube uses the existing validated playback source and CSP helpers.
  The first implementation should prefer click-to-load playback unless existing
  video media UI already eagerly loads the same validated iframe.
- `thumbnail_url` is not rendered from arbitrary third-party URLs. It is omitted
  or routed through an existing safe image/proxy contract before frontend use.

Document Map frontend contract:

- Add `embeds` to the frontend lens union and client payload validation.
- Update secondary-pane surface routing, `readerSurfaceForLens`, default-surface
  rules, overview rail marker rendering, and mobile sheet tab wiring together.
- Reuse existing anchored lens patterns such as the Connections lens instead of
  introducing a separate sidecar model.

### System 10: indexing and retrieval

Owners:

- `python/nexus/services/web_article_indexing.py`
- `python/nexus/services/content_indexing.py`

Target behavior:

- parent article content index includes placeholder text for source-authored
  embeds,
- parent article index does not include child media transcript/body text,
- child media is indexed by its own media pipeline,
- search results for child media can appear independently,
- future cross-resource retrieval can use graph traversal from parent media to
  child media, not merged parent chunks.

### System 11: operations and diagnostics

Owners:

- `python/nexus/services/provider_events.py`
- source attempt logs,
- media events stream.

Target behavior:

- parent source attempt records embed extraction diagnostics without raw HTML,
- child source attempts record provider failures as normal source attempts,
- X provider calls record `external_provider_events`,
- Document Map diagnostics exposes omitted/failed counts,
- production smoke can assert known media ids have visible embed rows without
  dumping article body.

## Complete schema

### Database table: `document_embed_artifact_states`

One row is the current aggregate embed-extraction state for one parent readable
artifact. This table is required so `empty` and "extraction failed before any
trusted occurrence rows existed" are not conflated.

```sql
CREATE TABLE document_embed_artifact_states (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    media_id uuid NOT NULL REFERENCES media(id),
    source_attempt_id uuid NULL REFERENCES media_source_attempts(id),

    status text NOT NULL,
    total_count integer NOT NULL DEFAULT 0,
    resolved_count integer NOT NULL DEFAULT 0,
    unsupported_count integer NOT NULL DEFAULT 0,
    failed_count integer NOT NULL DEFAULT 0,

    extraction_error_code text NULL,
    extraction_error_message text NULL,
    diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    UNIQUE (media_id)
);
```

Application-owned invariants:

- count columns are nonnegative,
- `total_count >= resolved_count + unsupported_count + failed_count`,
- `diagnostics` is a JSON object,
- `status` is one of `DocumentEmbedAggregateStatus`,
- branch consistency remains in application/domain code, not new table-level
  business `CHECK` constraints.

Query support:

- `UNIQUE (media_id)` supports `GET /media/{id}`, `GET /media/{id}/document-map`,
  and artifact replacement.
- No additional artifact-state index is added until a named operational query
  needs it.

### Database table: `document_embeds`

One row is one source-authored embed occurrence in the current readable artifact
of one parent media item.

```sql
CREATE TABLE document_embeds (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    media_id uuid NOT NULL REFERENCES media(id),
    fragment_id uuid NULL REFERENCES fragments(id),
    source_attempt_id uuid NULL REFERENCES media_source_attempts(id),

    ordinal integer NOT NULL,
    occurrence_key text NOT NULL,

    provider text NOT NULL,
    embed_kind text NOT NULL,
    source_shape text NOT NULL,
    resolution_status text NOT NULL,

    source_url text NULL,
    canonical_source_url text NULL,
    provider_target_ref text NULL,

    target_media_id uuid NULL REFERENCES media(id),

    title text NULL,
    description text NULL,
    thumbnail_url text NULL,
    authored_text text NULL,

    placeholder_text text NOT NULL,
    source_start_offset integer NULL,
    source_end_offset integer NULL,
    canonical_start_offset integer NULL,
    canonical_end_offset integer NULL,
    document_order_key text NOT NULL,

    error_code text NULL,
    error_message text NULL,
    diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
```

Storage notes:

- `media_id` is the parent document media id.
- `fragment_id` points at the current fragment containing the placeholder.
- `source_attempt_id` points at the parent source attempt that produced the row.
- `target_media_id` points at a child media row only when materialized or
  accepted for materialization.
- API `target.resource_ref` is derived from `target_media_id` and is not stored.
- `diagnostics` is an owned extension point for extraction diagnostics, not raw
  provider HTML and not a generic dumping ground.

Foreign-key cleanup contract:

- FK actions are not a substitute for service ownership. Refresh, deletion, and
  retry paths perform explicit cleanup in owner services.
- Parent article refresh deletes/replaces `document_embeds` and
  `document_embed_artifact_states` before deleting or replacing current
  fragments.
- Parent media deletion deletes document embed graph edges, occurrence rows, and
  artifact state before deleting the media row.
- Child media deletion clears or marks `target_media_id` and replaces
  `document_embed` graph edges before deleting the child media row.
- Source-attempt cleanup, if introduced for parent attempts, deletes occurrence
  rows and artifact state before attempt deletion.

Allowed values:

```text
provider:
  youtube
  x
  substack
  vimeo
  spotify
  generic
  unknown

embed_kind:
  video
  post
  audio
  link_preview
  unknown

source_shape:
  iframe
  blockquote
  anchor
  video_tag
  provider_json
  unknown

resolution_status:
  pending
  resolving
  resolved
  unsupported
  failed
```

Uniqueness:

```sql
UNIQUE (media_id, ordinal)
UNIQUE (media_id, occurrence_key)
```

Indexes:

```sql
CREATE INDEX idx_document_embeds_media_order
  ON document_embeds (media_id, ordinal, id);

CREATE INDEX idx_document_embeds_fragment_order
  ON document_embeds (fragment_id, ordinal, id)
  WHERE fragment_id IS NOT NULL;

CREATE INDEX idx_document_embeds_target_media
  ON document_embeds (target_media_id)
  WHERE target_media_id IS NOT NULL;

CREATE INDEX idx_document_embeds_resolution
  ON document_embeds (resolution_status, updated_at, id)
  WHERE resolution_status IN ('pending', 'resolving', 'failed');
```

Index justifications:

- `idx_document_embeds_media_order` supports Document Map Embeds, media summary,
  and parent refresh replacement reads.
- `idx_document_embeds_fragment_order` supports batch enrichment for
  `GET /media/{id}/fragments`.
- `idx_document_embeds_target_media` supports child deletion cleanup and child
  media relationship probes.
- `idx_document_embeds_resolution` supports retry/operations queries over
  non-terminal occurrence rows and depends on app-side `updated_at = now()`
  updates.

Application-owned invariants:

- `ordinal >= 0`,
- offsets are nonnegative when present,
- `source_end_offset >= source_start_offset` when both are present,
- `canonical_end_offset >= canonical_start_offset` when both are present,
- `diagnostics` is a JSON object,
- URL columns use the same length ceilings as existing media/source URL fields,
- `document_order_key`, `occurrence_key`, provider refs, and display strings have
  explicit length ceilings,
- allowed values and semantic branch consistency are enforced by narrowed domain
  constructors, graph policy, and tests.

### Domain schema: `DocumentEmbedOut`

```python
DocumentEmbedProvider = Literal[
    "youtube",
    "x",
    "substack",
    "vimeo",
    "spotify",
    "generic",
    "unknown",
]

DocumentEmbedKind = Literal[
    "video",
    "post",
    "audio",
    "link_preview",
    "unknown",
]

DocumentEmbedSourceShape = Literal[
    "iframe",
    "blockquote",
    "anchor",
    "video_tag",
    "provider_json",
    "unknown",
]

DocumentEmbedResolutionStatus = Literal[
    "pending",
    "resolving",
    "resolved",
    "unsupported",
    "failed",
]

DocumentEmbedTargetStatus = Literal[
    "exact",
    "container",
    "missing",
    "forbidden",
    "unanchorable",
    "stale",
    "unsupported",
    "partial",
]

class DocumentEmbedOptionalTextOut(BaseModel):
    kind: Literal["present", "absent"]
    value: str | None = None
    reason: Literal["not_in_source", "redacted", "not_applicable"] | None = None

class DocumentEmbedOptionalUrlOut(BaseModel):
    kind: Literal["present", "malformed", "absent"]
    href: str | None = None
    raw_url: str | None = None
    error_code: str | None = None
    reason: Literal["not_in_source", "not_applicable"] | None = None

class DocumentEmbedProviderRefOut(BaseModel):
    kind: Literal["present", "absent"]
    value: str | None = None
    reason: Literal["unsupported_provider", "unparseable", "not_applicable"] | None = None

class DocumentEmbedLocatorOut(BaseModel):
    kind: Literal["anchored", "unanchored"]
    fragment_id: UUID | None
    canonical_start_offset: int | None
    canonical_end_offset: int | None
    document_order_key: str
    placeholder_text: str

class DocumentEmbedTargetOut(BaseModel):
    status: DocumentEmbedTargetStatus
    media_id: UUID | None = None
    resource_ref: str | None = None
    href: str | None = None
    playback_source: PlaybackSourceOut | None = None

class DocumentEmbedOut(BaseModel):
    id: UUID
    media_id: UUID
    ordinal: int
    provider: DocumentEmbedProvider
    embed_kind: DocumentEmbedKind
    source_shape: DocumentEmbedSourceShape
    resolution_status: DocumentEmbedResolutionStatus
    source_url: DocumentEmbedOptionalUrlOut
    provider_target_ref: DocumentEmbedProviderRefOut
    title: DocumentEmbedOptionalTextOut
    description: DocumentEmbedOptionalTextOut
    thumbnail_url: DocumentEmbedOptionalUrlOut
    authored_text: DocumentEmbedOptionalTextOut
    locator: DocumentEmbedLocatorOut
    target: DocumentEmbedTargetOut
    error_code: DocumentEmbedOptionalTextOut
    display: DocumentEmbedDisplayOut
```

Schema placement rule:

- Move shared playback output types to a non-circular schema module such as
  `python/nexus/schemas/playback.py`, or place document embed schemas where they
  can reference playback output without `schemas.media` importing back into
  itself.
- Frontend TypeScript schemas mirror the tagged absence forms exactly.
- Pydantic and TypeScript validators enforce branch shape: `kind = "present"`
  requires a value, `kind = "absent"` requires a reason and no value, and
  malformed URL branches require an error code. Nullable attributes inside these
  wrapper classes are serialization mechanics, not consumer-facing uncertainty.

### Display schema: `DocumentEmbedDisplayOut`

This is the "designer on content creation" contract. It defines what good
reader-visible content looks like for every embed state.

```python
DocumentEmbedDisplayTone = Literal[
    "neutral",
    "playable",
    "archived",
    "pending",
    "warning",
    "failed",
]

DocumentEmbedActionKind = Literal[
    "open_child_media",
    "open_original",
    "retry_child",
    "refresh_parent",
]

class DocumentEmbedDisplayActionOut(BaseModel):
    kind: DocumentEmbedActionKind
    label: str
    href: str | None = None
    disabled: bool = False

class DocumentEmbedDisplayOut(BaseModel):
    card_title: str
    card_subtitle: str | None
    body_text: str
    provider_label: str
    accessibility_label: str
    tone: DocumentEmbedDisplayTone
    actions: list[DocumentEmbedDisplayActionOut]
```

Content quality rules:

- `card_title` names the embedded thing, not the failure mechanics.
- `card_subtitle` names the provider and state when useful.
- `body_text` explains unsupported/failed/pending states in one sentence.
- `provider_label` is stable and short: `YouTube`, `X`, `Substack`, `Unknown`.
- `accessibility_label` must be meaningful without visual context.
- Do not expose raw provider error bodies, secrets, query strings, or tokens.
- Do not display "iframe", "oEmbed", "Readability", or internal source type
  names to the user.

Good display examples:

```text
Resolved YouTube:
  card_title: "Embedded video"
  card_subtitle: "YouTube"
  body_text: "<child media title>"
  actions: Open video, Open original

Resolved X:
  card_title: "Embedded X post"
  card_subtitle: "@author"
  body_text: "<archived post excerpt>"
  actions: Open post, Open original

Unsupported provider:
  card_title: "Embedded content unavailable"
  card_subtitle: "Unsupported provider"
  body_text: "Nexus found embedded content here but does not support this provider yet."
  actions: Open original

Failed provider:
  card_title: "Embedded content failed to load"
  card_subtitle: "X provider unavailable"
  body_text: "The article is readable, but this embedded post could not be archived."
  actions: Retry, Open original
```

### Reader Document Map schema extension

Add `embeds` to lens ids:

```python
ReaderDocumentMapLensId = Literal[
    "contents",
    "embeds",
    "highlights",
    "citations",
    "connections",
    "chat",
]
```

Add item variant:

```python
class ReaderDocumentMapEmbedItemOut(ReaderDocumentMapItemBaseOut):
    kind: Literal["document_embed"]
    source_domain: Literal["document_embeds"]
    document_embed_id: UUID
    provider: DocumentEmbedProvider
    embed_kind: DocumentEmbedKind
    resolution_status: DocumentEmbedResolutionStatus
    target_media_id: UUID | None = None
```

Lens behavior:

- Lens status uses `DocumentEmbedAggregateStatus`, not a separate lossy enum.
- `ready`: all detected embeds are resolved or unsupported with visible cards.
- `empty`: extraction completed and no embeds were detected.
- `resolving`: one or more child media materializations are in flight and none
  have failed.
- `partial`: at least one embed is pending, resolving, failed, or unsupported
  while other embeds resolved.
- `failed`: embed extraction failed before occurrence rows could be trusted.
- `unsupported`: media kind does not support embed extraction.

Marker tone:

- resolved video/post: `connection`,
- unsupported/failed: `warning`,
- pending/resolving: `neutral`.

### Resource graph schema extension

Add edge origin:

```python
EdgeOrigin = Literal[
    "user",
    "citation",
    "system",
    "note_body",
    "highlight_note",
    "synapse",
    "document_embed",
]
```

Update every closed owner layer for the new origin: backend schema literal,
database storage-shape check where the existing table uses one, graph policy,
frontend origin union, reader connection allowlists, and collection/list
connection summaries if product scope includes those rollups.

No new `ResourceRef` scheme is required for `document_embed` in the first
implementation because occurrences are reader/document structure, not standalone
resources. If later the occurrence itself becomes openable outside the parent
document, add `document_embed` as a resource scheme in a separate cutover.

### Media source schema extension

Add source type:

```text
x_post
```

`x_post` is a complete durable source type, not an adapter-only flag. The
cutover must update:

- `media_source_types.py`,
- `media_source_attempts.source_type` storage-shape checks,
- source-attempt dispatch in `run_source_attempt`,
- retry/requeue projections,
- refresh and artifact cleanup source-type sets,
- provider-event operation naming,
- source-attempt failure mapping,
- capability/readiness projection for child post media.

Extend `media_source_attempts.source_type` and source dispatch:

```text
generic_web_url
x_author_thread
x_post
youtube_video
...
```

Embedded child attempt payload:

```json
{
  "kind": "embedded_source",
  "parent_media_id": "<uuid>",
  "document_embed_id": "<uuid>",
  "source_url": "https://...",
  "provider": "youtube",
  "provider_target_ref": "video:<id>",
  "library_ids": ["<uuid>"]
}
```

X provider event contract:

- single-post lookup records `external_provider_events` with a post-specific
  operation name, not an author-thread operation,
- provider outcomes distinguish success, not found, deleted/private,
  rate-limited, auth/config failure, and transient provider failure,
- child `x_post` retry reuses the child source attempt and does not rerun parent
  article extraction,
- quote-post child materialization and embedded `x_post` share lower-level
  snapshot/rendering helpers but keep separate source-attempt ownership.

### Sanitized placeholder schema

Add a dedicated server-authored sanitizer mode for document embed placeholders.
Allow only these same-system attributes on placeholder elements:

```text
data-nexus-document-embed-id
data-nexus-document-embed-kind
```

Allowed placeholder tags:

- `figure`
- `figcaption`

Raw provider attributes remain forbidden:

- `src` on iframe,
- `allow`,
- `allowfullscreen`,
- `frameborder`,
- provider `class`,
- inline `style`,
- provider `data-*`,
- event handlers.

Required sanitizer tests:

- positive: `figure[data-nexus-document-embed-id]` and
  `figcaption[data-nexus-document-embed-kind]` survive only when emitted by the
  backend placeholder rewriter,
- negative: generic `data-*`, provider widget classes, inline styles, raw
  iframes, object/embed tags, scripts, `src`, `allow`, and event handlers are
  stripped,
- regression: existing reader-apparatus attribute handling remains unchanged.

## Feature set

### Feature 1: detect inline embeds in generic web articles

User story:

- As a reader, I can open a Substack article and see where videos and posts were
  embedded instead of seeing missing content.

Required work:

- implement `document_embed_extraction.py`,
- detect YouTube iframe URLs,
- detect X embedded post blockquotes and links,
- detect unknown iframes as unsupported,
- generate inert placeholders before sanitization,
- bind placeholder locators to final fragment offsets.

Acceptance criteria:

- a fixture with three YouTube iframes produces three document embed rows,
- raw iframes are absent from `html_sanitized`,
- placeholder text appears in `canonical_text`,
- unsupported iframes produce visible unsupported rows,
- malformed iframe URLs do not crash article ingest.

### Feature 2: materialize embedded YouTube videos

User story:

- As a reader, I can play or open a YouTube video embedded in an article through
  Nexus' existing controlled player contract.

Required work:

- parse YouTube iframe and watch URL variants in `youtube_identity.py`,
- call internal `accept_embedded_source` for each YouTube occurrence,
- create/reuse child `video` media,
- link the document embed row to child media,
- render the inline YouTube card/player through existing validated playback
  source helpers.

Good content:

- title from child media when available,
- provider label `YouTube`,
- body text uses the child media title, not raw URL,
- show a pending card until child media hydration completes.

Acceptance criteria:

- direct ingest and inline embed of the same YouTube video reuse canonical child
  media,
- URL normalization covers `youtu.be`, `watch`, `embed`, `shorts`, `live`, `v`,
  and `youtube-nocookie` variants through the existing identity helper,
- only valid 11-character video ids are accepted,
- unsafe userinfo and token-like query values are not retained in display/open
  original URLs,
- frontend iframe rendering remains HTTPS-only and `/embed/{id}` validated,
- CSP still blocks arbitrary non-YouTube frames,
- YouTube iframe rendering remains host/path validated,
- parent article remains readable when child YouTube transcript fails.

### Feature 3: materialize embedded X posts

User story:

- As a reader, I can see an archived static card for a post embedded inside an
  article.

Required work:

- add source type `x_post`,
- factor single-post materialization from quote-post handling,
- use official X API lookup,
- create/reuse child media with provider id `post:<post_id>`,
- render static archived child-media card inline,
- link parent and child with `document_embed` graph edge.

Good content:

- card title `Embedded X post`,
- subtitle uses provider author username when known,
- body text is a compact post excerpt,
- failed provider states name that the embedded post could not be archived.

Acceptance criteria:

- no oEmbed endpoint is called,
- no X widget script appears in reader HTML,
- single-post provider events are recorded with post-specific operation names,
- provider failure creates a visible failed embed card,
- deleted/private/rate-limited/provider-auth failures map to typed child source
  attempt failures,
- direct X author-thread ingest remains unchanged for direct URLs.

### Feature 4: unsupported embed visibility

User story:

- As a reader, I can tell that the article contained embedded content even when
  Nexus does not support that provider yet.

Required work:

- persist unsupported rows,
- render inline unsupported cards,
- include unsupported rows in Document Map Embeds,
- include safe original URL action when available.

Good content:

- do not blame the author or browser,
- use short user-visible state,
- do not expose internal stage names.

Acceptance criteria:

- unsupported iframes are visible in reader and Document Map,
- unsupported rows do not create graph edges,
- unsupported rows do not block parent `ready_for_reading`.

### Feature 5: Document Map Embeds lens

User story:

- As a reader, I can inspect all embedded resources in the article from the same
  side instrument as contents, citations, highlights, connections, and chat.

Required work:

- add `embeds` lens id,
- add backend aggregate rows and markers,
- add frontend `ReaderDocumentMapEmbedsLens`,
- update frontend lens union, secondary pane model, `readerSurfaceForLens`,
  default lens/surface behavior, overview rail markers, mobile sheet tabs, and
  client payload validation,
- position markers from document embed locators, never DOM geometry,
- activate rows by scrolling to placeholder or opening child media.

Good content:

- list rows show title, provider, and state,
- failed/unsupported rows are not hidden below resolved rows,
- row actions are stable: Open, Open original, Retry when available.

Acceptance criteria:

- backend and frontend schemas agree on the full lens list,
- desktop overview rail shows embed markers,
- mobile Document Map sheet shows the Embeds tab,
- route tests pin lens ordering and `empty`, `ready`, `resolving`, `partial`,
  `failed`, and `unsupported` states,
- unsupported and failed rows have warning tone,
- activating a row scrolls to the placeholder when anchored.

### Feature 6: graph relationship sync

User story:

- As a user, embedded child media behaves like a first-class connected resource
  without duplicating relationship models.

Required work:

- add `document_embed` edge origin,
- update backend schemas, existing storage vocabularies, graph policy, frontend origin
  unions, reader connection origin allowlists, and list connection origin
  allowlists,
- write graph edges from parent media to child media for resolved child media,
- delete/replace graph edges on parent refresh,
- clean up graph edges on parent or child deletion.

Acceptance criteria:

- parent article Connections or graph rollups can see child media relationships,
- `document_embed` edges are `media -> media` only,
- edge policy rejects ordinals, snapshots, source order, and target order,
- unsupported embeds do not create graph edges,
- reprocessing parent removes stale child edges,
- user-created edges survive document embed replacement.

### Feature 7: capability and status projection

User story:

- As the UI, I can ask the backend whether embeds are supported and what state
  they are in without reconstructing lifecycle from rows.

Required work:

- derive `can_read_embeds`,
- add `document_embed_summary`,
- make `document_embed_artifact_states.status` authoritative for both media
  summary and Document Map Embeds lens status,
- keep parent document readiness separate.

Acceptance criteria:

- web articles with zero embeds report `empty`,
- web articles with pending child materialization report `resolving` when no
  failure is present and `partial` when mixed terminal/nonterminal states exist,
- extraction failure before trusted rows reports `failed`, not `empty`,
- failed child provider does not change parent `can_read`,
- frontend never computes embed readiness from raw `processing_status`.

### Feature 8: browser capture parity

User story:

- As a user saving a browser-rendered article, I get the same embed preservation
  semantics as URL ingestion when source markup is available.

Required work:

- extension sends captured source DOM HTML before Readability/widget loss when
  available,
- any client-supplied embed facts are untrusted hints and cannot create child
  media or provider identity without backend validation,
- backend parses and classifies source payloads at ingress,
- captured article source artifact preserves raw input for reprocessing,
- generic browser capture and URL ingest converge before document embed
  persistence.

Acceptance criteria:

- browser capture fixture with YouTube iframe creates document embeds,
- a browser capture containing only post-Readability `content_html` reports
  unsupported or empty according to preserved source evidence instead of
  inventing provider facts,
- extension does not submit already-sanitized trusted embed payloads,
- backend remains the owner of parsing and provider classification.

### Feature 9: reprocessing, retry, and deletion

User story:

- As a user, refreshing an article replaces stale embed occurrences and retrying
  child media uses the same source lifecycle as other media.

Required work:

- parent refresh deletes/replaces current document embed rows,
- child media retry remains child media retry,
- parent source retry re-detects embed occurrences,
- deletion explicitly cleans occurrence rows and document embed graph edges,
- `delete_web_article_artifacts`, media deletion, refresh/retry replacement,
  child deletion, duplicate/supersede flows, and graph edge replacement all name
  document embed cleanup order.

Acceptance criteria:

- stale rows are removed after refresh,
- old placeholder ids do not resolve after refresh,
- deleting/replacing fragments cannot be blocked by stale document embed FKs,
- child delete marks or clears parent target status without leaving broken graph
  edges,
- duplicate embedded URLs create one child media with multiple occurrence rows,
- repeated parent retry is idempotent and does not duplicate child attempts,
- no runtime compatibility branch attempts to read old rows.

### Feature 10: tests and fixtures

Required test fixtures:

- synthetic Substack-like article with three YouTube iframes,
- synthetic article with X blockquote and X post URL,
- unsupported iframe fixture,
- malformed iframe fixture,
- browser capture fixture preserving source HTML,
- real-media fixture for deterministic captured article with inline embeds.

Fixture manifest contract:

- each fixture declares provenance, hash, provider support level, verifier tier,
  and whether it is synthetic or real-media,
- each fixture includes expected serialized `DocumentEmbedOut` payloads,
  fragment `document_embeds`, Document Map lens/items/markers, graph edges, child
  source attempts, provider diagnostics, and sanitizer output,
- real-media fixtures record production/API mapping without storing raw article
  body dumps in the repo.

Test tiers:

- unit tests for extraction and provider URL parsing,
- backend integration tests for source ingest, child source acceptance, row
  replacement, and API payloads,
- migration tests for model/migration parity and storage-shape checks,
- source-attempt crash/retry/idempotency tests,
- resource graph negative tests for origin policy and replacement isolation,
- sanitizer tests proving raw iframe/script removal and placeholder survival,
- frontend component tests for embed cards and Document Map lens,
- reader tests for highlights, quotes, focus mode, resume position, and activation
  around placeholders,
- E2E real-media test opening an article and asserting inline cards are visible,
- CSP E2E test proving arbitrary iframes remain blocked.

## Migration and hard cutover plan

### Phase 0: fixture and red-contract setup

- Add synthetic and real-media fixture manifests.
- Add expected gold payloads for fragments, Document Map, graph edges, source
  attempts, diagnostics, sanitizer output, and frontend cards.
- Add failing API/UI contract tests before implementation where practical.

### Phase 1: schema and types

- Add `document_embed_artifact_states` table.
- Add `document_embeds` table.
- Add `x_post` source type across constants, existing storage vocabularies, dispatch,
  retry/requeue projections, cleanup sets, and provider events.
- Add `document_embed` graph origin across schemas, existing storage vocabularies, policy,
  frontend unions, reader connection allowlists, and connection summary
  allowlists.
- Add backend Pydantic schemas.
- Add frontend TypeScript schemas.
- Add model/migration parity tests.

No runtime support branches for old payloads are added.

### Phase 2: extraction and sanitizer placeholders

- Implement detector.
- Implement placeholder rewriting.
- Allow only same-system placeholder attributes.
- Add tests that raw iframes remain removed.

### Phase 3: persistence and read APIs

- Persist artifact-level embed state during web article materialization.
- Persist document embed rows during web article materialization.
- Extend fragments API with embed payloads.
- Extend Document Map aggregate with Embeds lens.
- Add capability summary.
- Add public API tests for `/media/{id}`, `/media/{id}/fragments`, and
  `/media/{id}/document-map`.

### Phase 4: provider child materialization

- Add internal `accept_embedded_source`.
- Add YouTube child acceptance.
- Add X `x_post` materialization.
- Add graph edge sync for resolved child media.
- Add idempotency, crash-retry, provider failure, and duplicate embedded URL
  tests.

### Phase 5: frontend reader

- Add typed embed slot renderer.
- Add inline cards and controlled YouTube playback.
- Add X static archived card.
- Add unsupported/failed cards.
- Add Document Map Embeds lens.
- Add highlight, quote, focus mode, resume position, desktop rail, and mobile
  sheet tests.

### Phase 6: browser capture parity

- Extend extension payload and backend capture schema.
- Preserve source markup for embed extraction.
- Add browser-capture real-media fixture.

### Phase 7: graph, cleanup, and deletion proof

- Prove parent refresh replaces only `document_embed` edges.
- Prove user/citation/note/highlight/synapse edges survive.
- Prove parent deletion and child deletion clean rows and graph edges in the
  service-owned order.
- Prove stale fragment/source attempt FKs cannot block refresh or deletion.

### Phase 8: operational runbook and production proof

- Reingest or refresh known Substack media.
- Verify `/media/{id}`, `/media/{id}/fragments`, and
  `/media/{id}/document-map` for media
  `2f2f5d00-12a1-4227-81ab-779181f6eb17`.
- Verify DB counts/statuses for artifact state and occurrence rows without
  dumping body HTML.
- Verify the reader shows three YouTube embed cards.
- Verify the Embeds lens shows the same occurrences and states.
- Verify no raw iframe exists in `fragments.html_sanitized`.
- Verify CSP still blocks arbitrary injected frames.
- Verify X single-post calls correlate to `external_provider_events`.
- Verify child media opens and parent remains readable.
- Document roll-forward for partially materialized child media: rerun child
  source attempts, then recompute embed target status and graph edges. No
  rollback path keeps legacy inline iframe rendering.

## File map

### Backend new files

- `python/nexus/services/document_embed_extraction.py`
- `python/nexus/services/document_embeds.py`
- `python/nexus/schemas/document_embeds.py`
- `python/nexus/schemas/playback.py` if needed to avoid schema import cycles.
- `python/tests/test_document_embed_extraction.py`
- `python/tests/test_document_embeds.py`
- `python/tests/fixtures/web_article_embeds/README.md`

### Backend touched files

- `python/nexus/db/models.py`
- `python/nexus/db/migrations/*`
- `python/nexus/schemas/media.py`
- `python/nexus/schemas/reader_document_map.py`
- `python/nexus/services/web_article_ingest.py`
- `python/nexus/services/web_article_structure.py`
- `python/nexus/services/sanitize_html.py`
- `python/nexus/services/media_source_ingest.py`
- `python/nexus/services/youtube_identity.py`
- `python/nexus/services/youtube_video_ingest.py`
- `python/nexus/services/x_identity.py`
- `python/nexus/services/x_ingest.py`
- `python/nexus/services/x_rendering.py`
- `python/nexus/services/resource_graph/schemas.py`
- `python/nexus/services/resource_graph/policy.py`
- `python/nexus/services/resource_graph/cleanup.py`
- `python/nexus/services/reader_document_map.py`
- `python/nexus/services/capabilities.py`
- `python/nexus/services/media.py`

### Frontend new files

- `apps/web/src/components/reader/DocumentEmbedSlotRenderer.tsx`
- `apps/web/src/components/reader/DocumentEmbedCard.tsx`
- `apps/web/src/components/reader/DocumentEmbedCard.module.css`
- `apps/web/src/components/reader/document-map/ReaderDocumentMapEmbedsLens.tsx`
- `apps/web/src/components/reader/document-map/ReaderDocumentMapEmbedsLens.module.css`
- `apps/web/src/lib/reader/documentEmbeds.ts`

### Frontend touched files

- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/TextDocumentReader.tsx`
- `apps/web/src/components/HtmlRenderer.tsx`
- `apps/web/src/components/HtmlRenderer.module.css`
- `apps/web/src/lib/media/transcriptView.ts`
- `apps/web/src/lib/reader/documentMap.ts`
- `apps/web/src/lib/panes/paneSecondaryModel.ts`
- `apps/web/src/lib/resourceGraph/edges.ts`
- `apps/web/src/lib/security/youtube.ts`
- `apps/web/src/lib/security/csp.ts`
- `apps/web/src/lib/security/headers.ts`
- `apps/web/src/app/api/proxy-routes.test.ts` if any new API route is added.

### Extension touched files

- `apps/extension/content.js`
- extension capture schema tests, if present or added.

### E2E touched files

- `e2e/tests/real-media/captured-web-article.spec.ts`
- `e2e/tests/youtube-transcript.csp.spec.ts`
- optional new `e2e/tests/web-article-embeds.spec.ts`

## Acceptance criteria

The cutover is complete only when all criteria are true:

1. A Substack-like article with YouTube iframes returns visible typed
   `document_embeds` payloads from `/media/{id}/fragments`.
2. The same article stores no raw iframe/script/object/embed tags in
   `fragments.html_sanitized`.
3. The article canonical text includes visible placeholder text at authored embed
   positions.
4. YouTube embedded videos create or reuse child video media.
5. Embedded X posts create or reuse child `x_post` media through the official X
   API and post-specific provider events.
6. X oEmbed is not called anywhere.
7. Unsupported providers show inline unsupported cards.
8. Failed providers show inline failed cards.
9. The parent article remains `ready_for_reading` when child embed resolution is
   pending, unsupported, or failed.
10. `document_embed_artifact_states.status` distinguishes `empty`, `failed`,
    `resolving`, `partial`, `ready`, and `unsupported`.
11. Document Map includes an Embeds lens with correct counts, markers, ordering,
    activation, diagnostics, and status.
12. Materialized child media is related to parent media through
    `resource_edges.origin = 'document_embed'`.
13. Graph origin policy, existing DB vocabularies, backend schemas, frontend unions, and
    connection allowlists agree on `document_embed`.
14. Parent refresh replaces document embed rows and document embed graph edges.
15. Child media deletion does not leave broken graph edges or broken inline
    activation.
16. Frontend code does not parse provider URLs from sanitized HTML.
17. `HtmlRenderer` remains the only raw sanitized-HTML sink.
18. Highlighting, quoting, focus mode, resume position, and Document Map
    activation behave correctly around embed placeholders.
19. CSP continues to block non-allowlisted frames and thumbnails do not widen CSP
    through arbitrary third-party image URLs.
20. Browser capture and URL ingest converge on the same backend embed model when
    source markup is available, and client hints remain untrusted.
21. Fixture manifests and gold payloads cover extraction, sanitization,
    persistence, API, reader rendering, Document Map, graph sync, source-attempt
    retry/idempotency, provider events, and CSP.
22. Production media `2f2f5d00-12a1-4227-81ab-779181f6eb17` can be refreshed or
    reingested and verified through API payloads, visible YouTube embed cards,
    Embeds lens rows, child media open, raw iframe stripping, and CSP behavior.

## Open implementation questions

These are implementation questions, not product blockers:

- Whether child embedded media should be listed in normal library views by
  default or only reachable through parent connections. The first implementation
  should inherit parent libraries because X quote posts already behave as
  separate media.
- Whether unsupported native Substack videos can later become a supported
  provider. That requires a provider-specific contract and is not a reason to
  allow generic iframes now.

## Final state

The final system treats source-authored embedded resources as document structure,
not arbitrary executable HTML. Generic web articles can faithfully represent
embedded videos and posts without weakening the sanitizer, CSP, or reader
contracts.

The parent article owns current readable prose and embed occurrences. Provider
owners own provider truth. Child media owns playback or archived post content.
The graph owns durable relationships between resources. The reader owns inline
presentation and Document Map inspection from typed same-system payloads.

There is one hard path, no legacy fallback, and no silent disappearance of
embedded source content.
