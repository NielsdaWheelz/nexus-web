# Universal Resource Sharing — Hard Cutover

**Status:** Validated target implementation spec · Rev 3 · 2026-07-23

**Type:** Hard cutover — one final contract; no legacy path, fallback, compatibility
shim, dual write, or mixed-version support.

## One-line

One Share surface copies private Nexus links, manages closed-library membership,
and creates path-revocable user or bearer-link grants for readable media and the
sharer’s own highlights; anonymous readers receive a dedicated, allowlisted,
read-only media projection and no private Nexus graph.

## Validation record

This document specifies a target; it does not claim that sharing is already
implemented. The following current-state findings were verified against the
2026-07-23 tree and are the reason for the cutover:

- `PaneShell.tsx` owns a standalone “Copy pane link” action even though
  `PaneRuntimeContext` already carries typed resource identity.
- `resourceActions.ts` exposes a separate media “Libraries…” action, while
  `LibraryEditDialog.tsx` and both library-pane callers mix settings with
  member/invitation state. There is no single Share surface.
- `auth.permissions` is the canonical scalar/set visibility owner. Media
  visibility currently composes tombstones, teardown, and library entries;
  highlight visibility currently composes parent-media access and library
  intersection. Direct grants do not exist.
- `resource_items.capabilities` is already exhaustive over all 19
  `ResourceScheme` values, but it has no sharing policy. Its backend/API/frontend
  mirrors are therefore the correct highest-layer policy seam.
- `media_deletion._total_reference_count`,
  `library_entries`, and the media-teardown worker count library entries only.
  Grant-backed retention must be composed into those owners, not bolted onto an
  API route.
- `proxyPublicToFastAPI` and the auth middleware already provide a narrow
  internal-trust pattern for public reads, but no public resource-share route or
  grant projection exists.
- `media_file_access` returns a presigned storage URL whose path contains the
  private media UUID. That authenticated convenience API is not a safe public
  projection and is not reused for anonymous PDF delivery.
- `ConversationShare` already implements owner-managed distribution to closed
  libraries. It is a separate, intentionally excluded product contract, not
  evidence that generic resource grants already exist.
- Touched user-search and library-sharing payloads expose raw user and
  invitation IDs. That is incompatible with
  `docs/rules/keys-and-identities.md`; this cutover must seal those identities
  at the touched boundary.

The solution below deliberately reuses those owners. It does not introduce a
second visibility system, ACL cache, pseudo-library, optional viewer, sharing
graph, or general-purpose anonymous serializer.

## 1. Scope

This cutover ships:

- universal `ResourceRef`-keyed direct-grant storage;
- direct authenticated-user sharing for media and owned highlights;
- anonymous “Anyone with the link” sharing for media and owned highlights;
- a session-independent `/s#share=<ShareToken>` public reader whose credential
  never enters a Nexus-controlled HTTP request target;
- one responsive Share overlay used by pane, row, library, highlight, and
  selection actions;
- library membership/invitation management moved from Edit Library into Share;
- library URLs that remain membership-gated and never grant access;
- media visibility, deletion, teardown, and highlight visibility composed with
  grants;
- grant-aware filing and truthful grant decline/removal across all five media
  kinds;
- exact public DTO, locator, pagination, streaming, and status-precedence
  contracts; and
- a traffic-gated one-SHA production cutover across independently deployed
  Vercel and Hetzner runtimes;
- removal of the old pane-copy action and duplicate library/media sharing UI.

All `ResourceScheme` values receive an explicit sharing capability. Only media,
highlights, and libraries gain access-management behavior in this cutover.

## 2. Goals

- **G1 — One mental model.** Share always opens one overlay; the resource
  capability determines its contents.
- **G2 — Universal direct grants.** One storage owner accepts a validated
  `ResourceRef` and a user or bearer-link audience.
- **G3 — Private by projection.** Anonymous reads expose only source media and
  the explicitly granted highlight; notes, annotations, graph data, chats, AI
  artifacts, membership, and user identity stay private.
- **G4 — Media is universal.** Any authenticated viewer who can read media may
  grant it. Grant recipients may grant it again.
- **G5 — Libraries stay closed.** Library access is only
  `library_entries + memberships`; admins govern membership. Libraries have no
  bearer-link or public mode.
- **G6 — Path-revocable capability links.** Copying a Nexus URL never changes
  access; creating or deleting a link grant is explicit. Revocation removes
  only the creator’s grant and cannot claw back copies or grants created by a
  recipient.
- **G7 — One owner per concern.** Reuse `ResourceRef`, resource capabilities,
  library governance, visibility predicates, reader services, BFF proxy,
  dialogs/sheets, pane runtime, and action descriptors.
- **G8 — Hard cut.** Delete replaced actions, component responsibilities,
  types, styles, tests, comments, and dead helpers in the same release.

## 3. Non-goals

- Public/indexed “Publish to web,” public libraries, public profiles, or feeds.
- Commenter/editor roles, collaborative editing, passwords, expiry UI, link
  analytics, notifications, email delivery, or a “Shared with me” inbox.
- Access-increasing grants or public projections for pages, note blocks,
  conversations, messages, dossiers/artifacts, contributors, podcast roots, or
  internal reader/index resources. Routeable `CopyOnly` subjects still use Share
  to copy or natively send their authenticated Nexus URL; that never widens
  access. Existing podcast-root library filing moves into Share without gaining
  a user/link grant mode.
- Changing the existing conversation-sharing product contract.
- User-account deletion. No product account-delete operation exists. Both grant
  user foreign keys remain non-cascading and intentionally block a future user
  deletion until a separate account-lifecycle cutover composes every user-owned
  subsystem. This cutover adds no partial user-teardown route or helper.
- Immutable snapshots, watermarking, download prevention, or DRM.
- Rich third-party unfurls or anonymous third-party media embeds.
- An identity/handle cutover outside the touched sharing, user-search, and
  library-membership APIs. Those touched APIs hard-cut user and invitation
  identities to sealed handles.

Direct user sharing targets an existing Nexus account, grants access immediately
unless the recipient’s explicit tombstone wins as defined in §4.2, and does not
auto-file into the recipient’s Default library. The sender transmits the
canonical authenticated Nexus URL. Filing remains the recipient’s explicit
library action.

## 4. Target behavior

### 4.1 Share variants

| Subject | Share overlay |
|---|---|
| Media | Copy Nexus link; Your shares; Libraries; Your public link Off/On; Copy public link; native Share; X after a public link exists |
| Owned highlight | Same grant controls; public/authenticated URL opens parent media focused on exactly this highlight |
| Bare selection | Materialize through the existing highlight-create command, then open the owned-highlight Share overlay |
| Non-owned highlight | No highlight Share action; the viewer may share the parent media without the other user’s annotation |
| Library | Copy member-only link; members, roles, pending invitations, and admin controls; no public-link or X control |
| Podcast root | Copy authenticated Nexus link; native Share; Libraries; no user grant, public link, or X |
| Copy-only resource | Copy authenticated Nexus link and native Share only |
| Internal/non-routeable resource | No Share action |

Copying any authenticated Nexus URL changes no access. For a library, copy and
native Share use the ordinary library URL and state “Only members can open.”

“Your shares” is intentionally creator-scoped. The overlay is not an ACL, does
not reveal grants created by other people, and must never say “People with
access.” A recipient may reshare readable media, so neither the sender nor the
original importer has global-owner powers.

### 4.2 Access semantics

Authenticated media readability is:

```text
not viewer-tombstoned
AND not tearing down
AND (
  membership reaches a library entry
  OR viewer is the recipient of a user grant on the media or one of its highlights
  OR viewer created an active grant on the media or one of its highlights
)
```

The creator path keeps a grant manageable if its creator later loses the
original library-membership path. Default-library list semantics remain the
existing membership/entry projection; direct grants widen global readability,
search, and exact media reads, not Default filing.

An authenticated highlight is visible when its parent media is readable and
the viewer is its author, shares the existing library-intersection path with
its author, or holds/created an exact grant for it. The explicit author path is
required so a direct media recipient can create and retain private highlights
without first filing the media. A media grant never exposes highlights. A
highlight grant exposes its parent media and only that highlight.

Grant creators manage only grants they created. Revocation removes only that
path; the recipient may retain access through a library, another grant, or a
grant they created after receiving the media.

Filing authority is `can_file_media = can_read_media OR can_restore_media`.
`can_read_media` includes live incoming and creator grants;
`can_restore_media` remains the membership-only, tombstone-ignoring restore
path. A non-tombstoned grant-only reader may therefore file any
`web_article`, `epub`, `pdf`, `video`, or `podcast_episode` into a writable
library. The command rechecks filing authority under the parent-media lock,
checks the destination membership/admin and billing contracts, inserts the
entry, then clears the viewer tombstone. A tombstoned grant never silently
restores media.

The exact-subject Share snapshot also returns `ReceivedAccess`: only incoming
user-grant paths whose exact recipient is the current viewer. For a media
subject it includes exact-highlight grants that confer access to that parent.
This is a viewer-scoped decline surface, not an ACL or “Shared with me” inbox;
it exposes no other recipient or unrelated grant.

