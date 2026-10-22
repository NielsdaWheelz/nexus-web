# ingest

ingest turns a source someone points at (a url, a file, the page in front of them, an email, a podcast transcript) into a media's content, durably: an acceptance is never lost, the work runs in the background, and a failure is visible with the recovery that can still help.

owners (`python/nexus/services/`): `source_types.py` (the vocabulary, a leaf the supervisor reads), `source_attempts.py` (the attempt rows, their enqueue, the recovery policy and `media_source_supersessions`), `media_source_ingest.py` (admission: url accept, embedded children, transcript requests, retry, refresh, repair), `source_runner.py` (the `ingest_media_source` job), `source_adapters.py` (acquisition per source type), `source_publication.py` (the fence, progress, terminal failure and the job's queue hooks), `email_ingest_service.py` (the Post Room), `media_upload_sessions.py` (upload sessions), `extension_sessions.py` (the extension bearer). routes: `api/routes/media_sources.py`, `api/routes/media_uploads.py`, `api/routes/email_ingest.py`, `api/routes/extension_captures.py`, `api/routes/extension_sessions.py`. clients: `apps/web/src/lib/imports/ingest.ts` (the web's url and upload protocol, and the menu's `requestSourceRefresh`), `apps/web/src/extension/` (the Firefox capture), `apps/web/src/app/share/ShareCapture.tsx` (the Android share page).

## concepts

- **attempt chain.** a media's `media_source_attempts` rows, ordered `attempt_no desc, created_at desc, id desc`; the first is the latest and the only authoritative one. status runs `accepted → queued → running → succeeded | failed`; an attempt born for a known source is born `succeeded` or `failed`, mirroring its media. the payload carries source facts: `ingest_purpose`, `request_reason` (transcripts), `storage_path` (a capture packet or an email body), `article_id` (the expected identity of an independently acquired native x article), nullable `x_article_binding` (a browser article's frozen replacement intent) and, on an inline X-post child's settled attempt, `parent_source_attempt_id` (the parent run it came from; a successor drops it).
- **supersession.** a run whose source another media already holds settles onto that winner, transfers CURRENT holdings/placements through `library_entries.transfer_current_media_references`, and claims its own media for teardown. loser-only entries keep their id, position and timestamp; duplicates keep the winner id/position and earliest timestamp. winner removal markers survive; loser suppression carries unless the winner was independently readable before transfer. suppressed viewers gain no default holding. publication holds ordered media/library locks and never takes a viewer lock or replays old destination payloads; `media_source_supersessions(source_attempt_id, media_id, created_by_user_id)` keeps every loser attempt's destination and original actor, including a failed acceptance whose retry found the winner. existing aliases move with the loser too; all die with the winner. url retries resolve this mapping before answering a still-present loser; another actor's id is refused. historical mappings with unprovable ownership retain null and refuse replay. the mapping owns current destination identity, not historical processing outcome. dossier research resolves a re-requested url through it (`superseding_media_id`, held shared).
- **successor.** same-source recovery after `a` has the id `uuid5(a, "successor")`. every recovery admission (retry, refresh, system repair) and settled x-post child's completion create exactly that row, so a request that already landed finds its own effect. a newly confirmed browser replacement instead owns a fresh attempt through its upload receipt; it is not an api recovery successor.
- **identity.** youtube video, x thread, x post, native x article and an exact web url are deduped: their admission takes one advisory lock per source identity (I12), then reuses the media that source already became (a web article whose `canonical_url` is the normalized url and that is not in teardown; a redirecting url, or an article in teardown, is found only by the run, which supersedes). an email maps to one media by its Message-ID.
- **recovery.** one policy over the latest attempt: an in-flight attempt whose exact job is dead offers repair; a failed attempt its creator can re-acquire offers retry (a native X source whose refresh failed keeps its readable copy, so its media stays ready and the retry is still offered); a same-source-terminal error, or a stored source whose bytes are gone (`E_SIGN_UPLOAD_FAILED`, `E_STORAGE_MISSING`), offers nothing. refresh is offered and admitted by one predicate (`source_refreshable`): the creator's settled source on a ready or failed media with no such restriction. every rule reads the attempt's `error_code`.
- **run.** the job marks the attempt running, keeps a detached snapshot, acquires with no transaction open, then settles: the url families publish through their owners (web article, youtube, podcast transcription) and the runner mirrors the media's outcome; files and X sources are prepared here and published in the runner's terminal transaction (native X positions follow canonical source generations and explicit unresolved-position adoption). only catalogued terminal codes settle a failure, each a typed refusal no retry changes (a lost stored source never comes back; a publication its store refuses, `E_RESOURCE_CONFLICT`, refuses again), at once; anything else re-raises to the queue (three tries, then dead and the repair offer). a resource limit or a podcast transcript fails at dead-letter.
- **upload session.** bytes go browser -> storage directly (Vercel caps bodies at 4.5 MB) and become media only after the server verifies them. the client mints the session id; the intent (kind, filename, content type, size, origin `LocalFile | BrowserCapture{source_url, sha256, x_article_binding}`) never changes. creation keeps an initial destination draft; final confirmation freezes removal/destination guards and persists the winning destination ids. every create of an unpublished, unrejected session advances its generation: a new staging path `uploads/sessions/<id>/<generation>/` and a fresh five-minute url, so a failed PUT is answered by creating again, never reported. confirm copies the current generation's staged object to a fresh candidate under `media/<candidate media>/candidates/`, verifies size, content type, sha-256 and the file signature (or the strict article packet), then publishes once. a deterministic refusal (`E_SOURCE_INTEGRITY`, `E_INVALID_FILE_TYPE`, `E_FILE_TOO_LARGE`, `E_CAPTURE_TOO_LARGE`) settles the session `Rejected`; only removal remains. Imports derives its state set-wise (`UPLOAD_SESSION_DERIVED_STATE_SQL`): `Published`, `VerificationFailed`, `CapabilityExpired` (the url lapsed with no publication: Retry upload picks the original file and creates again) or `AwaitingBytes`; a published session keeps its `upload:<session id>` import.
- **capture.** one draft lives in the Firefox background page's memory: native `documentId`, packet/downloaded bytes and sha-256, destination choices, session id, generation, frozen confirmation and byte-upload fact. initial save is create -> PUT -> confirm. an unknown answer retains/retries the exact frozen request. a known guard conflict permits review and confirmation with the SAME session, generation and staged bytes before expiry, without another create or PUT. failed byte transfer requires upload again; expiry, reload or owner loss requires recapture. discard forgets the draft and removes its unpublished session in passing. extraction clones the live page and strips scripts, styles, form controls, hidden subtrees, handler/style/`data-*`/`srcdoc` attributes and unsafe urls; the server sanitizer owns admission. same-origin links download in the page's principal; others use the background's granted origin. the bearer alone lives in `storage.local["nexusCaptureCredential"]`; confirmed revocation or 401 forgets it.
- **share page.** `/share?text=` (the Android share sheet in the shell's webview, or a browser): urls are listed with a destination field (create allowed, one id per name for the page) and saved two at a time, each under its own id for the page's life, so Retry resends the same acceptance; plain text is appended to today's daily note under a date and note id fixed on first send. signed out, it says so and saves nothing.
- **post room message.** a signed MIME message to the owner's inbox: its readable html is stored first, then media, attempt, default-library entry and job commit together; the sender is credited after the commit (re-applied on every redelivery).

## native x articles

`x_client.lookup_x_carrier` inspects the submitted post before any thread search.
article metadata plus one unambiguous official expanded article url identifies a
native `article:<id>` child; a missing article field is qualified absence only
on that lookup. `x_article_inspections(thread_media_id, carrier_post_id)` owns the
current observation. no row is uninspected; null `article_id` is a negative; a
known id with null `article_media_id` means the child was deleted. discovery,
child admission, destination assignment and enqueue commit under the root
attempt's fence. thread enumeration and child acquisition then run independently.

the child has source type `x_article`, the carrier post as `provider_target_ref`,
and its expected article id in the attempt payload. it rechecks identity through
the official api. `article.plain_text` publishes as literal escaped prose with
an explicit api-text notice: original formatting/media are absent and completeness
is unverified. no body, malformed body or teaser-only responses fail
`E_X_ARTICLE_BODY_UNAVAILABLE`; identity drift fails `E_X_ARTICLE_IDENTITY_CHANGED`.
each settles independently and permits explicit later retry. direct article urls fail
400 `E_X_ARTICLE_POST_LINK_REQUIRED` before admission, asking for the article's
post link. the native provider id alone dedupes articles; their
verified link is `canonical_source_url`, leaving the generic canonical url key
unclaimed and old browser captures independent.

`x_article_sources(media_id, source_attempt_id, completeness)` owns current-body
provenance. prepared native publication commits it with body, metadata, reader
generation, attempt success and reindex admission. failed/pending attempts cannot
relabel an existing copy. after browser publication, api retry/refresh and stale
api publication refuse; updating means capture again.

the extension resolves before extraction: native `/i/article/<article_id>` has
an article id; rendered `/<username>/article/<carrier_post_id>` has a post id.
status pages remain ordinary captures. an owner-scoped verified local carrier
association resolves the latter; otherwise one official lookup runs outside the
database transaction. missing identity or provider failure refuses preflight.
the returned binding pins article id and either the native target's media id,
latest attempt and reader generation, or checked no-match. create and confirm
lock the viewer and upload identity/session before carrier/article identities and
media locks, then the complete library set. target drift returns
`E_CAPTURE_TARGET_CHANGED`; placement/removal guard conflicts return
`E_RESOURCE_CONFLICT` and permit reviewed confirmation while staging is live.
staleness, deletion, active work or a newly appearing target require recapture;
none invokes ordinary capture. a published receipt replays before live target
checks. binding lives outside the unchanged article packet. selected libraries
are additive; old copies are untouched. the popup pins account, documentId and
url, announces replacement, and offers capture again after submission.

canonical post publication owns literal authored text. article references are
renderer-only `link_preview` rows at the exact carrier revision's body end;
their caption/source link never enters canonical text or indexing. the current
reader occurrence binds the card separately. only direct submitted-carrier
lookup admits an article; secondary posts and edit discovery never enqueue
additional articles. an edited carrier cannot inherit an older revision's card.
the submitted revision's independently admitted child remains a related import
when edit resolution advances the displayed post; that relationship does not
transplant its preview onto the newer revision.
main's native publisher proves thread membership, retains canonical post ids,
reparents inspections before loser teardown and owns source-generation changes,
positions and annotation identity. no aggregate-thread replacement path remains.

a re-add files all linked children, including failed ones, without retrying them.
uninspected carriers and explicitly deleted children require fresh discovery on
that write. reads never resurrect children. same-carrier active runs may join;
another carrier conflicts. no duplicate capture conversion or merge is performed.

## contracts

http (`Data{data}`; the web reaches them under `/api`):

| route | request | answer | retry rule |
|---|---|---|---|
| `POST /media/from-url` | `{id, url, expected_removal_revision, destinations:[{library_id,expected_order_revision}]}` | 202 `{import_ref, media_id, source_attempt_id, created, processing_status}` | `id` is the client's attempt id, a version 4 uuid (successor and system ids are version 5, so a client never names one): a surviving own receipt answers identity without acquisition or filing effects, regardless of submitted guards; another user's id is 409 `E_RESOURCE_CONFLICT`; a fresh acquisition or join must pass all frozen guards atomically; stale is 409 `E_RESOURCE_CONFLICT`. a join has no receipt of its own and cannot bypass guards on retry. `created` is true only when the answered attempt is this request's and its media's first |
| `GET /media/source-attempts/{source_attempt_id}` | none | `{source_attempt_id, media_id, import_ref, settled}` | read-only canonical destination under current media visibility. the requested attempt id is retained; `settled` follows the current destination's latest source attempt, including after supersession, because a retry or refresh can find a different holder. unavailable or invisible is 404 `E_IMPORT_NOT_FOUND`. processing outcomes belong to Imports |
| `POST /media/{id}/retry` | `{expected_attempt_id}` | 202 `{media_id, source_attempt_id, job_id}` | the expected attempt's successor exists: 202 with it; a stale expectation: 409 `E_RESOURCE_CONFLICT` with `current.attempt_id`; nothing to retry: 409 `E_RETRY_NOT_ALLOWED` |
| `POST /media/{id}/refresh` | `{expected_attempt_id}` | 202 `{media_id, source_attempt_id, job_id}` | the expected attempt's successor exists: 202 with it; a stale expectation: 409 `E_RESOURCE_CONFLICT` with `current.attempt_id`; the expected run still in flight answers itself; a settled refreshable source gets a successor (a native X article first keeps its readable copy published); otherwise 409 `E_RETRY_NOT_ALLOWED` |
| `POST /media/{id}/repair` | `{kind: "Source", expected_attempt_id, expected_job_id}` or `{kind: "Search", expected_revision, expected_job_id}` | 202 `SourceRepair` or `SearchRepair` | the same attempt (revision) and job, no longer dead, is the repair that landed; stale: 409 |
| `POST /ingest/email` (public) | raw MIME, `X-Nexus-Email-Signature` (hex hmac-sha256 of the body), `X-Nexus-Email-Recipient` | 200 `{outcome: accepted \| duplicate, media_id}` | Message-ID (else a digest of the first 4 KiB) maps to one media. 503 unconfigured or owner not a uuid · 413 · 401 signature · 403 recipient · 400 unparseable or no sender · 500 `E_STORAGE_ERROR` when the body cannot be stored (nothing created; the worker defers, so the sender retries) |

uploads and captures (`Data{data}`; the web under `/api`, the extension under `/api/extension` with its bearer and `X-Nexus-Wire`, 426 on another wire):

| route | request | answer | retry rule |
|---|---|---|---|
| `POST /media/uploads` | `{id, kind: pdf \| epub, filename, content_type, size_bytes, library_ids}` | `UploadRequired{import_ref, session_id, generation, upload_url, content_type, expires_at}` \| `Published{import_ref, session_id, media_id, created, current_placements}` \| `Rejected{import_ref, session_id, code}` | the same id and intent: an unpublished, unrejected session advances its generation; a settled one answers as settled. another intent: 409 `E_UPLOAD_INTENT_MISMATCH`; another user's id: 409 `E_RESOURCE_CONFLICT`. refusals before any write: 400 `E_INVALID_FILE_TYPE`, `E_FILE_TOO_LARGE` (the server's limit), `E_INVALID_REQUEST` |
| PUT `upload_url` | the exact bytes, only `Content-Type`, no credential | storage's 2xx | before `expires_at`; a failure is answered by creating again |
| `POST /media/uploads/{session_id}/confirm` | `{generation, expected_removal_revision, destinations:[{library_id,expected_order_revision}]}` | `Published` | a surviving published receipt returns identity and current placements at any generation, without applying new choices; unpublished stale guards: 409 `E_RESOURCE_CONFLICT`, with bytes reusable until expiry; expired: 409 `E_UPLOAD_CAPABILITY_EXPIRED`; a stale generation: 409 `E_UPLOAD_GENERATION_STALE`; no bytes: 400 `E_STORAGE_MISSING`; a recorded rejection: its 4xx again; storage down: 500 `E_STORAGE_ERROR` |
| `DELETE /media/uploads/{session_id}` | none | 204 | absent is done; published: 409 `E_UPLOAD_ALREADY_PUBLISHED`. the account removes its own session of either origin |
| `GET /extension/capture-target` | `source_url` | `{x_article_binding: {article_id, native_target: {media_id, expected_source_attempt_id, expected_reader_generation} \| null} \| null, target_title: string \| null}` | read; no reservation; known article without a target has a nonnull binding; ordinary pages have null |
| `POST /extension/captures` | `{id, kind: web_article \| pdf \| epub, source_url, filename, content_type, size_bytes, sha256, library_ids, x_article_binding}` (distinct) | as `/media/uploads` | as `/media/uploads`; binding is required and nullable; another account's id is 409 |
| `POST /extension/captures/{session_id}/confirm`, `DELETE …` | as uploads | as uploads | as uploads; only `BrowserCapture` sessions |
| `GET /extension/library-destinations` | no query parameters | complete `{removal_revision,destinations:[{id,name,order_revision}]}` | read; no create authority |
| `POST /auth/extension-sessions` (account) | none | 201 `{id, token, created_at}` | a new token per call; the extension keeps the last |
| `GET`, `DELETE /auth/extension-sessions/current` (bearer) | none | `{user_id, email, display_name, limits}`, 204 | a revoked or unknown token is 401, which the extension reads as revoked |

