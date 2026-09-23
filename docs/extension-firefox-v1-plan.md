# firefox capture v1

status: implementation plan; documentation only this turn · 2026-09-23
scope: approved [review](extension-firefox-v1-review.md), narrowed by the owner's
hard-cutover instruction. this document owns the implementation contract.

## outcome and boundaries

toolbar → current document; “add link to nexus…” → clicked pdf/epub link.
both open one compact form: source/title/type, normal nexus login if required,
the shared additional-library chooser, optional text preview, **save**.
all is implicit; zero additional libraries is valid. selection starts empty
for each new capture and survives login. show the generic note: “members of
selected libraries can read this item”; do not invent per-library sharing flags.
saved means verified source bytes and placements are durable; processing is
accepted or already complete. later extraction failure remains repairable.
success shows “saved” and “open in nexus”; it does not wait for extraction.

non-goals: other browsers, firefox android, private/container windows, autosave,
remembered destinations, library creation, arbitrary linked html import, youtube,
server scraping, file-picker fallback, local/blob/reader-view capture, full asset
archiving, automatic content replacement, offline sync, new workflow infrastructure.
unsupported input is an explicit error; never try a different source after failure.
normal web imports remain independent supported features.

## fixed decisions

- minimum firefox **153**: native document identity avoids a custom navigation
  protocol; installed firefox is 156. older versions are excluded.
- one manifest-v2 firefox build with a persistent background page. this is a
  current firefox capability, chosen to finish long transfers after popup closure;
  no mv3 build, keepalive tricks or extra transfer tab. indexeddb still owns crash
  recovery. trade-off: resident memory and firefox-specific packaging; the
  alternative offered upfront is mv3 with a visible transfer tab.
- one upload lifecycle for pdf, epub and browser-article packets: extend
  `media_upload_sessions`, whose publication already follows verified storage.
  small articles pay extra upload/confirm round trips; avoid a second acceptance
  and retransmission protocol.
- reuse exact captured bytes within the importing account. changed snapshots
  create new media; existing content/highlights are never replaced. duplicate
  saves still upload/verify before reuse; no speculative preflight shortcut.
- bounded, inert article evidence; ordinary image links only. this sacrifices
  full-page reconstruction and protected-image durability. no publisher cookies,
  form credentials or unrelated application state leave the browser. source urls
  may contain signed query parameters: retain them as source data, redact them
  from logs/display, and include this disclosure in capture consent.
- no extension library creation; no automatic restart transfer. these reduce
  authority and background activity at the cost of explicit user actions.

## contracts

new wire types use snake_case, existing uuid/handle/url validators and
`Presence<T>` for semantic absence; reject unknown fields. reuse upload results,
errors and destination pagination unchanged.

```text
capture intent:
  kind: web_article | pdf | epub
  source_url: http(s) url; filename: string; content_type: accepted mime
  size_bytes: positive integer; sha256: lowercase 64-hex digest
  library_ids: distinct writable non-default library ids
  Idempotency-Key header: one uuid generated per save, never per request

article packet (utf-8 application/json; one immutable object):
  url, base_url, title, content_html: string
  source_html: string (empty allowed)
  byline, excerpt, site_name, published_time: Presence<string>

upload response: existing UploadRequired | NeedsAttention | Published
```

file mime is `application/pdf` or `application/epub+zip`, established from bytes.
article packet: at most 4 mib; `content_html` at most the existing 2 mib utf-8
limit; `source_html` at most 64 kib. reuse current metadata/url bounds.
`source_html` contains only rebuilt iframe `src/title` and twitter-quote
`blockquote/a[href]` text evidence consumed by `document_embed_extraction`.
resolve relative urls against `base_url`; preserve article links/apparatus. before
serialization project content-bearing markup: remove scripts, forms/controls,
hidden state, event handlers and arbitrary `data-*`. retain content attributes
accepted by `sanitize_html`, plus only the ids/classes/link/apparatus attributes
consumed by `html_apparatus` and `web_article_structure`; never forward arbitrary
attributes. sensitive article prose is still article content, not detectable
credential state. the server independently validates/sanitizes the packet,
digest and source-url agreement; it owns canonical text and provider interpretation.
do not render raw html in the popup. file limits retain current defaults: 100/50 mib.

## api and backend composition

all extension calls pass through the existing bff extension proxy. backend paths
below have matching `/api` routes. tokens authorize these exact methods/routes;
capture operations verify `created_by_user_id` and `input_origin.kind ===
"BrowserCapture"`; this is provenance, not the request's http `Origin`.