Deleting one `ResourceGrantHandle` is path-local. The caller must be either its
creator, which revokes it, or its exact `grantee_user_id`, which declines it.
Link grants have no recipient-decline path. Declining A→B does not remove B→C.
Missing, already-deleted, and uncontrolled handles return the same masked 404.

Bearer-link resolution is public-projection authority only. Opening `/s` while
signed in does not convert the token into authenticated `can_read_media`, file
the media, or authorize grant creation.

Viewer tombstones remain authoritative: receiving a grant does not silently
restore media the recipient removed. Only an active membership path supplies
`can_restore_media`; the recipient restores through the explicit
filing/restore command. A tombstoned grant-only recipient must receive or join a
membership path before restoring.
“Remove media” is the truthful subject-wide action for all five media kinds: it
deletes the viewer’s incoming paths and every grant the viewer created for the
media or its highlights, then applies the generalized viewer-removal algorithm
in §7.2. When removal leaves no reachable path, it leaves no stale tombstone, so
a later grant is readable. Exact path decline remains the narrower operation
above.

### 4.3 Public reader

`/s#share=<ShareToken>` renders a generic shell outside the authenticated
workspace and ignores any Nexus session. URL fragments are not transmitted in
HTTP requests or referrers. The client parses one canonical token, retains it
only in memory, and sends it to same-origin public BFF reads in
`X-Nexus-Share-Token`. It is a live read, not a snapshot.

The public service returns the closed DTOs in §4.3.1 rather than a filtered
private model or `metadata` dictionary. Article fragments and transcript
segments use route-local ordinals, EPUB navigation uses grant-bound public
handles, PDF uses the token-reauthorized range gateway, and video/podcast
episodes expose source-authored transcript only. No third-party player/embed is
part of the projection.

Public HTML passes through a dedicated closed sanitizer: no script, form,
active/embed content, inline event, or automatic third-party request survives.
Only locally backed images/assets become opaque token-reauthorized asset
handles; other remote assets are omitted. Explicit outbound links are sanitized
and use `noopener noreferrer`.

Link availability is `Available` only when the exact subject has a currently
renderable public projection. User availability is independent of public
renderability, so direct user sharing remains available for authorized readable
media that is still processing. A highlight requires a currently resolved exact
reader target for either audience. Public routes revalidate lifecycle, source
revision, and projection availability on every read.

Never expose:

- any other highlight or annotation;
- highlight notes, pages, note blocks, backlinks, resource edges, Synapse, or
  Document Map;
- chats, messages, dossiers, summaries, claims, AI artifacts, or retrieval data;
- library names/membership, user identity, progress, workspace state, private
  IDs, mutation affordances, or internal locators;
- third-party analytics or embedded playback.

Invalid, malformed, revoked, deleted, tearing-down, mismatched, and unsupported
tokens all return the same masked 404.

### 4.3.1 Exact public wire contract

Every model below is strict, forbids extra fields, and uses PascalCase variants.
`Presence<T>` is the repository-owned `{kind: Absent} | {kind: Present, value:
T}` encoding. `bylines` contains source-authored display strings only, never a
Nexus user/sharer identity.

```text
PublicShareBootstrapOut {
  version: V1
  subject: PublicSubjectOut
  media: PublicMediaOut
  reader: PublicReaderOut
}

PublicSubjectOut =
  { kind: Media }
  | { kind: Highlight, highlight: PublicHighlightOut }

PublicMediaOut {
  title: string
  media_kind: Article | Epub | Pdf | Video | PodcastEpisode
  source_url: Presence<PublicHttpUrl>
  bylines: string[]
}

PublicReaderOut =
  { kind: Article }
  | { kind: Epub }
  | { kind: Pdf, byte_length: SafeUint, filename: string }
  | {
      kind: Transcript
      source_kind: Video | PodcastEpisode
      duration_ms: Presence<SafeUint>
    }

PublicHighlightOut {
  quote: Presence<string>
  color: Yellow | Green | Blue | Pink | Purple
  anchor: PublicHighlightAnchorOut
}

PublicHighlightAnchorOut =
  {
    kind: ArticleText
    fragment_ordinal: int32
    start_offset: int32
    end_offset: int32
  }
  | {
      kind: EpubText
      section_handle: PublicSectionHandle
      start_offset: int32
      end_offset: int32
    }
  | {
      kind: TranscriptText
      segment_ordinal: int32
      start_offset: int32
      end_offset: int32
      time_range: Presence<{ start_ms: SafeUint, end_ms: SafeUint }>
    }
  | {
      kind: PdfGeometry
      page_number: int32
      quads: PublicPdfQuad[]
    }

PublicPdfQuad {
  x1: finite float
  y1: finite float
  x2: finite float
  y2: finite float
  x3: finite float
  y3: finite float
  x4: finite float
  y4: finite float
}

PublicFragmentPageOut =
  {
    kind: ArticleFragments
    items: PublicArticleFragmentOut[]
    page_info: PublicPageInfo
  }
  | {
      kind: TranscriptSegments
      items: PublicTranscriptSegmentOut[]
      page_info: PublicPageInfo
    }

PublicArticleFragmentOut {
  ordinal: int32
  html_sanitized: string
  canonical_text: string
}

PublicTranscriptSegmentOut {
  ordinal: int32
  canonical_text: string
  time_range: Presence<{ start_ms: SafeUint, end_ms: SafeUint }>
  speaker: Presence<string>
}

PublicNavigationPageOut {
  kind: EpubNavigation
  items: {
    ordinal: int32
    label: string
    depth: int32
    section_handle: PublicSectionHandle
  }[]
  page_info: PublicPageInfo
}

PublicSectionOut {
  kind: EpubSection
  ordinal: int32
  section_handle: PublicSectionHandle
  html_sanitized: string
  canonical_text: string
}

PublicPageInfo {
  next_cursor: Presence<PublicPageCursor>
}
```

The HTTP mapping is exact:

- every JSON success is exactly `{"data": <the named DTO>}` with no sibling
  keys; asset/file successes are raw bodies;
- `GET /public/resource-share` → `PublicShareBootstrapOut`;
- `GET /public/resource-share/fragments` → the article/transcript page matching
  the resolved media kind;
- `GET /public/resource-share/navigation` → `PublicNavigationPageOut`, EPUB
  only;
- `GET /public/resource-share/sections/{section_handle}` →
  `PublicSectionOut`, EPUB only;
- `GET /public/resource-share/assets/{asset_handle}` → one allowlisted EPUB
  `image/png`, `image/jpeg`, `image/gif`, `image/webp`, or `image/avif` body;
- `GET /public/resource-share/file` → PDF bytes only.

`/fragments` and `/navigation` accept only `cursor` and `limit`. `limit`
defaults to 50 and is an integer from 1 through 100. Results are ordered by
ascending route-local ordinal. The next cursor names the current source
revision, endpoint family, and last returned ordinal. A page may return fewer
than `limit` to honor the response-byte cap.

Canonical credential/handle grammar is:

```text
ShareToken          = ^nxshr1_[A-Za-z0-9_-]{43}$
PublicSectionHandle = ^nxps1_[A-Za-z0-9_-]{48}$
PublicAssetHandle   = ^nxpa1_[A-Za-z0-9_-]{48}$
PublicPageCursor    = ^nxpc1_[A-Za-z0-9_-]{48}$
```

Public handles and cursors are non-authorizing, domain-separated HMAC-sealed
values. Each 36-byte decoded body is
`ordinal_u32_be || revision_digest_128 || tag_128`, where
`revision_digest_128 = SHA-256(source_owner_revision_bytes)[:16]`. The source
owner’s revision bytes identify the exact current canonical artifact, not a
timestamp. With the key derivation in §6, the tag input is exactly:

```text
"nexus-public-handle\0" || D || "\0" || V || "\0"
|| link_grant_id.bytes || parent_media_id.bytes
|| ordinal_u32_be || revision_digest_128
```

`D` is one of `section`, `asset`, or `page-cursor`; `V` is `1`. This binds the
value to the resolved link-grant row, parent media, current source revision,
exact endpoint family, and route-local ordinal. No payload exposes a UUID,
storage path, or source locator. EPUB source owners define deterministic
reading-order section ordinals and canonical-package-path asset ordinals for
this mapping. The share token remains the authority. Tampered, noncanonical,
oversized, stale-revision, wrong-kind, cross-subject, and cross-token values
return the same masked 404 even when both tokens reach the same media.

Bounds are part of the wire contract:

- title: 1–1,024 Unicode scalar values;
- bylines: at most 32, each 1–512 scalar values;
- source URL: at most 2,048 UTF-8 bytes;
- `SafeUint` is an integral JSON number from 0 through `2^53 - 1`;
- sanitized PDF filename: 1–255 scalar values; PDF byte length: 1 through
  `2^53 - 1`;
- highlight quote: at most 64 KiB UTF-8; geometry-only PDF highlights use
  `Absent`, not an invented quote;
- ordinals/offsets/depth: non-negative signed 32-bit integers;
- text offsets: half-open Unicode-codepoint ranges within `canonical_text`;
- time values: paired non-negative JavaScript-safe integers with
  `start_ms < end_ms`;
