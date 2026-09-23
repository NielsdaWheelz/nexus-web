# firefox capture v1 · frozen contracts

status: track d working document · 2026-09-23 · temporary; folded into module docs
and deleted before merge. binds [the plan](extension-firefox-v1-plan.md) to exact
names, shapes and file owners so tracks a/b/c can edit in parallel. where this
document and the plan differ, the plan wins and the difference is a defect here.

## 0. shared vocabulary

- **session**: one `media_upload_sessions` row; the one upload lifecycle for pdf,
  epub and article packets. handle grammar `nup1.<22>.<22>` (existing sealed).
- **input origin**: `{kind: "LocalFile"}` | `{kind: "BrowserCapture", source_url,
  sha256}`; stored as strictly decoded jsonb on the session.
- **intent**: the immutable tuple `(kind, filename, content_type, size_bytes,
  library_ids sorted, input_origin)`; compared as `canonical_json_bytes` of that
  dict (existing primitive in `resource_mutation_replay`). any difference under
  the same `(viewer, Idempotency-Key)` is `E_IDEMPOTENCY_CONFLICT`.
- **kind**: lowercase `pdf | epub | web_article`. `web_article` requires a
  `BrowserCapture` origin.
- **packet**: the immutable utf-8 `application/json` object an article capture
  uploads. identity = sha256 of the exact uploaded bytes.

## 1. backend wire (snake_case, `extra="forbid"`, `Presence<T>` for absence)

all responses use the `{data: ...}` envelope. every route below authenticates with
the extension bearer (`get_extension_viewer`); the auth middleware bypasses bearer
verification for exactly `/auth/extension-sessions/current` (GET, DELETE) and every
path under `/extension/`. no other path accepts an extension token.

```text
GET  /auth/extension-sessions/current
  → ExtensionSessionOut
      user_handle:  UserHandle             (nus1.*; seal_user)
      email:        Presence<string>
      display_name: Presence<string>
      limits:
        max_pdf_bytes:             int   (settings.max_pdf_bytes)
        max_epub_bytes:            int   (settings.max_epub_bytes)
        max_article_packet_bytes:  int   (4 * 1024 * 1024)
        max_article_content_bytes: int   (WEB_ARTICLE_HTML_MAX_BYTES = 2 MiB)
        max_article_source_bytes:  int   (64 * 1024)

DELETE /auth/extension-sessions/current → 204 (existing; 401 when already invalid)

GET  /extension/library-destinations?q&cursor&limit
  → { data: LibraryDestinationOut[], page: LibraryPageInfo }   (identical to
    /libraries/writable-destinations; same service call; no create authority)

POST /extension/captures        header Idempotency-Key: canonical lowercase uuid
  body BrowserCaptureIntent (strict):
      kind:         "web_article" | "pdf" | "epub"
      source_url:   str  ≤ 2048, validate_requested_url
      filename:     str  1..255 (normalized like uploads)
      content_type: "application/pdf" | "application/epub+zip" | "application/json"
                    (must agree with kind)
      size_bytes:   int > 0 and ≤ the kind's limit
      sha256:       ^[0-9a-f]{64}$
      library_ids:  list[uuid], distinct, writable non-default
  → UploadRequired | Published | NeedsAttention        (existing models, by_alias)

GET  /extension/captures/{handle}
  → Published                       when published
    NeedsAttention                  verification failed / transport failed /
                                    capability expired (expired ⇒ CapabilityExpired)
    UploadRequired                  otherwise; signed for the current generation's
                                    REMAINING lifetime only (never extended)

POST /extension/captures/{handle}/confirm            body ConfirmUploadSessionRequest
  → Published   (only after atomic publication)
POST /extension/captures/{handle}/retry              body RetryUploadSessionRequest
  → UploadRequired | NeedsAttention
POST /extension/captures/{handle}/transport-failure  body UploadTransportFailureRequest → 204
DELETE /extension/captures/{handle}                  → 204 (unpublished only;
                                                      E_UPLOAD_ALREADY_PUBLISHED otherwise)
```