| method / backend path | contract |
| --- | --- |
| `GET /auth/extension-sessions/current` | account identity and capture byte limits; bff remains `/api/extension/session` |
| `DELETE /auth/extension-sessions/current` | existing revocation; forget local credential only after confirmed success |
| `GET /extension/library-destinations?q&cursor&limit` | existing writable-destination service/schema; no create authority |
| `POST /extension/captures` | strict capture intent; creates/replays an existing upload session |
| `GET /extension/captures/{handle}` | read-only status; sign only the existing generation's remaining lifetime; expired means `NeedsAttention` |
| `POST /extension/captures/{handle}/confirm` | existing generation input; `Published` only after atomic publication |
| `POST /extension/captures/{handle}/retry` | existing body: `filename`, `content_type`, `size_bytes`, `client_mutation_id`, `expected_generation`; advance once; command retries reuse the mutation id |
| `POST /extension/captures/{handle}/transport-failure` | existing typed transport report |
| `DELETE /extension/captures/{handle}` | existing unpublished-session removal; cannot delete published media |

`UploadRequired` supplies the existing signed put capability. upload directly to
its configured storage origin, with only its required headers; nexus bearer
credentials never accompany storage or publisher requests. confirm does not
re-download a publisher url. session status is capture status; open the existing
imports/media surface for later processing/retry. retry cannot change the source
url/digest. `E_UPLOAD_ALREADY_PUBLISHED` means read status and accept its receipt.

schema changes stay with the upload/source owners:

- add non-null, strictly decoded `input_origin` jsonb to upload sessions:
  `{kind: "LocalFile"}` or `{kind: "BrowserCapture", source_url, sha256}`.
  existing web upload routes construct `LocalFile`; extension routes construct
  `BrowserCapture`. allow `web_article` only for the latter. backfill existing
  sessions to `LocalFile` once; require every writer to supply its variant.
- extend immutable intent comparison with origin/digest. same operation key
  with any changed bytes, source metadata or destinations returns conflict.
  use the existing canonical-json/hash primitive; no second hashing convention.
- add nullable `browser_capture_sha256` to media, populated only for new browser
  captures, and an index on `(created_by_user_id, kind, browser_capture_sha256)`.
  no global url/content uniqueness. article identity hashes the exact packet;
  file identity hashes original bytes. exclude request id and destinations.
- drop upload-session uniqueness of published media/source-attempt references.
  one media may have several completed capture receipts. update deletion to
  enumerate all such sessions; imports records each capture operation while
  libraries contain one media. do not add an alias/receipt subsystem.

publication: reserve a fresh candidate path per confirmation; copy staging into
it; verify that candidate's actual size/type/signature/digest and strict article
packet. never verify mutable staging and later publish a shared candidate path.
one transaction serializes account/kind/digest, checks session generation, locks
an authorized/non-deleting exact match or creates media, revalidates destinations,
adds all placements, creates attempt/job only for new media, and publishes the
receipt. fence success AND failure by generation and unpublished state. network
work stays outside transactions; existing reservations reclaim losing candidates.
retain existing lock order. these changes also fix the shared local-upload owner.

read authorization, not extraction success, controls reuse: preserve processing
or failed state. choose historical matches deterministically. the first media's
metadata survives; each session retains its source url. deleted/unreadable matches
do not regain visibility.

article source attempts own one packet `storage_path`; they never create a
`media_file` row. the article adapter reads that packet and composes the existing
structure/metadata pipeline. file publication records browser provenance and
uses existing pdf/epub processing. retries retain immutable input references;
only generated attempt outputs are replaceable. unrelated source types retain
their own acquisition contracts.

## firefox runtime

one background owner handles one active capture; another activation resumes it.
publication retains only a small receipt. this limits capture throughput in
exchange for no queue: finish or discard pending work before starting another.

```text
target = article {tabId, windowId, documentId, url}
       | document {windowId, url, source:
           page {tabId, frameId, documentId, pageUrl} | extension}

local flow = draft → acquiring → prepared → transferring → confirming → saved
             failures retain target; after prepared, retain exact bytes/key
```