- PDF page number: 1 through signed-32-bit max; quads: 1–512; every coordinate
  finite and within the current page box;
- navigation labels/speakers: at most 512 scalar values;
- each article/transcript HTML or text field: at most 2 MiB UTF-8; each page
  response: at most 8 MiB;
- each EPUB section HTML/text field: at most 4 MiB UTF-8; each section response:
  at most 8 MiB;
- each public EPUB asset: at most 25 MiB.

An exact source unit that exceeds a required bound makes the projection
unsupported; the service does not truncate semantic content. Public DTOs never
contain database IDs, `ResourceRef`, storage locators, library fields, Nexus
user projections, or generic dictionaries.

Every masked public 404 uses the normal error envelope with
`code: E_NOT_FOUND` and message `Share unavailable`; only `request_id` may
differ. No reason-specific detail or header is emitted.

URL syntax sanitization alone never makes a source URL public. `source_url` is
`Present` only when the media-source owner affirmatively emits a public canonical
URL. Browser captures, authenticated/signed URLs, private-network and IP-literal
hosts, credential-bearing URLs, and unknown source kinds are `Absent`. The
allowlisted source canonicalizer then removes credentials/fragments and applies
its source-specific query policy. The public reader never derives the field from
an untyped media URL field.

`public_source_urls` owns the closed positive matrix and delegates identity
normalization to the named existing owner:

| Current source identity | Result | Canonicalizer |
|---|---|---|
| `generic_web_url` | `Present` after public-network HTTP(S) validation | generic fetched-article final-URL owner |
| `x_author_thread` or `x_post` with valid X identity | `Present` canonical post URL | `x_identity` |
| `youtube_video` or `video_transcript` with valid YouTube identity | `Present` canonical watch URL | `youtube_identity` |
| `remote_pdf_url` recognized as arXiv | `Present` canonical `https://arxiv.org/abs/{id}` | `remote_file_ingest` |
| arbitrary remote PDF/EPUB, upload, browser capture, email, podcast episode/feed/audio, or any other identity | `Absent` | none |

The projector uses the current successful source revision only. Missing or
conflicting provider identity is `Absent`; it never falls through to another
row or to `media.requested_url`.

EPUB HTML represents local assets only with inert
`data-nexus-public-asset-handle` attributes. It contains no `src`, `srcset`, CSS
URL, preload, or other automatic-request attribute. The client fetches the
handle explicitly with the token header, installs a blob URL, and revokes it on
section/token change and unmount.

### 4.4 Format-total highlight links

The stable authenticated link remains
`/media/{media_id}#highlight-{highlight_id}`. The hash identifies a highlight;
it is not itself a reader locator. The existing `locator_resolver` and
`reader_locations` owners are extended to produce exactly one closed current
target:

```text
ResolvedHighlightReaderTarget =
  {
    kind: WebTextOffsets
    fragment_id
    start_offset
    end_offset
  }
  | {
      kind: EpubTextOffsets
      section_id
      fragment_id
      start_offset
      end_offset
    }
  | {
      kind: TranscriptTextOffsets
      fragment_id
      start_offset
      end_offset
      time_range: Presence<{ start_ms, end_ms }>
    }
  | {
      kind: PdfPageGeometry
      page_number
      quads
    }
```

The mapping is exhaustive:

- `web_article` → `WebTextOffsets`;
- `epub` → `EpubTextOffsets`;
- `pdf` → `PdfPageGeometry`;
- `video` and `podcast_episode` → `TranscriptTextOffsets`.

Resolution validates parent-media coherence and the current source rows. A
missing/stale fragment, missing EPUB section, invalid offsets, empty PDF
geometry, or kind mismatch is typed `HighlightUnresolved`; it never guesses a
section or scrolls the initially rendered page. Missing transcript timing does
not discard a valid exact text target: the reader scrolls/focuses the segment
and seeks only when `time_range` is present.

Authenticated activation loads the resolved article fragment, EPUB section,
transcript segment, or PDF page before painting, focusing, and scrolling the
highlight. Missing, unauthorized, mismatched, and stale targets produce one
masked “Highlight unavailable” result and no false focus. The public projector
maps the same resolved target to `PublicHighlightAnchorOut`, replacing private
fragment/section identity with route-local ordinals and public handles.

Authenticated EPUB/PDF adapters split authorization from source access.
`epub_read`, `epub_assets`, and `media_file_access` expose private, pure
read-only source facts to trusted services plus their existing Viewer-authorized
wrappers. The public service performs token/lifecycle authorization before each
pure read and maps only to public DTOs; no pure helper authorizes, returns a
private DTO outward, signs a public URL, or exposes a storage locator.

The shared read-only PDF view accepts exactly:

```text
PdfDocumentSource =
  { kind: AuthenticatedSignedUrl, url: string }
  | {
      kind: PublicGateway
      url: "/api/public/resource-share/file"
      headers: { "X-Nexus-Share-Token": ShareToken }
      credentials: Omit
    }
```

PDF.js applies the public header to initial, streaming, and range reads.
Authenticated wrappers retain refresh, mutation, progress, private-highlight,
and workspace behavior; the public wrapper imports none of them. The shared HTML
view accepts already-sanitized content plus an injected asset resolver, never an
authenticated client. The public EPUB resolver owns token-header fetch, abort,
blob installation, and object-URL revocation.

## 5. Capability contract

Add one static `sharing` policy to `ResourceItemCapability` and its API
projection:

```text
ShareMode =
  None
  CopyOnly
  CopyWithLibraryFiling
  ResourceGrants
  HighlightGrants
  LibraryMembership
```

Final assignments:

| Mode | Schemes |
|---|---|
| `ResourceGrants` | `media` |
| `HighlightGrants` | `highlight` |
| `LibraryMembership` | `library` |
| `CopyWithLibraryFiling` | `podcast` |
| `CopyOnly` | `page`, `note_block`, `conversation`, `oracle_reading`, `artifact`, `contributor` |
| `None` | `evidence_span`, `content_chunk`, `fragment`, `message`, `oracle_passage_anchor`, `artifact_revision`, `external_snapshot`, `reader_apparatus_item`, `passage_anchor` |

Rules:

- The registry is exhaustive over `RESOURCE_SCHEMES`.
- A mode is product policy, not authorization. Services still check the exact
  subject, viewer, entitlement, lifecycle, and audience.
- `media`: grant authority is `can_read_media`.
- `highlight`: grant authority is parent-media readability plus
  `highlight.user_id == viewer`.
- `library`: every member may copy the route; admins create/revoke invitations
  and manage members/roles, while an invitee may accept/decline only their own
  invitation; Default/system libraries are copy-only in practice.
- `podcast`: the existing root-podcast `library_entries` editor is embedded in
  Share; this mode never calls grant or public-projection APIs.
- Unsupported modes fail; they never fall back to a parent or generic
  serializer.

## 6. Persistence

Add one active-row table:

```text
resource_grants
  id                  uuid PK, application-supplied UUIDv7
  subject_scheme      text NOT NULL
  subject_id          uuid NOT NULL
  created_by_user_id  uuid FK users.id NOT NULL
  grantee_user_id     uuid FK users.id NULL
  share_token         text NULL
  share_token_hash    bytea NULL
  created_at          timestamptz NOT NULL DEFAULT now()
```

Exactly one audience branch is valid:

- user grant: `grantee_user_id` present; token fields absent;
- link grant: `share_token` and `share_token_hash` present;
  `grantee_user_id` absent.

The typed writer enforces branch consistency and defects on impossible trusted
rows. Do not add a business `CHECK`, trigger, cascade, audience discriminator,
permission, status, expiry, revocation, metadata, or projection-version column.
`view` is the only permission. Revocation deletes the active row.

Storage constraints/indexes:

- non-cascading user foreign keys;
- unique `share_token_hash`;
- `(subject_scheme, subject_id)` for reference counts and subject cleanup;
- recipient/subject and creator/subject indexes for visibility and
  creator-scoped Share snapshots;
- no subject foreign key: `subject_scheme + subject_id` is a validated
  `ResourceRef`; each resource deletion owner performs explicit cleanup.

The link token is a canonical `nxshr1_`-prefixed, 256-bit random URL-safe
credential matching §4.3.1.
Persist the raw token for creator-only repeat display and a domain-separated
32-byte SHA-256 verifier for authorization lookup:
`SHA-256("nexus-share-token\0v1\0" || canonical_token_ascii)`. Public resolution
parses and hashes the presented token and never compares raw credential text.
Keeping the raw token is a deliberate repeated-display product choice: database
and backup readers can recover active links, so storage access remains
security-sensitive.

Every new sealed entity handle authenticates its type, domain, and version—not
merely its UUID. For entity domain `D` and version `V`, its
`authenticated_handle_input` is the canonical bytes:

```text
"nexus-handle\0" || D || "\0" || V || "\0" || uuid.bytes
```

The wire prefix canonically encodes the same `D,V`; prefix-only separation is
forbidden. The shared primitive verifies exact prefix/version, canonical
base64url, payload/tag lengths, and then the tag in constant time. All new
entity handles, public handles, and cursors use one exact key strategy:

```text
root = strict_base64_decode(effective_stream_token_signing_key)
K(D,V) = HMAC-SHA256(root, "nexus-handle-key\0" || D || "\0" || V)
tag = HMAC-SHA256(K(D,V), authenticated_handle_input)
```

`root` must be at least 32 bytes. There is one current root and no previous-key
verification. Rotating it intentionally invalidates emitted handles/cursors;
entity handles are re-emitted from stored IDs, public handles/cursors are
reminted on the next projection, and outstanding invitation URLs must be
reissued. Share bearer tokens and their stored verifiers are unaffected.
Public handles and cursors use the same `K(D,V)` derivation and their distinct
authenticated input from §4.3.1.
`ResourceGrant`, `User`, and `LibraryInvitation` handles fail after any
prefix/domain/version substitution. The existing `ArtifactBuildHandle` need not
be migrated, but cross-prefix fixtures prove that neither its legacy UUID-only
tag nor a new domain-authenticated tag verifies under the other parser.

The three new entity handles use a 16-byte UUID payload and 16-byte truncated
HMAC-SHA256 tag:

```text
ResourceGrantHandle      = ^nrg1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$
UserHandle               = ^nus1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$
LibraryInvitationHandle  = ^nli1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$
```

`ResourceGrantHandle` is the sealed, non-authorizing outward form of `id`.
Every management operation unseals it and then separately authorizes the current
creator or exact recipient as required by the operation.

`UserHandle` is the sealed outward form of a user ID for every touched
user-search, grant, library-member, invitation, role, removal, and ownership
transfer payload. Raw user IDs remain storage-only. A handle identifies a row;
it never authorizes an action.

`LibraryInvitationHandle` similarly replaces outward invitation IDs in list,
accept, decline, and revoke contracts used by the new surface. No new route or
payload introduced by this cutover names or emits a raw user, invitation, or
resource-grant ID.

This is not a repository-wide identity migration. Existing media, library,
highlight, and route IDs remain outside this identity slice. `ResourceRef` is
the explicit pre-existing UUID-bearing exception:
`<scheme>:<canonical-uuid>`. It identifies a resource, never authorizes access,
and remains the authenticated share-route subject because `resource_items`
already owns it. Anonymous DTOs never expose it.

Idempotence:

- one active link grant per `(created_by, exact subject)`;
- one active user grant per `(created_by, exact subject, grantee)`;
- create performs SELECT then INSERT in the standard serializable-equivalent
  retryable transaction; UUIDv7 and token generation occur inside each retry
  attempt;
- concurrent creates converge to one observable grant;
- the same person may receive separate media and highlight grants.

## 7. Backend ownership and composition

### 7.1 Owners

- `resource_items.capabilities`: static Share mode.
- `resource_grants`: typed grant create/list/revoke/decline, token
  mint/hash/resolve, creator snapshots, and explicit subject cleanup.
- `auth.permissions`: sole scalar/set authenticated visibility definition,
  expanded to grants without creating a parallel predicate.
- `highlight_access`: delegates to the canonical highlight permission instead
  of preserving its current parallel library-intersection implementation.
- `library_governance`, `library_invitations`, `library_entries`: canonical
  owners of closed-group sharing, extended only for sealed user handles, the
  exact `can_manage_members` capability, grant-aware filing, and actor-owned
  access-increase billing checks.
- `locator_resolver` + `reader_locations`: one current format-total highlight
  reader target shared by authenticated routing and public projection.
- `epub_read`, `epub_assets`, `media_file_access`, and `storage.client`: private
  read-only source facts and validated streaming primitives; they do not
  authorize public access.
- public media sharing: token-authenticated, read-only projection; it reuses
  pure reader/media storage helpers but never fabricates an optional/fake
  `Viewer`.
- media/highlight deletion owners and the teardown worker: explicit grant
  cleanup, grant-aware reference counting, and lifecycle assertions.

`resource_grants` is not a `resource_edges` origin and never enters the Nexus
graph.

### 7.2 Lifecycle and races

- Grant create locks the parent media, rejects an armed teardown intent, then
  revalidates the subject and authority before insert.
- Lock order is parent media → highlight, when present → grant row.
- Revoke/decline may discover a candidate by handle before locking, but must
  acquire that same order and then re-read and authorize the caller as the
  current creator or exact recipient before deleting it.
- Media reference count becomes physical `library_entries` plus grants on the
  media or its highlights.
- Creator-first makes teardown observe the grant; teardown-first makes grant
  creation return the existing deleting error.
- Revoking/removing the last reference to document media claims teardown through
  the existing media lifecycle owner in the same database mutation.
- `highlights.delete_highlight_rows` is the sole single-highlight root-deletion
  owner. Every REST, agent-tool, and Vault caller reaches it. Under the
  parent-media → highlight lock order it re-reads the subject, removes every
  exact-subject grant through `resource_grants`, then deletes graph/protocol/
  anchor children and the highlight root. Media-wide teardown performs the
  equivalent child-grant cleanup under its already-held media lock. No caller
  issues a highlight-root delete directly.
- Media teardown asserts no direct or child-highlight grants remain.
- `media_deletion.remove_media_for_viewer` replaces the document-only
  `delete_document_for_viewer` API owner and supports all five media kinds. It
  preserves the existing controlled-entry removal, viewer-state cleanup, hide,
  system-only rejection, locking, and result contracts, and additionally
  removes the viewer’s incoming
  exact-media and child-highlight user grants plus every grant the viewer
  created for that media/its highlights. If it deletes a viewer-owned highlight,
  it also removes every grant whose exact subject is that destroyed highlight.
  It does not delete another creator’s media grant or a grant on a retained
  highlight merely because it reaches the same parent media.
- For `web_article`, `epub`, and `pdf`, zero remaining references claim the
  existing document teardown intent/job. For `video` and `podcast_episode`,
  zero references retain the media, transcript/playback/source rows, and storage
  under the existing audio/video lifecycle and return `Removed`; this cutover
  does not add audio/video physical deletion. Both outcomes leave no viewer
  tombstone when no retained path reaches the viewer.

No job, closure table, grant cache, or materialized per-recipient library entry
is added.

### 7.3 Billing

Reuse `get_effective_entitlements(...).can_share` for every user-owned
access-increasing transition:

- inserting a new user or link grant;
- creating a library invitation; and
- explicitly inserting media or a podcast into a non-default library that,
  after locking and re-reading, has another current member or any pending
  invitation.

`library_entries` owns one actor-aware access-increase guard. The guarded user
commands are `ensure_media_in_library`,
`ensure_media_in_libraries_for_viewer`,
`assign_libraries_for_media[_in_current_transaction]` for every viewer-selected
ingest destination, `add_podcast_to_library`, and agent-tool commands that
delegate to them. User-origin writes never call actorless `ensure_entry`
directly.

`ensure_entry` remains a storage-private primitive and performs no billing.
Default filing, trusted system-library seeding, duplicate canonicalization,
loser-to-winner repoint, repair/backfill of an already-owned relationship,
teardown compensation, and automatic episode/materialization work for a podcast
relationship already admitted by the guard are not new access decisions and are
exempt.

An idempotent create that returns an existing grant is not an access increase
and remains available after downgrade. Copy, read, accept/decline, remove, and
revoke remain available. Existing grants/memberships survive a later downgrade.

## 8. API contract

Authenticated, through the normal BFF:

```text
GET    /resource-items/{resource_ref}/shares
POST   /resource-items/{resource_ref}/shares
DELETE /resource-shares/{resource_grant_handle}
GET    /highlights/{highlight_id}/reader-target
```

POST body is one strict discriminated audience:

```json
{"audience":{"kind":"User","user_handle":"<sealed UserHandle>"}}
{"audience":{"kind":"Link"}}
```

The service resolves the handle once, rejects self-sharing, and authorizes the
subject before writing. User-search results and all touched library payloads
return `UserHandle` and `LibraryInvitationHandle`, never raw user/invitation
IDs.

The authenticated reader-target route returns exactly
`ResolvedHighlightReaderTarget` from §4.4 after current visibility, parent-media,
and locator resolution. Missing, unauthorized, mismatched, and unresolved
highlights return the same masked 404; no older anchor-only or client-guessed
fallback response survives.

GET returns the exact subject, static Share mode, creator-owned active grants,
viewer-owned `ReceivedAccess`, the server-owned canonical authenticated URL,
and audience-specific creation availability:

```text
GrantCreationAvailability {
  user: AudienceAvailability
  link: AudienceAvailability
}

AudienceAvailability =
  { kind: Available }
  | {
      kind: Unavailable
      reason:
        UnsupportedSubject
        | Deleting
        | InsufficientAuthority
        | HighlightUnresolved
        | EntitlementRequired
        | ProjectionNotReady
        | ProjectionUnsupported
    }
```

Both branches require a grant-capable mode, current authority, active lifecycle,
and `can_share`. A highlight additionally requires the exact format-total target
in §4.4. `link` alone requires a currently renderable anonymous projection.
Therefore processing media may return `user: Available` and
`link: ProjectionNotReady`; unsupported anonymous media may return
`user: Available` and `link: ProjectionUnsupported`. POST re-evaluates only the
selected branch under the write lock; an unavailable link branch never rejects
a valid user grant.