the extension (Firefox ≥ 153, manifest v2) is one build of three bundles (`bun run build:extension` -> `apps/extension/dist`: the popup page, the persistent background page, the injected content script), pinned to `NEXUS_EXTENSION_NEXUS_ORIGIN` and `NEXUS_EXTENSION_STORAGE_ORIGIN` (bare http(s) origins, also its optional host permissions). sign-in is `identity.launchWebAuthFlow` against `/extension/connect/start?redirect_uri&state`, which answers `#token=…` or `#error=session_failed&request_id=…` at the one redirect origin `NEXUS_EXTENSION_REDIRECT_ORIGINS` names; a command that needs an origin waits for Firefox's grant (`permissions.onAdded`) before its first network call.

the article packet is one utf-8 json object in a fixed key order (`url, base_url, title, content_html, source_html, byline, excerpt, site_name, published_time`), at most 4 MiB, `content_html` within the web-article limit, `source_html` at most 64 KiB; `decode_article_packet` is its one decoder. the live add/share owner retains the session id, generation, frozen confirmation and byte-upload fact in memory. endpoint refusals map onto `UploadSessionOutcome`; a failed PUT requires upload again, an unknown confirmation retries its exact frozen command, and a known guard conflict permits reviewed confirmation against the same staged bytes. expiry or owner loss requires file reselection/recapture. no browser-persisted command state or server reconfiguration endpoint exists.