error codes: existing upload codes unchanged. new/reused for captures:
`E_CAPTURE_TOO_LARGE` (413) when a packet or its parts exceed bounds during
verification (terminal, like `E_FILE_TOO_LARGE`); `E_INVALID_FILE_TYPE` for a
packet that is not the strict object, whose `url` disagrees with the intent's
`source_url`, or whose digest/size disagree; `E_SOURCE_INTEGRITY` for digest/size
disagreement on pdf/epub captures. `_TERMINAL_VERIFICATION_CODES` gains
`E_CAPTURE_TOO_LARGE`; `UPLOAD_VERIFICATION_CODES` in `uploadVerification.ts`
gains the same string.

provenance guard: extension capture operations load the session with
`created_by_user_id == viewer` AND `input_origin.kind == "BrowserCapture"`; the
web upload operations require `LocalFile`. a mismatch is `E_UPLOAD_SESSION_NOT_FOUND`.

`DELETE /extension/captures/{handle}` on a session that no longer exists answers
`E_UPLOAD_SESSION_NOT_FOUND` (404); the client treats it as already gone.
`Idempotency-Key` is one uuid per save by client contract; the server keeps its
existing rule (non-empty, ≤ 255) and does not re-validate the format.

### article packet (uploaded bytes; never sent through the bff)

```json
{
  "url": "https://…",            "base_url": "https://…",
  "title": "…",                   "content_html": "<article>…</article>",
  "source_html": "",              "byline": {"kind":"Absent"},
  "excerpt": {"kind":"Present","value":"…"},
  "site_name": {"kind":"Absent"}, "published_time": {"kind":"Absent"}
}
```

exact key set, no extras. bounds verified server-side on the candidate object:
packet ≤ 4 MiB; `content_html` utf-8 ≤ 2 MiB; `source_html` utf-8 ≤ 64 KiB (empty
allowed); `url` must equal the session's `input_origin.source_url` byte for byte;
`url` and `base_url` pass `validate_requested_url`; `title` ≤ 1024 chars (empty
allowed; publication falls back to `url`); `byline` ≤ 1024, `excerpt` ≤ 4000,
`site_name` ≤ 1024, `published_time` ≤ 128. the server sanitizes independently.

the extension serializes the packet with `JSON.stringify` over an object built in
exactly the key order above and hashes THOSE bytes; the server hashes the object it
verified. no canonicalization on either side.

### session status semantics

`UPLOAD_SESSION_DERIVED_STATE_SQL` is unchanged. `Published` carries
`source_attempt_id`; for a reused media it is the matched media's latest attempt.

## 2. schema (one migration, `0241_browser_capture_sessions`)

- `media_upload_sessions.input_origin jsonb NOT NULL`; backfill every existing
  row to `{"kind":"LocalFile"}` in the same migration.
- `media.browser_capture_sha256 text NULL`; index
  `ix_media_browser_capture (created_by_user_id, kind, browser_capture_sha256)
  WHERE browser_capture_sha256 IS NOT NULL`.
- drop `uq_media_upload_sessions_published_media` and
  `uq_media_upload_sessions_published_source_attempt`; add plain index
  `ix_media_upload_sessions_published_media (published_media_id)`.
- `downgrade()` raises (irreversible; matches 0237–0240 house style).
- no storage calls in alembic. no data conversion in alembic.

`db/models.py`: `MediaUploadSession.input_origin: Mapped[dict[str, object]]`
(JSONB, non-null); `Media.browser_capture_sha256: Mapped[str | None]`.

## 3. storage paths

- staging (existing shape): `uploads/sessions/{session_id}/{generation}/original.{ext}`
  with `ext = {"pdf": "pdf", "epub": "epub", "web_article": "json"}` (a private map
  in `media_upload_sessions.py`; `get_file_extension` stays file-only).
- candidate (existing shape): `media/{candidate_media_id}/candidates/{token}/original.{ext}`
  with a FRESH `new_uuid7()` token per confirmation call. reserve → copy staging →
  verify the candidate → publish that exact path. losing/failed candidates are
  reclaimed by their existing upload-session reservation.
- article packets are published at their candidate path and referenced only by
  the attempt's `source_payload.storage_path`; no `media_file` row.
  `storage.md` owner table gains that row.

## 4. publication transaction (confirm)