When multiple reasons apply, evaluation order is exactly
`UnsupportedSubject` → `Deleting` → `InsufficientAuthority` →
`HighlightUnresolved` → `EntitlementRequired` → link-only
`ProjectionNotReady`/`ProjectionUnsupported`. The projection owner
distinguishes transient not-ready from structurally unsupported.

Canonical absolute links compose the path from `resource_items.routing` with
validated configured `APP_PUBLIC_URL`. They never trust the incoming Host
header or ask callers to concatenate an origin.

Each share is also a closed union:

```text
UserShare { kind: User, handle, user display projection }
LinkShare { kind: Link, handle, public_href }
ReceivedUserShare { kind: ReceivedUser, handle, shared_by display projection }
```

It does not claim to enumerate everyone with access. The only other-user grants
it exposes are viewer-recipient `ReceivedUserShare` rows: the matching exact
subject and, for a media snapshot, qualifying child-highlight rows described in
§4.2. No other recipient or unrelated grant is exposed.

POST is idempotent and returns `{share, created}`. DELETE authorizes either the
grant creator or the exact user-grant recipient and deletes that one row.
Success returns 204; missing, already deleted, and uncontrolled handles return
the same masked 404. Subject-wide Remove media is separate and does not replace
exact decline. Link rotation is DELETE then POST; no update API.

### 8.1 Sealed-identity hard-cut matrix

The touched identity cutover is exactly:

| Boundary | Final contract |
|---|---|
| `GET /users/search` | `user_handle`, email, display name |
| grant `User` audience | `user_handle` |
| `GET /libraries/{library_id}/members` | `user_handle`; no `user_id` |
| member PATCH/DELETE path | `{user_handle}` |
| ownership-transfer body | `new_owner_user_handle` |
| invite-create body | strict `invitee: {kind: User, user_handle} \| {kind: Email, email}` |
| viewer/library invite lists | `invitation_handle`, `inviter_user_handle`, `invitee_user_handle`; no invitation/user IDs |
| accept/decline/revoke path | `{invitation_handle}` |
| invite acceptance membership | `user_handle` |
| `LibraryOut` | `owner_user_handle`; no `owner_user_id` |
| grant management | `resource_grant_handle`; no grant ID |

Every named backend schema/route and frontend client hard-cuts in the same
release. No alias, alternate field spelling, raw-ID route, or dual decoder
survives. Existing library/media/highlight route IDs and the `ResourceRef`
exception in §6 are explicitly outside this matrix.

Anonymous-projection FastAPI routes, reachable only through the trusted internal
BFF:

```text
GET /public/resource-share
GET /public/resource-share/fragments
GET /public/resource-share/navigation
GET /public/resource-share/sections/{section_handle}
GET /public/resource-share/assets/{asset_handle}
GET /public/resource-share/file
```

Every request requires `X-Nexus-Share-Token`, parses/hashes/resolves the
credential, and reauthorizes lifecycle plus exact projection. No bootstrap
response becomes a reusable asset credential. `/file` is PDF-only and streams
from private object storage with backpressure, `Range`/`Content-Range`,
`Accept-Ranges`, exact content type/length, and a sanitized inline filename. It
accepts at most one canonical byte range, returns 416 for malformed,
multi-range, or unsatisfiable input, and never redirects or returns a storage
URL/path. Every new full or range request reauthorizes the share, so revocation
takes effect after commit; bytes already delivered or in an already-authorized
response remain outside Nexus control.

Next mirrors these under `/api/public/resource-share/**` with a specialized
extension of `proxyPublicToFastAPI`. It allowlists GET, request ID, the
share-token header, and `Range` for the exact PDF file route only; strips Cookie,
browser Authorization, and browser-supplied internal-trust headers; then
appends server-owned internal trust. Its response-header allowlist preserves
only content type/length/disposition, byte-range headers, request ID, and the
security/cache headers in §10; it never forwards `Set-Cookie` or upstream
implementation headers. The public page is the token-free route `/s`; do not
reuse the inbound Android/browser capture route `/share`.

The FastAPI auth middleware treats `/public/resource-share` as bearer-exempt
only after its normal internal-header validation. It must not enter
`PUBLIC_PATHS`, because that would bypass BFF trust validation.

Status evaluation order is security-relevant:

1. Vercel edge limiting may return its generic 429.
2. FastAPI validates BFF internal trust.
3. After trust succeeds, every endpoint parses/resolves the share token and
   revalidates grant, lifecycle, exact subject, source revision, and projection.
   Any failure returns the masked 404.
4. Only for a valid projection does it parse endpoint-specific media kind,
   public handle/cursor, pagination, or Range. Wrong-kind, malformed, stale,
   tampered, or cross-token handle/cursor returns the masked 404; authorized
   malformed pagination returns the ordinary closed validation 422; authorized
   malformed, multi-range, or unsatisfiable PDF Range returns 416.

An invalid token therefore never obtains a pagination or Range oracle.

## 9. Frontend contract

Add one workspace-level Share controller with an exhaustive target:

```text
ShareTarget =
  { kind: Resource, ref: ResourceRef }
  | { kind: Route, href: NexusHref, label: string }

ShareOpenOptions {
  return_focus_to: ReturnFocusTarget
  return_focus_fallback: Presence<ReturnFocusTarget>
}

openShare(target: ShareTarget, options: ShareOpenOptions)
```

It owns one responsive overlay: shared `Dialog` on desktop and always-mounted
`MobileSheet` on mobile, with existing focus trap, return-focus, Escape/back,
safe-area, and keyboard behavior.

Rules:

- `WorkspaceHost` derives a synchronous `PaneShareIdentity` from the already
  resolved route and `resolvePaneResourceLocator`, then passes it to
  `PaneShell`; it never waits for `PaneRuntimeContext.resourceRef` or hydrated
  `resourceItem`.
- A `resource_ref` locator becomes `ShareTarget.Resource` immediately. A
  supported non-resource pane becomes `ShareTarget.Route` through its route
  owner. Unsupported/internal panes have no target and no Share action.
- `PaneShell` removes its raw `href` copy responsibility and replaces “Copy pane
  link” with “Share…” only when that identity exists.
- A resource target resolves its authenticated URL through
  `resource_items.routing`. It never silently degrades to the route variant
  when the resource snapshot fails.
- `NexusHref` is a branded leading-slash same-origin canonical pathname produced
  by the resolved route owner. Its constructor rejects schemes, hosts,
  protocol-relative paths, traversal, query, hash, and unsupported routes. It
  is never derived from `window.location` or transient pane state. Only the
  final clipboard/native-share adapter combines it with the configured app
  origin.
- The overlay opens immediately. Resource loading retains row geometry and
  disables unresolved controls; typed permission/lifecycle/billing errors remain
  visible and retryable. Copy success is never announced before the canonical
  URL is available.
- Central action descriptors pass `ActionSelectDetail.triggerEl` as
  `return_focus_to`; pane chrome or the stable reader highlight anchor is the
  fallback when an opener unmounts. Close, Escape, backdrop, mobile drag, and
  browser Back all use the same retained return-focus contract.
- Row/dropdown Share actions are added only through central action builders.
- `mediaResourceOptions` removes the standalone “Libraries…” action; the Media
  Share overlay owns the library-entry editor.
- `libraryResourceOptions` always offers Share for a visible library. “Edit
  library” becomes Settings.
- `buildHighlightActions` is the sole highlight Share action owner across the
  sidecar, clicked-highlight popover, and selection popover.
- Nexus launcher resource and canonical-route targets use the same Share
  controller. Its old Nexus `copy-link` target/dispatch is deleted. A genuinely
  external href may retain an explicitly named “Copy external link” action.
- Selection Share follows the existing create-then-act pattern; the created
  highlight remains if the overlay is dismissed.
- `copyText(value): Promise<void>` is the one clipboard owner. It resolves only
  after Clipboard API or fallback success and rejects if both fail. Every caller
  awaits it; only resolved copy announces success, while failure stays visible
  and retryable.
- Native Share is feature-detected and invoked only from a user gesture.
- Native Share beside the Nexus link shares only the authenticated URL. The
  public-link row exposes its own native Share only after the link already
  exists; it never inserts a grant and then risks losing browser user activation
  before calling `navigator.share`.
- Update `Permissions-Policy` so `web-share=(self ...)`.
- X is available only for an active bearer link and requires an explicit
  confirmation that posting sends the bearer credential to X and makes an
  unlisted link effectively published.
- Copying never creates a grant. Turning on “Your public link” is an explicit
  mutation.
- The control is labeled “Your public link,” not
  “Restricted / Anyone with link.” Turning it off revokes only this user’s link.
- Public-link disclosure: “Anyone with this link can read the media and may
  share it again. Turning this off revokes only your link; it cannot revoke
  copies or other access paths. Your notes and other highlights stay private.”
  The highlight variant adds “This highlight is included.”
- Direct-user disclosure: “This person can read and reshare the media. They may
  already have access another way.”