the web carries the returned `source_attempt_id` in an accepted url's media route. it resolves that acceptance before mounting a reader, then replaces the route with the settled canonical media. waiting and failed reads retain a route to Imports. post-save placement resolves current settled identities; an active source's view-import action opens the in-progress list rather than selecting a provisional media.


published upload `current_placements` is the canonical named placement snapshot,
including removal revision, or null when the media is removed/unavailable. it
reports current state rather than proving the submitted choices applied. source
and upload receipts share media lifetime: normal hard teardown deletes them.
thereafter upload confirmation is 404; a url submission without a surviving
receipt must pass its original frozen removal guard before any effect. no replay
ledger or durable command journal extends those receipts. storage/provider i/o
runs outside viewer/library-lock transactions. staged bytes may exist physically
after expiry, but unpublished confirmation is valid only before
`upload_url_expires_at`.

recovery admissions require the media's creator (403 `E_OWNER_REQUIRED`; an unreadable media is 404).

in process: `accept_url_source` (a fresh session, frozen removal revision and destination guards; dossier research journals its removal revision in the existing typed web-picks payload with `search_completed:false` BEFORE provider i/o and commits that checkpoint under its running-job fence. an interrupted search may repeat provider work with the SAME revision; completed results carry `search_completed:true` and never search again. retries never refresh the fence, and conflicted source acquisitions are omitted; it sends `uuid5(NAMESPACE_URL, "dossier:<key>")`), `accept_system_url_source` (the caller's transaction; the oracle corpus sends `uuid5(NAMESPACE_URL, "oracle:<key>")`; both refuse another user's id with 409, as over http), `accept_embedded_source` (flush-only, requiring retaining parent identity/current visibility and preserving child removal markers; the publisher enqueues a created child with `source_attempts.enqueue_attempt` in its own transaction), `enqueue_podcast_episode_transcript_source_attempt`, `complete_x_post_capture_attempt`, `repair_source_for_system_media`, `reusable_embedded_source_media_ids`. readers of the policy: `source_recovery`, `source_refreshable`, `source_repairable_sql` (the media projection, whose answers Imports and the action menu show), `load_source_progress` (Imports). supersession: `rehome_supersessions`, `superseding_media_id`.