pin before login; extract the article from a cloned live dom immediately. never
reinject into a replacement document. bind same-origin menu targets by resolving
`targetElementId` immediately in the clicked frame, then retaining its native
document id; same-url reload fails binding. the clicked `linkUrl` stays immutable.
an uninspectable http(s) toolbar target shows type “document” and the explicit
“save pdf or epub” action. internal schemes fail immediately. extraction failure
never enters document mode. `tabs.Tab` supplies no reliable viewer mime.

select download context once: eligible same-origin link uses firefox
`content.fetch` in its pinned page, not ordinary mv2 content-script `fetch`;
otherwise background fetch uses granted origin access. include publisher
credentials only in that chosen browser context. one bounded get classifies
pdf/epub from response/bytes; html fails. no head requests or context switching.
bound actual streamed bytes; derive filename from disposition/final url.
redirects must satisfy that context's cors/permissions; arbitrary publisher/cdn
redirects are not promised. retain acquisition query parameters unchanged.

indexeddb stores the draft, immutable blob/packet, operation key, account,
destinations and upload handle/generation. save freezes intent; disable edits
thereafter. persist prepared state before the first capture mutation; quota
failure blocks save. pass bounded blobs by firefox structured clone, acknowledging
only after indexeddb commits; no base64/chunk protocol. store credentials separately
in extension storage. after browser restart, show explicit resume:
read the known session (or replay create with the same key); retry confirm before
reuploading uncertain bytes. discard aborts/settles active work; clear unsubmitted
drafts, otherwise resolve uncertain create and delete the unpublished session.
if published, report saved, not cancelled. publication or confirmed discard
releases bytes and the slot. first successful identity lookup binds a signed-out
draft to its account; only that account can resume it after reconnect.
disconnect stops active work and retains account-bound recovery state; forget
credentials only after confirmed revocation, retaining a retry handle on failure.

manifest: `manifest_version: 2`, `browser_action`, persistent `background.scripts`,
`activeTab`, `identity`, `scripting`, `storage`, `menus`; exact nexus/storage hosts plus
publisher hosts in `optional_permissions`, `incognito: "not_allowed"`, gecko
`strict_min_version: "153.0"` and truthful `data_collection_permissions`.
the popup renders required origins, then calls `permissions.request` directly
on acquire/save, before any await/message or acquisition. denial retains the
draft. reuse hosted login, per-flow correlation and exact allowed callback.
focus the original window, then `browserAction.openPopup`;
if it closed, retain work for next activation. use native `browser.*` promises.

typed messages expose only capture commands and decoded view state; content
scripts never receive nexus credentials or arbitrary authenticated-fetch powers.
validate sender/target/document identity. no external message bridge. explicit
retry resumes the same operation; no timers, heartbeat keepalives or background
offline resubmission. new builds pin nexus/storage origins in manifest/config,
documented in `.env.example`; no editable base url in the popup.

## ui, packaging and independent ownership

| track | exclusive files / responsibilities |
| --- | --- |
| a — backend | `python/nexus/schemas/media.py`, new capture schemas/routes, auth middleware/session routes, `media_upload_sessions.py`, source adapter/artifact owners, imports/deletion/storage integration, `db/models.py`, one alembic migration; matching web bff capture routes/proxy; bytes-first publication and packet conversion |
| b — browser runtime/extraction | `apps/web/src/extension/{background,content,captureContract,captureStore,captureClient}.ts`, `apps/extension/manifest.json`; reuse already browser-safe `node/ingest/article_extraction.mjs`, node package/lock; auth/acquisition/projection/persistence/messages |
| c — ui/build | `apps/web/src/extension/{popup.tsx,popup.html,popup.module.css}`, shared `LibraryDestinationTrigger.tsx`, `LibraryDestinationField.tsx`, `lib/libraries/destinationContract.ts`, `lib/media/uploadSessionContract.ts`, their direct consumers; `vite.extension.config.ts`, `scripts/build-extension.mjs`, web package/lock/type/lint, `.env.example`, `.github/workflows/ci.yml`, `scripts/test` |
| d — integration owner | this spec, temporary live harness/fixtures, migration rehearsal, qualification evidence and resolved-ticket removal; coordinates a/b/c contracts before parallel edits |

reuse controlled `LibraryChooser`, `Input`, `Button`, `FeedbackNotice` and token
css. extract the destination trigger/summary, pure destination types/decoder and
upload types/decoder currently private in `lib/media/ingestionClient.ts`.
keep web transport/invalidation/picker/auth/modal/history out of the bundle.
popup has fixed bounded geometry, scrollable chooser, keyboard search/toggle,
escape/focus return and announced status; `create={null}`. follow the packaged
offline shelf for local fonts/viewport overrides; do not copy palette values.