- Rights disclosure: “Only share content you may redistribute.” Do not promise
  download prevention.

Library Share:

- all members: Copy link/native Share with “members only”;
- admins, as reported by the exact `can_manage_members` governance capability:
  member list, pending invitations, invite search, roles, removal, and
  revocation;
- non-admins: current role plus “Membership is managed by library admins”;
- no Anyone-with-link, public URL, X, or public permission control.

Admin copy states that removal closes only the membership path; a former member
may retain access through another library or grant, including a media grant they
created while they could read it.

Library UI uses two deliberately separate state machines:

- `LibraryMemberEditor`: people, roles, invitations, removal, and ownership
  transfer; it is embedded only by the library Share variant.
- `LibraryEntryEditor`: filing an existing media or podcast through
  `library_entries`; media, podcast-episode, and podcast-root Share variants
  embed it.

They share no DTO merely because both mention libraries. Hard-cut
`LibraryMembershipPanel` into the embeddable `LibraryEntryEditor`; a narrow
`LibraryEntryPanel` overlay may wrap it only for non-Share flows such as Add
Content. Share never nests that overlay. Remove standalone Libraries actions
from media, episode, and podcast-root menus.

`LibrarySettingsDialog` owns only name/settings and deletion. No
member/invitation/ownership-transfer fetch, state, or markup survives there.

Visual and accessibility standard:

- Reuse the existing surface, type, spacing, border, focus-ring, motion, and
  color tokens. Share introduces no bespoke visual language.
- Present a stable hierarchy: Nexus link, Your shares, Shared with you when
  `ReceivedAccess` is non-empty, Your public link, then Libraries where
  applicable. Each received row says whether the exact media or included
  highlight supplies the path and offers path-local Decline. Async rows retain
  their geometry; loading, empty, success, billing, permission, and
  retryable-error states are explicit.
- Public-link On is visibly labeled “Unlisted,” never “Private.” Copy success is
  announced through the established polite live region rather than conveyed by
  color alone.
- Revoking a user or public-link path requires an accessible inline
  confirmation that names the path-local consequence. Turning a link on does
  not require confirmation.
- Search/results use the established keyboard listbox behavior; every icon
  action has a text label or accessible name; touch targets, contrast, focus
  order, reduced motion, long names, localization growth, mobile safe areas,
  and on-screen keyboards are covered in browser tests.
- When a compact selection toolbar cannot fit Share without shrinking touch
  targets, the central action model places the lower-priority action in its
  existing More menu; Share is not duplicated.
- The public reader reuses source-reader typography and layout but no workspace
  navigation, private chrome, AI controls, or authenticated state. Every masked
  failure renders the same calm “This link is unavailable” surface with no
  existence or login hint.

## 10. Public-route security

- HTTPS only; high-entropy tokens; verifier lookup; masked 404.
- Public BFF strips cookies, Authorization, and browser-controlled internal
  headers and forwards only Nexus internal trust.
- Within Nexus-controlled systems, the raw token lives only in the shared URL
  fragment, public-reader memory, the dedicated request header, the
  creator-authorized API response, and credential storage. It never enters a
  Nexus-controlled HTTP request target, server/client log, request-context
  field, error, analytics event, telemetry payload, cache key, SSR metadata, or
  recorded test snapshot. The token header is forbidden to generic logging
  helpers.
- Copy public link, native Share public link, and confirmed X are the only
  permitted credential egress, each behind an explicit user gesture on an
  already-created link. Clipboard/OS destinations receive the complete bearer
  URL; X receives it inside a plain `x.com` intent request target. Before native
  or X egress, the UI states that the destination gains bearer access and may
  retain the credential. Nexus loads no sharing SDK, preconnect, prefetch,
  image, or script from those destinations. Authenticated-link native Share
  never contains a token.
- The public client never persists the token or projection in local/session
  storage or a shared authenticated cache. On fragment/token change it aborts
  in-flight reads and clears the prior projection before resolving the new
  token.
- `/s` and public APIs set `Cache-Control: private, no-store`,
  `Referrer-Policy: no-referrer`, and `X-Robots-Tag: noindex, nofollow`.
- `/s` is an exact unauthenticated Next route outside the authenticated layout.
  Browsers may still send ambient same-origin cookies to Next; the page ignores
  them and the BFF never forwards them. Do not describe the browser request
  itself as cookie-free.
- The public route has a dedicated CSP limited to the app plus the minimum
  `blob:`/`data:` reader needs. It loads no analytics, third-party assets,
  embeds, or authenticated API clients. Because the server never receives the
  fragment, OG metadata is generic; client code may update the document title
  after successful resolution.
- The dedicated policy preserves the global `object-src 'none'`, closed
  `base-uri`, closed `form-action`, and anti-framing guarantees and sends
  `X-Content-Type-Options: nosniff` plus same-origin resource isolation. Only
  the public reader’s exact image/font/style/connect needs are opened.
- Vercel WAF is the sole public edge limiter because every anonymous request
  first reaches Next. Checked-in desired state and an idempotent sync/read-back
  script own a fixed 60-second window of 120 requests per Vercel-validated
  source IP across `/api/public/resource-share` and every descendant path, with
  the provider’s default 429 action. In a fresh window the release verifies the
  first 120 requests reach the app and the 121st receives 429, then records the
  active firewall configuration version. Do not promise a provider-unstated
  `Retry-After`, parse client IP in the app, or add a second limiter.
- Every grant-backed API, EPUB asset, and new PDF range read reauthorizes after
  revocation. Already delivered bytes are covered by the honest limits below.

Threat model and honest limits:

- 256-bit entropy makes online guessing impractical; edge limiting protects
  service capacity, not weak tokens.
- Anyone who receives a bearer link can copy it. It may remain in browser
  history, clipboard history, screenshots, or third-party messages; fragment
  isolation keeps passive navigation out of Nexus request targets and referrers,
  not out of explicit clipboard/native/X destinations.
- A user-grant recipient may create an independent media grant. Revoking the
  upstream path does not recursively revoke downstream paths.
- A reader can copy, print, download, photograph, or screenshot visible content.
  This is access control, not DRM.
- Revocation blocks requests begun after its commit; it cannot cancel every
  already-authorized response or erase bytes already rendered/downloaded by a
  reader.
- “Your shares” is a privacy-preserving creator view, not provenance or a global
  access graph. Account compromise remains account compromise.

## 11. Hard-cut file plan

### Create

- `migrations/alembic/versions/0191_universal_resource_sharing.py`
- `python/nexus/schemas/resource_sharing.py`
- `python/nexus/services/sealed_handles.py`
- `python/nexus/services/resource_grants.py`
- `python/nexus/services/public_resource_sharing.py`
- `python/nexus/api/routes/resource_shares.py`
- entity-specific user/invitation sealing adapters in their existing service
  owners and focused handle/grant/public/migration tests
- `apps/web/src/components/sharing/ShareOverlay.tsx` + styles/tests
- `apps/web/src/components/sharing/{LibraryMemberEditor,LibraryEntryEditor,LibraryEntryPanel}.tsx`
- `apps/web/src/lib/sharing/` controller, strict authenticated/public decoders,
  API client, public asset resolver, and tests
- `apps/web/src/lib/reader/readerTargetHash.ts` + tests
- authenticated and public BFF routes under the API paths in §8
- final handle-named library BFF route directories (`[userHandle]`,
  `[invitationHandle]`) replacing raw-ID directory names
- `apps/web/src/app/s/` token-fragment route plus read-only public article,
  EPUB, PDF, and transcript wrappers
- `deploy/vercel/firewall/resource-sharing.json`
- `deploy/vercel/sync-resource-sharing-firewall.sh`
- `deploy/smoke/resource-sharing-cutover.sh`
- one real-stack multi-user/public-link Playwright flow

### Modify / centralize

- `python/nexus/db/models.py`
- `python/nexus/auth/{middleware,permissions}.py`
- `python/nexus/api/routes/__init__.py`
- `python/nexus/api/routes/health.py` for the deployed revision
- `python/nexus/api/routes/{highlights,libraries,media,users}.py`
- `python/nexus/schemas/{highlights,library,user}.py`
- `python/nexus/services/{users,highlights,highlight_access,library_entries,library_governance,library_invitations,media_deletion}.py`
- `python/nexus/services/{locator_resolver,reader_locations,epub_read,epub_assets,media_file_access}.py`
- `python/nexus/services/public_source_urls.py`
- viewer-selected ingest destination and `agent_tools/writes.py` callers of
  `library_entries`