job: `ingest_media_source {media_id, attempt_id, actor_user_id, request_id}` (background, heavy, retries after 60 and 300 s, keeps its dead row; hooks `source_publication.on_failure`, `on_dead_letter`, `import_history.on_source_job_outcome`).

## invariants

- **I1** a run writes only inside `run_source_publication_phase`: media rows locked ascending, then the attempt, which must be the job's, in flight and latest, with the queue claim live.
- **I2** a media has at most one attempt in flight: an accept joins it; retry and refresh never stack on it.
- **I3** a terminal failure writes the attempt's `error_code` and the media's `last_error_code` in one transaction (a podcast transcript fails through its transcript owner and leaves the episode readable; a media whose publication is retained stays ready and the attempt alone carries the failure).
- **I5** a session's intent never changes; only verified bytes of its current generation publish, and publication is the `published_at` write under the session row lock (a rejection is fenced the same way).
- **I6** every extension route reaches only `BrowserCapture` sessions (loaded by viewer and origin kind; anything else is not found); the extension bearer authorizes nothing outside `/extension/*` and its own session route.
- **I8** a capture reuses the account's oldest readable media of the same kind and sha-256 (`Published{created: false}`), under the `browser_capture:<user>:<kind>:<sha256>` identity lock; local uploads of identical bytes never dedupe. a matched native article binding instead replaces that target (`created: false`); checked no-match uses ordinary capture only while the eligible target set remains empty.
- **I9** an epub's reader identities are never replaced: retry, refresh and repair refuse (409 `E_REPAIR_NOT_ALLOWED`) once a publication, fragment, reading position, highlight or anchor exists.
- **I10** an attempt has at most one same-source recovery successor, `uuid5(attempt.id, "successor")`; newly captured replacement bytes have their own receipt/attempt.
- **I11** an attempt commits `accepted` only with its job in the same transaction (url accept, system accept, transcript request, upload confirm, email, every recovery; an embedded child is enqueued by its publisher before that commit). nothing reconciles a jobless attempt.
- **I12** an explicit url accept locks the viewer `FOR NO KEY UPDATE`, then admission/source identities, then media rows in uuid order and the complete default/named library set. guards precede effects; accepted named destinations advance even for no-ops. an embedded X post locks its post key after its publisher's rows, as every taker of that key does; an embedded youtube child locks nothing (taking the url accept's key after rows would invert its order) and dedupes on `uix_media_canonical_url`, whose violation retries into reuse.
- bytes are written before the row that names them; an object no row names (a failed commit, a superseded file, a lost race, a reused capture's candidate, a write that lands after a teardown) is the storage orphan sweep's, at least 24 hours later; staged upload bytes expire with R2's one-day `uploads/` rule. nothing reserves a path.

## native x sources

`services/x_client.py` acquires the requested post or same-author thread plus one
hop of direct quotes, reply parents and repost targets. `schemas/x_source.py` owns
normalized evidence; `services/x_source.py` owns its current persisted snapshot,
coverage and excerpt. retain full authored wording, url observations, supplied image
descriptions and attributed context. nested references never trigger another fetch.
author-thread searches explicitly begin at the provider's archive floor,
`2006-03-21T00:00:00Z`, on every page; omitting this bound restricts results to
the last 30 days. the existing post budget still limits acquisition.
`post_limit` means enumeration stopped at the configured bound; `exhausted` means
enumeration ended, not that every historical post remains available.

`services/x_ingest.py` prepares source and reader content before publication. the
source coordinator's exact claim and ordered media locks fence one transaction that
installs reader content, snapshot and excerpt, settles the attempt, and admits indexing
and naming. a newly completed quoted child receives its own snapshot and naming job.
a child with a reader publication retains its independent source, including an ongoing
refresh. identity reuse transfers access and supersedes onto the existing holder;
it installs no new evidence or naming obligation.

reader content and naming consume the same evidence. quotes retain their existing
embeds; external reply/repost context follows the primary content, and references to
other primary posts do not repeat them. the reader retains attachment links to
preserve source wording and saved positions. standalone posts keep their generic
quote footer when enhanced with embeds; threads keep their attributed footer.
the immediate title is the first
nonempty authored opening, shortened at a unicode word boundary within 120 code
points without splitting a grapheme. when that would retain only an opening mention
or hashtag, keep the grapheme prefix. quote/attachment tokens are removed from title
evidence; meaningful links remain. textless evidence uses
`x post by @handle` or `x thread by @handle`. generated titles belong to the existing
metadata job, independently of source readiness.

## source refresh

`POST /media/{id}/refresh` requires `expected_attempt_id`; its 202 response is a
`SourceAdmission` with media, attempt and job ids. `services/media_source_ingest.py`
admits retry and refresh through one successor step while keeping their policies
distinct ([ingest](ingest.md)). authorization, the exact latest attempt and source
policy precede mutation; the new attempt and its job commit together. a resend of
the same expectation answers the successor that landed; a fresh stale expectation
conflicts. browser retries resend the original expectation.

a media retains its readable publication while refresh is queued, running, failed or
stopped (`retained_publication_sql`: a web article's or pdf's reader publication, a
native x source's saved copy): it stays ready, its reading state untouched, and the
refresh's publication replaces the copy only when it lands. the source attempt records
refresh failure (Imports shows it) and supports ordinary retry or exact dead-job
repair; refresh is offered again unless its error is same-source terminal. saved
evidence is never reconstructed from rendered fragments. first imports keep ordinary
failure behavior.

canonical post refresh preserves post identity and advances its source generation
when captured content changes. containing threads compose the updated source;
annotations retain source ownership and frozen evidence retains its words. the
[reader's position owner](reader-implementation.md) resolves exact saved positions
or offers explicit adoption of an unresolved position. article cards own no
canonical text and add no position migration. title-only changes preserve content
identity.