reuse installed vite/react and the offline build pattern. output is ignored
`apps/extension/dist`; source manifest/icons have one owner. popup uses a module
bundle; injected/background files are self-contained classic bundles. clear output
once; bundle readability from its sole `node/ingest` dependency owner. local/ci
setup installs that locked dependency tree. validate manifest references/version/
origins at build. include extension build/type/lint in the sole permanent
`./scripts/test` gate. no new monorepo/package framework.

## hard cutover

remove old `apps/extension/{popup.js,popup.html,popup.css,content.js,vendor/Readability.js}`,
old token storage reader, extension `capture/article`, `capture/file`, `capture/url`
bff/api routes and their exclusive acceptance helpers/schemas/auth entries. keep
generic url import for the main app; remove only extension access/routing to it.
update every moved import directly; no reexports, dual formats or feature flags.

revoke old extension credentials and require reconnect; use one new storage namespace.
quiesce upload/capture requests, affected source jobs and retries for cutover.
one-shot conversion inventories existing browser article inputs, stores verified
packets, and changes source references without changing media ids, memberships,
highlights or reader publications. missing inputs stop conversion for explicit
repair. retain original blobs through the rollback window, then use existing
cleanup; no storage calls in alembic.
do not delete user content or backfill content dedup by guessing historical bytes.
remove conversion tooling after its verified run. verify database/source backups;
rollback restores code and data together, never a compatibility mode.

## red / green / refactor / remove

the owner's explicit instruction authorizes a temporary integration/live harness
for this cutover, overriding the local static-only rule only for that work.
the permanent gate remains static. deleting tests forfeits automatic behavioral
regression coverage; retain concise passing evidence, not a dormant harness.
use a dedicated firefox profile and disposable
accounts/libraries on real local nexus/auth/database/object-store/worker services.
temporary selenium/geckodriver automation must operate the installed extension's
actual toolbar/context menu/popup, not an ordinary tab pretending to be a popup.
use an authenticated fixture hostname allowed by existing url validation,
routed through the dedicated profile/proxy; no localhost-validation bypass or
production test switches. chrome-context geckodriver needs `--allow-system-access`.
a real subscribed-page smoke complements controlled fixtures.

| acceptance journey | decisive assertions |
| --- | --- |
| login/identity | signed-out toolbar capture resumes the pinned document; navigation/account change cannot substitute another source/user |
| article/libraries | authenticated beginning/end sentinels, links/apparatus and embed evidence survive; private fields/scripts/`data-*` inside readable content do not leave browser; all plus two destinations; zero additional works |
| document entry | real right-click epub and direct/extensionless pdf preserve byte hashes; same-origin redirect works; blocked cross-origin redirect fails without switching context |
| refusal | denied permission, html-as-document, unreadable article, oversized stream and invalid packet fail without media publication or another acquisition route |
| lifetime | close actual popup during a deliberately delayed transfer; save completes; restart explicitly resumes immutable work; discard/new capture cannot strand the active slot |
| replay/storage | drop responses, fail writes, race duplicate saves and generation changes; published bytes cannot be overwritten or newer generations rejected by old results; one receipt per operation, one item per identical content, atomic placements; retry processing from packet |
| authority/cleanup | revoked destination blocks publication; another account/local-upload handle is denied; repeated-content receipts and media deletion clean all session support; failed disconnect is visible |
| presentation/cutover | keyboard-only chooser/save/error recovery; no unresolved css variables; old routes/formats/token storage rejected; converted articles remain readable and retryable |

sequence: freeze contracts → write/run red journeys against baseline → implement
a/b/c → green on real firefox/services → adversarial boundary review → refactor
and rerun affected journeys + static gate → record concise evidence/limits →
delete temporary tests, fixtures, dependencies, profiles and only their test data
→ rerun `./scripts/test`. never delete failing tests to manufacture completion.
every track reviews its invariants before coding and submits to a different
reviewer at green; integration review specifically attacks crash windows,
authorization, source substitution, duplicate ownership and accidental extra scope.

done: every journey has observed passing evidence; no unresolved in-scope defect,
temporary test artifact or legacy path remains; affected module docs and ticket
register match the final owners. package a signed unlisted firefox artifact with
stable id and truthful data declarations; signing credentials/install access are
execution prerequisites, not reasons to add infrastructure or claim unrun checks.