1. tx1: lock owned session (origin-checked); published ⇒ `Published(Reused)`;
   generation mismatch ⇒ `E_UPLOAD_GENERATION_STALE`; verification failed ⇒ that
   code; capture out-of-tx facts.
2. no tx: reserve fresh candidate (own short tx), copy staging → candidate,
   measure the CANDIDATE: head size/type, stream sha256 + size + signature
   (pdf/epub) or strict packet decode + bounds + url agreement (web_article);
   `BrowserCapture` origins additionally require `sha256 == input_origin.sha256`.
   any terminal code ⇒ `_record_terminal_verification_failure(session_id,
   generation, code)`, which mutates ONLY an unpublished session whose current
   generation still equals `generation` (fence success and failure alike).
3. tx2 (one transaction, existing lock order: session row → identity lock →
   media → libraries):
   - `lock_identity(f"browser_capture:{viewer}:{kind}:{sha256}")` for
     `BrowserCapture`; re-check published/generation;
   - `BrowserCapture`: deterministic exact match = oldest
     `media(created_by_user_id=viewer, kind, browser_capture_sha256=sha256)` ordered
     by `(created_at, id)`, that `can_read_media(viewer, id)` and has no teardown
     intent; lock it `FOR UPDATE`. no match ⇒ create media (`id=candidate_media_id`,
     `provider="browser_capture"`, `requested_url=source_url`,
     `canonical_source_url=normalize_url_for_display(source_url)`,
     `browser_capture_sha256=sha256`, title = filename for files / packet title or
     url for articles); `LocalFile` ⇒ always create media (existing behaviour).
   - `validate_writable_library_destinations` again, then
     `assign_libraries_for_media_in_current_transaction` (default + selected; no
     duplicates) for BOTH new and reused media.
   - new media only: `MediaFile` (pdf/epub) and one attempt
     (`browser_{kind}_capture` / `browser_article_capture` for BrowserCapture,
     `uploaded_{kind}_file` for LocalFile) with `source_payload` per §5, then
     `mark_source_queued` + `enqueue_accepted_source_attempt_in_transaction`.
   - receipt: `published_media_id`, `published_source_attempt_id` (new attempt, or
     the matched media's latest attempt), `published_at`, `UploadPublished` event.
4. after commit: finalize the candidate reservation (`Retained` when owned; a
   reused-media candidate has no owner and is swept), delete staging best-effort.

`E_UPLOAD_ALREADY_PUBLISHED` on retry/delete means the client reads status.

## 5. source attempt payloads

```text
browser_article_capture:
  storage_path (packet candidate path), content_type "application/json",
  size_bytes, sha256, source_url, library_ids
browser_pdf_capture / browser_epub_capture / uploaded_*_file:
  filename, content_type, size_bytes, source_sha256, storage_path, library_ids
  (+ source_url for browser captures)
```

no writer produces `source_storage_path` any more. `source_attempt_artifacts.py`
keeps `source_attempt_storage_paths`, which reports `storage_path` plus the
legacy source markup (`source_storage_path` until conversion, then the
`retained_legacy_paths` the conversion records) so the orphan sweep and media
deletion keep owning those blobs through the rollback window; it loses
`clone_source_payload_for_new_attempt` (retry clones the payload unchanged:
immutable input references are retained by construction; generated outputs are
attempt-owned rows replaced at publication). `_verify_source_storage` heads
`storage_path` for `browser_article_capture` (unchanged rule).

article adapter: `_run_browser_article_capture` reads the packet, decodes it with
the same strict pydantic model the confirm path used, then
`prepare_web_article_fragment(html=packet.content_html,
embed_source_html=packet.source_html or None, base_url=packet.base_url, …)`.
title/byline/excerpt/site_name/published_time come from the packet at publication
(existing `_persist_capture_metadata` logic, fed from the packet).

## 6. one-shot conversion (`nexus convert-browser-article-captures`)

a `nexus.cli` subcommand, run once per environment after the migration and before
new captures are enabled. for every attempt with `source_type =
'browser_article_capture'` whose payload has no `sha256`: read `storage_path`
(content html) and `source_storage_path` (full source html) from storage —
missing object ⇒ stop with the media/attempt id and change nothing; project the
source html to bounded evidence (iframe `src`/`title`; `blockquote.twitter-tweet`
text and `a[href]`) ≤ 64 KiB; build the packet from the payload's url/title/
byline/excerpt/site_name/published_time; write it to
`media/{media_id}/source/{attempt_id}.json`; verify by re-reading and decoding;
then in one transaction rewrite `source_payload` to the §5 shape, moving the
original blob paths into `retained_legacy_paths`, and set
`media.browser_capture_sha256` to the packet digest. original blobs stay owned
through the rollback window; the ticket
`remove-browser-capture-conversion-command` closes the window with one
statement after which the existing orphan sweep reclaims them. idempotent:
converted attempts are skipped. the command is removed after its verified
production run.

## 7. bff (all through `proxyExtensionToFastAPI`; explicit route files)

```text
apps/web/src/app/api/extension/session/route.ts                GET, DELETE → /auth/extension-sessions/current
apps/web/src/app/api/extension/library-destinations/route.ts   GET         → /extension/library-destinations
apps/web/src/app/api/extension/captures/route.ts               POST        → /extension/captures
apps/web/src/app/api/extension/captures/[handle]/route.ts      GET, DELETE → /extension/captures/{handle}
apps/web/src/app/api/extension/captures/[handle]/confirm/route.ts            POST
apps/web/src/app/api/extension/captures/[handle]/retry/route.ts              POST
apps/web/src/app/api/extension/captures/[handle]/transport-failure/route.ts  POST
```

`[...path]/route.ts` denies first segment `extension`. `proxyExtensionToFastAPI`
loses `forwardHeaders`/`defaultContentType` options (json only) and forwards
`content-type`, `accept`, `idempotency-key`. old `api/media/capture/**` routes
are deleted. `extension/connect/start` accepts an optional `state` query value
(≤ 128 chars, `[A-Za-z0-9_-]`) and echoes it in the redirect hash next to `token`
or `error`.

## 8. extension runtime contract (`apps/web/src/extension/captureContract.ts`, owner b; consumed by c)

```ts
import type {
  LibraryDestinationPage,
  LibraryDestinationSelection,
} from "@/lib/libraries/destinationContract";

export type CaptureTargetView =
  | {
      kind: "article";
      /** article title; never empty (falls back to the url) */
      title: string;
      /** hostname only; signed query parameters are never displayed */
      host: string;
      /** bounded inert plain text (≤ 1200 chars) for the optional preview */
      previewText: string;
    }
  | {
      kind: "document";
      /** link label or filename; never empty */
      title: string;
      host: string;
      /** "unknown" until the bounded get classified the bytes */
      documentKind: "unknown" | "pdf" | "epub";
    };

export interface CaptureAccount { userHandle: string; email: string | null; displayName: string | null }

export interface CaptureFailure { code: string; message: string; requestId: string | null }

export type CapturePhase =
  | { kind: "draft" }
  | { kind: "acquiring" }
  | { kind: "prepared" }
  | { kind: "transferring" }
  | { kind: "confirming" }
  | { kind: "saved"; mediaId: string; openUrl: string; reused: boolean }
  | { kind: "failed"; failure: CaptureFailure; retryable: boolean };

export interface CaptureDraftView {
  id: string;
  target: CaptureTargetView;
  phase: CapturePhase;
  /** selected additional libraries; empty is valid */
  destinations: readonly LibraryDestinationSelection[];
  /** true after browser restart: the popup shows explicit "resume" before any network work */
  resumable: boolean;
}

export type CaptureConnection =
  | { kind: "signed_out" }
  | { kind: "connected"; account: CaptureAccount }
  | { kind: "revocation_failed"; failure: CaptureFailure };

export type CaptureViewState = {
  connection: CaptureConnection;
  /** match patterns the popup must request before "login" or "save" (nexus,
      storage, and the target origin when the background downloads a document);
      already-granted origins are omitted */
  requiredOrigins: readonly string[];
  view:
    | { kind: "empty" }                                   // no draft, nothing pinned
    | { kind: "unsupported"; reason: string }             // internal scheme, no tab, …
    | { kind: "draft"; draft: CaptureDraftView };
};

/** popup → background. every command answers `CommandResult`. */
export type CaptureCommand =
  | { kind: "activate" }                       // popup opened by toolbar: pin active tab if no draft is active
  | { kind: "resume" }                         // explicit resume of a restart-recovered draft
  | { kind: "set_destinations"; destinations: readonly LibraryDestinationSelection[] }
  | { kind: "search_destinations"; q: string; cursor: string | null }
  | { kind: "login" }                          // hosted login; background refocuses window and reopens the popup
  | { kind: "save" }                           // popup has already requested `requiredOrigins`
  | { kind: "retry" }                          // same operation key; no new identity
  | { kind: "discard" }
  | { kind: "disconnect" };                    // confirmed revocation only forgets the credential

export type CommandResult =
  | { kind: "state"; state: CaptureViewState }
  | { kind: "page"; state: CaptureViewState; page: LibraryDestinationPage }   // search_destinations only
  | { kind: "failure"; failure: CaptureFailure; state: CaptureViewState };

/** background → popup push over `runtime.connect({ name: "nexus-capture-view" })` */
export type CaptureViewMessage = { kind: "state"; state: CaptureViewState };
```

commands go through `browser.runtime.sendMessage(command)`; the background validates
the sender is this extension's popup (`sender.id === browser.runtime.id`, no `tab`).
content scripts speak only the internal acquisition protocol defined in
`content.ts`/`background.ts` and never receive the credential or arbitrary fetch.
the destination page crossing the popup boundary is the already-decoded
`LibraryDestinationPage` (one shape, one decoder, in the background).

the port is the popup's SOLE source of `CaptureViewState`: the background posts
`{kind: "state"}` immediately on every connect and after every state change, in
order, from one owner. `CommandResult.state` is informational; the popup applies
only `page` and `failure` from replies, because firefox does not order a
`sendMessage` reply against port messages.

popup permission rule (c): in the `login` and `save` click handlers the popup
first sends the command (`browser.runtime.sendMessage`, not awaited), then
synchronously (before any `await`) calls
`browser.permissions.request({ origins: state.requiredOrigins })` when the list
is non-empty. the grant is observed by the BACKGROUND: when a command needs
origins that `permissions.contains` does not yet report, it waits for
`permissions.onAdded` to cover them and then continues; if the popup dies
meanwhile (firefox may close the panel when the doorhanger takes focus; observed
on 2026-09-23) the work still proceeds. a denial fires no event: the draft stays
in its phase with `requiredOrigins` still listed, and the popup's `false` result
renders the denied notice. no timers. the background needs the nexus host
permission for every api call after `identity.launchWebAuthFlow` (mv2
cross-origin fetch), which is why login is covered too.

escape (fact, 2026-09-23, firefox 156): a native escape closes a browser-action
popup at the chrome level before any key event reaches the popup document, so
the popup owns no escape handling; closing the popup keeps the draft in the
background and reopening restores it. the chooser closes through its trigger.

## 9. build and configuration (owner c)

- `apps/web/scripts/build-extension.mjs`: clears `apps/extension/dist`, runs three
  vite builds from `apps/web/vite.extension.config.ts` (popup: module app rooted at
  `src/extension/popup.html`; background and content: self-contained iife bundles),
  copies `apps/extension/manifest.json` + `icons/`, injects exact nexus/storage
  origin patterns into `optional_permissions`, validates every manifest reference
  exists in `dist`, validates `version` and origin syntax, fails otherwise.
- env (documented in `.env.example`, defaults for local):
  `NEXUS_EXTENSION_NEXUS_ORIGIN=http://localhost:3000`,
  `NEXUS_EXTENSION_STORAGE_ORIGIN=http://127.0.0.1:9000`. vite `define`s
  `__NEXUS_ORIGIN__` and `__NEXUS_STORAGE_ORIGIN__` (json strings) for the bundles;
  match patterns drop the port (`http://localhost/*`).
- readability resolves from `node/ingest/node_modules/@mozilla/readability` and
  `node/ingest/article_extraction.mjs` via vite aliases (`@nexus-ingest/*`); a
  local `articleExtraction.d.ts` declares the mjs export.
- `./scripts/test` gains, inside the `apps/web` block after typecheck:
  `bun run build:extension`; `check-css-tokens.mjs` also closes over
  `apps/extension/dist/assets/*.css`. `apps/extension/dist/` is git-ignored.
- `apps/web/package.json` scripts: `build:extension`. devDependencies:
  `@types/firefox-webext-browser`.
- `tsconfig.json` `include` already covers `src/extension/**`; `lib` adds nothing.
- browser api surface missing from `@types/firefox-webext-browser` (the 153 additions
  such as `scripting` `documentIds`) is declared once in
  `apps/web/src/extension/firefoxApi.d.ts` (owner b; a definition file, so the
  eslint `no-namespace` rule is not relaxed); c adds the matching
  `!apps/web/src/extension/firefoxApi.d.ts` exception to `.gitignore`. no
  `declare global { namespace … }` augmentation inside `.ts` sources.
- byte buffers handed to `Blob`/`fetch` are typed `ArrayBuffer` (allocate
  `new Uint8Array(n)` over a fresh `ArrayBuffer`, or slice with an explicit
  `ArrayBuffer` type), never `Uint8Array<ArrayBufferLike>`.

## 10. file ownership (exclusive; ask before crossing)

| track | files |
| --- | --- |
| a | `python/**` (schemas, routes, auth, services, storage/paths, db/models, cli), `migrations/**`, `apps/web/src/app/api/extension/**`, `apps/web/src/app/api/[...path]/route.ts`, `apps/web/src/app/api/media/capture/**` (delete), `apps/web/src/lib/api/proxy.ts`, `apps/web/src/app/extension/connect/start/route.ts`, `apps/web/src/lib/media/uploadVerification.ts` (code list), `docs/modules/{storage,web-article,sharing}.md` |
| b | `apps/web/src/extension/{background.ts,content.ts,captureContract.ts,captureStore.ts,captureClient.ts,articleExtraction.d.ts}`, `apps/extension/manifest.json`, `node/ingest/article_extraction.mjs` (only if a browser-safety fix is required), `apps/extension/README.md`? no: module doc lives in `docs/modules/extension.md` (b writes runtime sections, c writes ui/build sections) |
| c | `apps/web/src/extension/{popup.tsx,popup.html,popup.module.css}`, `apps/web/src/components/libraries/{LibraryDestinationTrigger.tsx,LibraryDestinationField.tsx,LibraryDestinationPicker.tsx}` + css, `apps/web/src/lib/libraries/destinationContract.ts`, `apps/web/src/lib/libraries/client.ts`, `apps/web/src/lib/media/uploadSessionContract.ts`, `apps/web/src/lib/media/ingestionClient.ts`, `apps/web/vite.extension.config.ts`, `apps/web/scripts/{build-extension.mjs,check-css-tokens.mjs}`, `apps/web/package.json`, `apps/web/bun.lock`, `apps/web/eslint.config.mjs`, `.env.example`, `.github/workflows/ci.yml`, `scripts/test`, `.gitignore`, delete `apps/extension/{popup.js,popup.html,popup.css,content.js,vendor/}` |
| d | this file, `docs/extension-firefox-v1-plan.md`, tickets, harness under `tools/firefox-harness/` (temporary), evidence |

phase 0 (before a/b/c): c's extractions land first so b compiles against them:
`lib/media/uploadSessionContract.ts` exports `UploadResponse`, `UploadCapability`,
`UploadFailure`, `PublishedUpload`, `decodeUploadResponse(raw: unknown): UploadResponse`
(the current private `uploadResponse` decoder, envelope included) and
`UPLOAD_IDEMPOTENCY_OUTCOMES`; `lib/libraries/destinationContract.ts` exports
`LibraryDestination`, `LibraryDestinationSelection`, `LibraryDestinationPage`,
`decodeWritableLibraryDestinationPage`, `decodeLibraryDestinationSelection`,
`LibraryDestinationContractDefect` and imports only `@/lib/validation`;
`isLibraryDestinationDefect` stays in `client.ts` (it references the web api
client). `captureContract.ts` contains §8 verbatim; track b appends the runtime
decoders and builders below it (the phase-0 test checks containment).