- `python/nexus/services/resource_items/capabilities.py`
- `python/nexus/services/resource_items/routing.py`
- `python/nexus/schemas/resource_items.py`
- highlight/media visibility consumers in search, resolve, and reader access
- `python/nexus/tasks/media_teardown.py`
- `python/nexus/storage/client.py` for one validated single-range read primitive
- `apps/web/src/lib/api/proxy.ts`
- `apps/web/src/lib/resources/resourceCapabilities.ts`
- `apps/web/src/lib/security/headers.ts`, CSP/route middleware
- `apps/web/src/middleware.ts`
- `apps/web/src/lib/panes/paneRuntime.tsx`
- `apps/web/src/lib/panes/{paneRouteModel,paneResourceLocator}.ts`
- `apps/web/src/components/workspace/{WorkspaceHost,PaneShell}.tsx`
- `apps/web/src/lib/ui/copyText.ts` and every caller
- `apps/web/src/lib/actions/resourceActions.ts`
- `apps/web/src/components/highlights/highlightActions.tsx`
- `apps/web/src/components/SelectionPopover.tsx`
- `apps/web/src/lib/launcher/{model,actions,dispatch}.ts`
- `apps/web/src/lib/reader/useReaderTarget.ts`
- `apps/web/src/components/{HtmlRenderer,PdfReader}.tsx`
- authenticated media reader owners under
  `apps/web/src/app/(authenticated)/media/[id]/`:
  `MediaPaneBody.tsx`, `TranscriptContentPanel.tsx`, and
  `TextDocumentReader.tsx`
- library/podcast callers:
  `LibraryPaneBody.tsx`, `LibrariesPaneBody.tsx`,
  `PodcastDetailPaneBody.tsx`, `PodcastEpisodeList.tsx`, and
  `PodcastsPaneBody.tsx`
- `apps/web/src/lib/libraries/sharing.ts` and touched
  `/app/api/{users,libraries}/**` BFF routes
- `deploy/hetzner/{deploy.sh,docker-compose.yml,README.md}` for pinned revision
  reporting and gated choreography
- `docs/architecture.md`, new `docs/modules/resource-sharing.md`, and
  `docs/modules/library.md`; keep `docs/modules/sharing.md` narrowly owned by
  inbound Android/browser capture

### Delete / rename

- delete `LibraryEditDialog.*`; create the narrower
  `LibrarySettingsDialog.*`;
- delete the `LibraryMembershipPanel.*` name/overlay ownership after extracting
  `LibraryEntryEditor` and its narrow non-Share wrapper;
- delete `[userId]`/`[inviteId]` library BFF route directories after creating
  the handle-named final routes;
- delete membership/invitation state and handlers from Edit/Settings callers;
- delete “Copy pane link,” standalone media/episode/podcast “Libraries…,” Nexus
  launcher `copy-link`, void/best-effort clipboard behavior, duplicate
  clipboard handlers, obsolete tests/styles/comments, and any superseded share
  modal;
- do not retain old component exports, prop shims, route aliases, payload
  aliases, or compatibility decoders.

Historical migrations and superseded cutover documents remain immutable.

## 12. Implementation slices

1. **Storage/capability:** migration, model, typed grant service, sealed handle,
   exhaustive capability policy.
2. **Authenticated access:** APIs/BFF; scalar/set media and highlight
   visibility and all consumers; lifecycle/reference-count composition; sealed
   touched user identities; billing.
3. **Public projection:** token resolver, public DTOs/read endpoints, auth
   exemption after internal trust, token-header BFF, fragment page, and
   route-specific security policy.
4. **Universal overlay:** controller, responsive overlay, pane/row/highlight
   actions, selection create-then-share.
5. **Library consolidation:** membership-only Share variant;
   `LibrarySettingsDialog`; remove duplicate Libraries/Edit responsibilities.
6. **Extirpation/acceptance:** negative source gates, focused backend/browser
   tests, real-stack multi-user/public-revocation flow, docs update.

No slice ships independently.

### 12.1 Production hard-cut choreography

“No mixed versions” means no mixed contract is reachable by user traffic; it
does not pretend independently hosted processes switch atomically. The release
pins one clean Git commit as `CUTOVER_SHA`.

Before pushing/deploying that commit, the operator:

1. applies the temporary checked-in Vercel maintenance rule to the production
   app, with only the release-smoke source excluded from that maintenance rule;
2. verifies ordinary production requests are gated;
3. stops the Hetzner API and worker so no old writer remains;
4. takes and verifies a PostgreSQL backup after writers have stopped; and
5. applies/read-backs the permanent public rate-limit desired state in §10.

While the gate is closed:

1. push `CUTOVER_SHA` and wait for the Git-triggered Vercel production
   deployment metadata to report that exact commit;
2. run `deploy/hetzner/deploy.sh` from a clean checkout whose
   `HEAD == CUTOVER_SHA`; the deploy records that revision, migrates through
   `0191`, then starts API and worker from the same revision;
3. combine two evidence tiers: local real-stack E2E proves authenticated
   API/BFF share contracts and sealed identities; the deployed typed operator
   fixture proves entitlement, authority, projection readiness, public-BFF
   ambient-authority independence, anonymous projection/range reads, and
   revocation without requiring a production user session. Also verify
   API/worker/Vercel revision and the 121-request WAF smoke from the release
   source; the maintenance exception never bypasses the permanent rate-limit
   rule; and
4. keep the gate closed until that source enters a fresh, verified 60-second
   WAF window and an anonymous probe reaches the app; and
5. record `CUTOVER_SHA`, migration head, Vercel deployment ID, backend image
   revision, firewall configuration version, smoke results, and opening time.

Only then is the temporary maintenance rule removed. The operator immediately
repeats the deployed typed-fixture create/public-read/revoke smoke through the
ordinary production path and verifies the unique test token is absent from
Nexus-controlled request targets/logs.

If any check fails before opening, keep the gate closed, stop new services,
restore the verified backup if schema/data rollback is required, redeploy the
previous matching web/API/worker revision, and verify it before opening. After
opening, reapply the gate and stop writers, then forward-fix. Restoring the
pre-cutover database after user writes is disaster recovery requiring an
explicit data-loss decision, not the routine rollback path. Never run previous
code against an unknown `0191` database state.

## 13. Verification contract

Verification is requirement-shaped and focused; `make verify` is not the default
gate for this cutover.

- Migration/model: upgrade from the previous head, downgrade/upgrade, exact
  schema/index inspection, malformed trusted-row defect tests, no orphaned grant
  after every in-scope subject deletion path, and proof that both user FKs are
  non-cascading/restrictive. There is no user-deletion test obligation.
- Identity boundaries: canonical parse/assume tests plus malformed,
  pairwise cross-domain/prefix/version substitution, tampered, truncated,
  noncanonical, missing, and unauthorized behavior for every new handle/token;
  the exact §8.1 matrix contains no raw user/invitation/grant ID.
- Concurrency: deterministic two-transaction tests for duplicate user/link
  create, create versus teardown, revoke/decline versus teardown, highlight
  delete versus grant create, and final library/grant reference removal.
- Filing/removal: grant-only and membership-only filing across all five media
  kinds, tombstoned restore behavior, exact recipient decline, path-local
  downstream survival, and subject-wide Remove media across all five kinds.
- Visibility parity: table-driven scalar and set-query tests for membership,
  incoming grant, creator grant, highlight author, exact-highlight grant,
  tombstone, teardown, revoke, global search, exact resolve, and default-library
  exclusion.
- Highlight targets: authenticated and public links load/focus article, EPUB
  cross-section, transcript text/time, and PDF page/geometry targets; stale and
  mismatched targets never focus a fallback location.
- Public projection: strict decoder/egress tests for every tag, extra/private
  field, bound, source-URL allowlist, pagination, non-finite PDF value, and
  geometry-only highlight; malformed/unknown/revoked/deleted tokens and
  malformed/stale/tampered/cross-token handles/cursors produce the specified
  identical 404; invalid-token + malformed Range still returns 404; every
  subresource reauthorizes; EPUB assets require the header; `/file` is PDF-only,
  honors valid byte ranges, returns authorized malformed/unsatisfiable ranges as
  416, and never returns a storage locator.
- Security: auth-middleware order, BFF header allowlist/stripping, route CSP,
  no-store/referrer/robots headers, no raw token in Nexus-controlled request
  targets/log context, no passive third-party egress, explicit native/X egress,
  ambient-session independence, public PDF range reauthorization, and private
  storage-locator non-disclosure.
- Billing: user-grant, link-grant, invitation, media filing, podcast filing, and
  every viewer-selected ingest/agent path share one actor-owned gate; idempotent,
  Default, system, dedupe, repair, materialization, and teardown paths prove
  their stated exemptions.
- UX/accessibility: central action ownership, no mutation on copy, creator-scoped
  language, pre-hydration pane identity, truthful async clipboard feedback,
  opener/fallback focus, Escape/back, mobile keyboard/safe-area behavior,
  selection create-then-open, public-link disclosure, launcher replacement,
  non-owned-highlight absence, and library admin/non-admin variants.
- Real stack: user A shares with B; B reads and reshares to C; A revokes and B/C
  outcomes demonstrate path-local revocation; incognito opens/revokes media,
  highlight, article, EPUB, transcript, and PDF links; logs are inspected for a
  unique test token; the deployment edge limit and §12.1 one-SHA gate are
  smoke-verified.

Expected focused command shape after the named tests exist:

```bash
(cd python && uv run ruff check \
  nexus/auth/middleware.py nexus/auth/permissions.py \
  nexus/api/routes/health.py nexus/api/routes/highlights.py nexus/api/routes/libraries.py \
  nexus/api/routes/media.py nexus/api/routes/resource_shares.py nexus/api/routes/users.py \
  nexus/schemas/highlights.py nexus/schemas/library.py nexus/schemas/resource_items.py \
  nexus/schemas/resource_sharing.py nexus/schemas/user.py \
  nexus/services/epub_assets.py nexus/services/epub_read.py nexus/services/highlight_access.py \
  nexus/services/highlights.py nexus/services/library_entries.py nexus/services/library_governance.py \
  nexus/services/library_invitations.py nexus/services/locator_resolver.py \
  nexus/services/media_deletion.py nexus/services/media_file_access.py \
  nexus/services/public_resource_sharing.py nexus/services/reader_locations.py \
  nexus/services/resource_grants.py nexus/services/sealed_handles.py nexus/services/users.py \
  nexus/services/resource_items/capabilities.py nexus/services/resource_items/routing.py \
  nexus/storage/client.py nexus/tasks/media_teardown.py \
  tests/test_resource_grants.py tests/test_resource_sharing_routes.py tests/test_sealed_handles.py)
(cd python && uv run ruff format --check \
  nexus/auth/middleware.py nexus/auth/permissions.py nexus/api/routes/health.py \
  nexus/api/routes/highlights.py nexus/api/routes/libraries.py nexus/api/routes/media.py \
  nexus/api/routes/resource_shares.py nexus/api/routes/users.py nexus/schemas/highlights.py \
  nexus/schemas/library.py nexus/schemas/resource_items.py nexus/schemas/resource_sharing.py \
  nexus/schemas/user.py nexus/services/epub_assets.py nexus/services/epub_read.py \
  nexus/services/highlight_access.py nexus/services/highlights.py nexus/services/library_entries.py \
  nexus/services/library_governance.py nexus/services/library_invitations.py \
  nexus/services/locator_resolver.py nexus/services/media_deletion.py \
  nexus/services/media_file_access.py nexus/services/public_resource_sharing.py \
  nexus/services/reader_locations.py nexus/services/resource_grants.py \
  nexus/services/sealed_handles.py nexus/services/users.py \
  nexus/services/resource_items/capabilities.py nexus/services/resource_items/routing.py \
  nexus/storage/client.py nexus/tasks/media_teardown.py \
  tests/test_resource_grants.py tests/test_resource_sharing_routes.py tests/test_sealed_handles.py)
./scripts/with_test_services.sh sh -c 'make _test-back-db-ready && cd python && NEXUS_ENV=test uv run pytest -v --tb=short tests/test_resource_grants.py tests/test_resource_sharing_routes.py tests/test_sealed_handles.py tests/test_permissions.py tests/test_media_deletion.py tests/test_media_libraries_endpoint.py tests/test_podcasts.py tests/test_highlights.py tests/test_vault.py tests/test_media_library_concurrency.py'
make test-migrations
(cd apps/web && bunx eslint src/components/sharing src/lib/sharing src/app/s src/app/api/public/resource-share --max-warnings 0)
(cd apps/web && bun run typecheck)
(cd apps/web && bun run test:browser -- src/components/sharing src/lib/sharing src/lib/reader/readerTargetHash.test.ts src/lib/security/headers.test.ts src/app/api/proxy-routes.test.ts)
bash -n deploy/vercel/sync-resource-sharing-firewall.sh deploy/smoke/resource-sharing-cutover.sh deploy/hetzner/deploy.sh
deploy/vercel/sync-resource-sharing-firewall.sh --check
make test-e2e PLAYWRIGHT_ARGS="tests/resource-sharing.spec.ts"
```

The backend integration command deliberately uses the real test services while
remaining file-scoped because sharing spans PostgreSQL transaction, permission,
and deletion owners. Browser and E2E commands remain path-scoped. A release is
not accepted from mocks or unit tests alone.

## 14. Acceptance criteria

- **AC1 — Schema:** only `resource_grants` is added; it has the exact §6 shape,
  application-supplied UUIDv7 IDs, a 32-byte verifier, the subject-only index, no
  business checks/cascades/status/options, restrictive user FKs, and malformed
  trusted branches defect. Every in-scope subject deletion cleans grants; account
  deletion remains out of scope.
- **AC2 — Capabilities:** every `RESOURCE_SCHEME` has exactly one Share mode;
  backend/API/frontend mirrors agree; `podcast` is
  `CopyWithLibraryFiling`; unsupported schemes cannot create grants or reach a
  generic projection.
- **AC3 — Media authority:** any library/member/direct-grant reader with
  `can_share` may grant media; a recipient may reshare; creator identity is not
  required. A grant-only reader can explicitly file all five media kinds without
  an automatic Default-library insert.
- **AC4 — Highlight privacy:** only the author may grant a highlight; recipients
  see parent media plus that highlight; no media grant exposes annotations or
  notes. Authenticated/public links resolve and focus exact article, EPUB,
  transcript, and PDF targets without guessing.
- **AC5 — Visibility twins:** scalar media/highlight predicates, set SQL,
  `highlight_access`, search, resolve, and reader consumers agree for membership,
  incoming grants, creator grants, tombstones, teardown, and revocation.
- **AC6 — Libraries:** library URLs copy without changing access; non-members
  remain masked; no library link grant/public route exists; admins govern
  membership/invitations and invitees may accept/decline only their own.
- **AC7 — Grant lifecycle:** create is concurrent-idempotent; the creator may
  revoke and the exact recipient may decline one incoming user grant; DELETE
  removes one path and preserves downstream grants; subject-wide Remove media
  works for all five kinds; deletion/teardown races linearize on media; grants
  retain media; final document removal can claim teardown, while zero-reference
  video/episode media follows the explicitly retained lifecycle.
- **AC8 — Anonymous reader:** logged-out media and owned-highlight links render
  every supported reader kind through the exact §4.3.1 DTOs and source-URL
  allowlist; bounds and geometry-only PDF highlights are modeled; invalid/
  revoked/deleted links and malformed/stale/tampered/cross-token public handles
  return the specified identical 404; every asset reauthorizes the header token;
  no private field or mutation API is reachable.
- **AC9 — Revocation/security:** grant/API/EPUB requests begun after committed
  revoke fail; a new PDF full/range read also fails and no storage URL/UUID
  escapes; tokens are absent from Nexus-controlled request targets/logs,
  referrers, caches, and indexing; public native/X egress occurs only by the
  explicit disclosed user actions.
- **AC10 — Share UX/shareability:** every target whose mode is not `None`
  exposes exactly one Share action through its central owner; `None`,
  non-routeable resources, and non-owned highlights expose none. Copy-only and
  route targets cannot mutate grants. Pane identity exists before hydration;
  media/library/podcast/highlight/launcher actions use central builders; Nexus
  launcher has no `copy-link`; clipboard feedback is truthful; desktop/mobile
  focus and dismissal work.
- **AC11 — Library UI:** library Share owns `LibraryMemberEditor`, including
  ownership transfer; media/episode/podcast Share embeds
  `LibraryEntryEditor`; no nested library-entry dialog exists; Settings owns no
  member/share state; Default/system libraries expose copy-only behavior.
- **AC12 — Billing:** new grants/invitations and actor-owned media/podcast filing
  into a library with another member or pending invitation require `can_share`
  through the named commands; idempotent, Default, system, dedupe, repair,
  materialization, teardown, read, acceptance, and revocation paths follow their
  explicit exemptions.
- **AC13 — Public hygiene:** exact route `/s` is outside the authenticated
  layout, distinct from `/share`, independent of ambient session, token-free at
  the Nexus-controlled request-target layer, third-party-free until explicit
  user egress, no-store, no-referrer, noindex/nofollow, and protected by a
  verified deployment edge limit.
- **AC14 — Extirpation:** live code/tests contain no old pane-copy action,
  standalone media/episode/podcast Libraries action, Nexus launcher copy-link,
  `LibraryMembershipPanel`, membership-bearing Edit Library component,
  void/best-effort clipboard contract, duplicate share UI, legacy route/payload
  alias, fake public viewer, public pseudo-library/user, or sharing
  `resource_edges`.
- **AC15 — Verification:** migration tests, focused permissions/grant/media/
  highlight/library/public-route integration tests, browser-mode overlay/action
  tests, CSP/header tests, and one real-stack multi-user + incognito + revoke E2E
  pass.
- **AC16 — Identity/API:** every §8.1 route/field uses the sealed final shape and
  no raw user/invitation/grant ID or alias survives; `ResourceRef` is the
  acknowledged existing UUID-bearing exception; audience/share/availability
  variants are strict and PascalCase; management handles identify but never
  authorize; creator/recipient snapshots never claim to be a global ACL.
- **AC17 — Availability/API:** User and Link availability are independently
  typed and ordered; pending/unsupported public projection can disable Link
  without disabling User; POST rechecks only its selected audience; invalid
  token authorization precedes public pagination/key/Range validation.
- **AC18 — Release:** the maintenance gate prevents a reachable mixed contract;
  Vercel, API, and worker report one `CUTOVER_SHA`; migration/firewall/smoke
  evidence is recorded; local real-stack authenticated API/BFF evidence and
  deployed typed-fixture public evidence jointly cover §12.1; pre-open rollback
  and post-open forward-fix follow §12.1.
