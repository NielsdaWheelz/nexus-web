# Firefox Capture Extension

One Firefox (≥ 153, manifest v2) extension saves the current article, or a
right-clicked PDF/EPUB link, into the viewer's own Nexus through the upload
lifecycle the web app already uses. Contract: `docs/extension-firefox-v1-plan.md`.
Sources: `apps/web/src/extension/`, manifest `apps/extension/manifest.json`,
build `apps/web/scripts/build-extension.mjs` → `apps/extension/dist`.

## runtime owners

| file | owns |
| --- | --- |
| `background.ts` | the persistent background page: the one active capture, target pinning, acquisition, the credential, the upload lifecycle, restart recovery, view-state pushes and command answers |
| `content.ts` | the script injected per operation into a pinned document: article extraction and projection, context-menu target binding, same-origin download in the page principal |
| `captureContract.ts` | the popup/background contract (view state, commands, the two port names; `requiredOrigins` lives on the state so login can ask before any draft exists), the article packet and its serialization, the intent body, the session decoder, the shared pdf/epub classifier |
| `captureClient.ts` | the nexus API adapter over the build's pinned nexus origin (`/api/extension/...`) with the bearer, and the storage PUT that never carries it |
| `captureStore.ts` | IndexedDB `nexus-capture-v1` (one draft record + its bytes) and the `storage.local` credential; an article target keeps only its window and url (it is read once, at pinning), a document target the document its link was clicked in |
| `articleExtraction.d.ts` | ambient declarations: the `@nexus-ingest/article_extraction` alias and the Firefox 153 `documentId` surface the type package lacks |
| `popup.tsx`, `popup.html`, `popup.module.css` | presentation only; see [ui and build](#ui-and-build) |

The extractor itself is `node/ingest/article_extraction.mjs`, bundled into
`content.js` through the vite alias so browser and server select the same
readable document.

## target pinning

Everything starts by pinning a target to a native document identity
(`documentId`, Firefox 153), never to a tab or url:

- **toolbar**: the popup sends `activate`; the background reads the active tab
  of the last-focused window (host access comes from `activeTab`, granted by the
  click). An internal scheme is `unsupported`. An http(s) tab is injected at
  once and the article is extracted from a clone of the live DOM; the packet
  bytes are stored with the draft, so the page is never read again. The view
  shows the title, or the host when the page has none: a url may carry signed
  access parameters, which are retained as data and never displayed (nexus
  titles an untitled article by its host likewise). An http(s)
  tab Firefox refuses to inject (the PDF viewer, privileged pages) becomes a
  `document` target with source `extension`.
- **"Add link to Nexus…"** (link context, http(s) targets): the click grants
  `activeTab`, Firefox reports `linkUrl`/`targetElementId`, the background
  injects into the clicked frame and asks it to resolve the element via
  `menus.getTargetElement`; the injection's port carries the frame's
  `documentId`, which the draft retains together with whether the link is
  same-origin with its document. The window is focused and the popup opened
  (`browserAction.openPopup`, gesture-free since Firefox 149 but only in a
  focused window). A same-url reload gets a new `documentId`, so a later
  download into the old one fails instead of reading a replacement page.

One draft at a time: a toolbar or menu activation while a draft is unsettled,
or while any command runs, resumes that draft; pinning never pre-empts running
work. A `saved` receipt stays until it is discarded or the popup is opened on
a different http(s) page: that page is pinned in its place, or, when it cannot
be (unreadable, too large, a vanished link), the receipt makes way for the
reason. An internal-scheme tab leaves the receipt alone.

## acquisition contexts

Selected once at pinning and never switched:

| target | context | credentials |
| --- | --- | --- |
| article | cloned live DOM in the page | none leave the browser |
| same-origin link from a page | `content.fetch` inside the pinned document (page principal) | the page's own cookies |
| cross-origin link, or `extension` source | background `fetch` with the granted origin permission | the extension principal's cookies for that origin |

The download is one bounded streamed GET (`readDocumentResponse`): the kind is
classified from the bytes (`%PDF-`, or the OCF-mandated `mimetype` first zip
entry), reading stops at that kind's account limit, html or anything else is a
modeled `E_INVALID_FILE_TYPE`, and the filename comes from
`content-disposition`, then the final url path, then `document.<kind>`. The
page hands the bytes over as a Blob by structured clone and keeps its reference
until the background acknowledges the IndexedDB commit.

## projection

`content.ts` projects the extracted html before it leaves the browser:
scripts, styles, templates, forms and every control, elements with `hidden`,
and embeds the server drops are removed with their content; every attribute
goes except the ones the server consumes — `sanitize_html`'s allowlist (a:
href/title; img: src/alt; th/td: colspan/rowspan), `id`, `class`, `role`,
`epub:type`, `rid`, `ref-type` for `html_apparatus`, `name` on `a`, and iframe
`src`/`title`. `href`/`src` resolve against `document.baseURI`; `#id` links stay
verbatim for the apparatus graph; `javascript:`/`data:`-class schemes are
dropped. `source_html` is rebuilt evidence from the whole document, in order:
`<iframe src title>` and `<blockquote class="twitter-tweet">text<a href></blockquote>`,
whole elements only, ≤ 64 KiB. Metadata is bounded to the server's limits.

## the packet and the intent

The article packet is serialized once, in the frozen key order, and hashed
(`sha256Hex`) over those bytes; files are hashed over their downloaded bytes.
`save` freezes the intent — bytes, one operation key (the `Idempotency-Key` of
every create replay), destinations, account — and persists phase `prepared`
before the first capture mutation. After that, destinations cannot change and
every retry reuses the same key and bytes.

## storage

IndexedDB `nexus-capture-v1`, one store, key `draft` (target, view, phase,
destinations, account, intent, upload session handle and generation) and key
`bytes` (the Blob). Bytes are written once at acquisition; phase transitions
rewrite only the small record. Every write resolves after its transaction
commits; `QuotaExceededError` is `E_CAPTURE_STORAGE_QUOTA` and blocks save.
Publication clears the bytes and keeps the receipt. The session generation is
always one nexus named (an `UploadRequired`, or the current one a retry
conflict reported), never inferred. The credential `{token}` lives in
`storage.local["nexusCaptureCredential"]`; the nexus it belongs to is the
build's pinned origin, and any other stored shape is a decoding defect at
startup, not absence.

## auth

`login` runs `identity.launchWebAuthFlow` against the build's nexus origin,
`/extension/connect/start?redirect_uri=<identity.getRedirectURL()>&state=<uuid>`;
the reply's hash must echo the state. The token is stored, then
`GET /api/extension/session` supplies the account and byte limits; the first
successful lookup binds an unbound draft to that account and only that account
may resume it. Once the auth window has run, whatever its outcome, the
background refocuses the window and reopens the popup. The popup sends
`login`, `save`, `retry`, `resume`, `disconnect` or the `discard` of anything
but an unsubmitted draft and then, in the same click handler, requests
`requiredOrigins` (nexus, storage, and the target origin while the background
still has to download; frozen bytes need no publisher); the background waits
for the grant before the command's first mutation or nexus call (see
[messages](#messages)).
`disconnect` sends `DELETE /api/extension/session`
and forgets the credential on 204, or on 401 (nexus no longer honours it);
any other answer keeps the credential and shows `revocation_failed` with a
retry. A 401 on any capture call forgets the credential likewise; inside
`save`, `retry` or `resume` it is answered as the command's failure, never
recorded as the draft's, because every nexus call there follows the freeze and
nexus judged nothing. Whenever the credential leaves, a frozen unsaved draft
becomes `resumable` (see [recovery](#recovery)). A held
credential is confirmed, never replaced: when the identity read on popup
open could not be reached, the popup shows signed out, and `login` then
repeats that read instead of minting a second token, so no token nexus still
honours is ever orphaned.

## messages

- popup → background: `CaptureCommand` over `runtime.sendMessage`; the
  background accepts only senders with this extension's id and no tab, decodes
  the command strictly, and answers `CommandResult`.
- background → popup: `{kind: "state", state}` pushed on every change over the
  `nexus-capture-view` port; the popup renders nothing else.
- background ↔ content: `ContentRequest`/`ContentReply` on the
  `nexus-capture-content` port an injection opens. The background accepts the
  port only from the sender it injected into (tab and frame, or the pinned
  `documentId`) and serves one request on it; the content script never sees the
  credential.

Long commands (`save`, `retry`, `resume`, `login`, pinning) are exclusive; a
second one is `E_CAPTURE_BUSY`, except that `activate` and the menu click pin
nothing while one runs, without complaint. `discard` and `disconnect` abort the running
one first and record that nothing runs for the draft any more (see
[recovery](#recovery)), so a discard whose delete fails, or a disconnect,
leaves a resumable draft rather than a phase nobody is working on.

`login`, `save`, `retry`, `resume`, `disconnect` and the `discard` of a frozen
draft run their guards, then wait until `permissions.contains` reports every
required origin before their first mutation or nexus call: the popup asks for
the origins right after sending the command, and
the grant reaches the background as `permissions.onAdded`, whether or not the
popup outlived the doorhanger (Firefox may close the panel when it takes
focus). A denial fires nothing: the phase is unchanged, `requiredOrigins`
stays listed so a reopened popup asks again, and only the popup's `false`
result shows a notice. The background subscribes to `permissions.onAdded`
before it checks `permissions.contains`, so a grant between the two is never
missed. While a command waits, a repeated `login`, `save`, `retry` or `resume`
takes the wait over instead of being busy (pinning never does); `discard` and
`disconnect` abort it, then wait for their own grant. No timers.

## transfer

`POST /captures` with the intent and key, then per answer: `Published` ⇒
`saved`, a receipt naming the media only (`idempotency_outcome` reports a
replayed answer, not a content match, so the popup says "Saved." and never
claims the item was already there); `NeedsAttention` ⇒
`failed` (retryable unless verification failed); `UploadRequired` ⇒ persist the
session, PUT the exact bytes with only `required_headers`, bounded by
`expires_at` and without any nexus credential, report a transport failure
typed as the server's union, then `POST …/confirm`. `E_UPLOAD_ALREADY_PUBLISHED`
reads status and accepts its receipt.

`retry` is the same operation: with nothing frozen it re-acquires; a frozen
draft continues from nexus's view of it, exactly as `resume` does. Without a
session it replays the create with the same key (nexus answers by the
session's current state and advances a dead generation itself). With one it
reads status first: `Published` is accepted; a live `UploadRequired` is
confirmed first, and the bytes are PUT only when nexus answers
`E_STORAGE_MISSING`; a `NeedsAttention` that can retry is advanced once by
`POST …/retry` with a fresh `client_mutation_id` and `expected_generation` =
the generation last seen, then PUT and confirmed. `E_RESOURCE_CONFLICT` on
that advance names the generation nexus holds (an admitted retry whose answer
was lost): the draft adopts it and reports a retryable failure, so the next
press fences on the truth. Because every continuation reads status first, no
request is ever replayed and no mutation id is remembered.

## recovery

On startup the background reads the draft and never touches the network. The
same normalization runs whenever `discard` or `disconnect` aborts the running
command: an interrupted `acquiring` phase returns to `draft` (nothing was
frozen), and a draft with a frozen intent becomes `resumable`; the popup shows
explicit **Resume**, which is the continuation described under
[transfer](#transfer). Until then no capture mutation happens; the identity
read on popup connect is the only network call.

`discard` clears an unsubmitted draft locally; a frozen draft first resolves an
uncertain create (same key), then deletes the unpublished session; a session
that turns out published is reported `saved`, never cancelled. A create nexus
refuses for good (a terminal code: a destination lost, the intent no longer
accepted) names nothing this client can delete, so discard releases the slot;
any other refusal keeps the draft for another attempt. Discarding a
frozen draft needs the bound account's connection, so the popup offers Discard
for a resumable draft only while connected, and whenever the credential leaves
(a confirmed revocation, or a 401 anywhere) a frozen unsaved draft is
normalized the same way and becomes `resumable`: nothing can run for it until
its account signs in again. `resume` runs every guard before
it clears `resumable`, so a refused resume (signed out, another account)
leaves the draft resumable.

Failures retain the target; after `prepared` they retain the exact bytes and
key. Terminal codes (invalid type, too large, integrity, conflict, forbidden,
page gone, account mismatch) offer discard only; everything else offers retry.

## ui and build

**The popup renders only what the background pushes.** The
`nexus-capture-view` port is its sole source of view state (Firefox does not
order a `sendMessage` reply against port messages); command replies are read
only for a destination page or a failure. Every inbound message is decoded
strictly; a contract violation is a visible `E_CAPTURE_POPUP` failure, never a
guess. The popup owns the open chooser, its search and the notice of its last
command, nothing else. `resumable` outranks the phase: a frozen draft after a
restart shows **Resume** even when its phase is `failed` (the background
accepts only `resume` for it), with no Retry, and with Discard beside it only
while connected: a frozen draft is discarded through nexus by its bound
account, so signed out the popup offers the sign-in and no Discard.

**Permissions.** Firefox grants optional origins only inside the user-input
handler, and its doorhanger may close the popup, so the login, save, retry,
resume and disconnect handlers send their command first and then call
`browser.permissions.request({origins: requiredOrigins})`, synchronously, in
the same handler; the popup's result does not gate the command, which the
background continues on `permissions.onAdded`. Discard does the same unless
the phase is `draft` or `acquiring`, which the background clears locally; a
failed draft may be frozen and the view does not say, so it asks, and the one
spare prompt is a failed acquisition discarded after a manual revocation. A
`false` result shows which hosts were refused and that the draft is kept; a
rejected request is shown as a failure.

**The destination chooser** is inline: the shared `LibraryDestinationTrigger`
disclosing a region that holds the shared `LibraryChooser` with `create={null}`
(the popup never creates libraries). Opening moves focus into the search box;
the chooser closes through its trigger, which keeps focus. The popup owns no
Escape handling: Firefox closes a browser-action popup on Escape at the chrome
level, before any key event reaches the document (fact, Firefox 156). A
chooser that loses its enablement closes and never reopens unasked. The search
state (one request generation over open, typing, retry and Load More; a
180 ms pause for typed queries; the query trimmed and lowercased) is
`components/libraries/useLibraryDestinationSearch.ts`, shared with the web
`LibraryDestinationPicker`; the popup's transport is the `search_destinations`
command. Toggles send the whole next selection as `set_destinations` and are
serialized on the next pushed selection. Destinations freeze once saving
starts.

**CSS closure.** The popup loads `src/app/globals.css` (the token owner), then
`src/app/packagedFonts.css` (the next/font families as system stacks; both
packaged entries, the popup and the offline shelf, import it), then component
modules, then `popup.module.css`, which
owns only the popup's geometry; `popup.html` pins `data-theme="dark"`. The page
CSP is `default-src 'none'` with self scripts and styles: the popup never
fetches, and the build drops vite's modulepreload polyfill.
`check-css-tokens.mjs` closes over `apps/extension/dist/assets/*.css` as it
does over the shelf.

**Build.** `bun run build:extension` (`apps/web/scripts/build-extension.mjs`)
clears `apps/extension/dist` (git-ignored) and runs
`apps/web/vite.extension.config.ts` in three modes: `popup` (module page rooted
at `src/extension/popup.html`), `background` and `content` (self-contained
iife classic scripts). Aliases: `@` → `apps/web/src`,
`@nexus-ingest/article_extraction` → `node/ingest/article_extraction.mjs`,
`@mozilla/readability` → node/ingest's copy. `NEXUS_EXTENSION_NEXUS_ORIGIN`
(default `http://localhost:3000`) and `NEXUS_EXTENSION_STORAGE_ORIGIN` (default
`http://127.0.0.1:9000`) must be bare http(s) origins; they are baked in as
`__NEXUS_ORIGIN__`/`__NEXUS_STORAGE_ORIGIN__` and injected into the manifest's
`optional_permissions` as port-less match patterns. The script then copies the
source manifest and icons, requires a `MAJOR.MINOR.PATCH` version, and fails on
any manifest reference the build did not produce. Firefox API types come from
`@types/firefox-webext-browser`, with the 153 additions declared in
`articleExtraction.d.ts`.

The hosted login accepts only redirect origins listed in
`NEXUS_EXTENSION_REDIRECT_ORIGINS`: the origin of
`browser.identity.getRedirectURL()`, `https://<sha-1 hex of the gecko
id>.extensions.allizom.org`.

**Gate.** `./scripts/test` runs `bun run build:extension` in the `apps/web`
block before `lint:css-tokens`, `lint` and `typecheck`, so the package, its
CSS closure and its types are checked on every run; CI installs
`node/ingest`'s dependencies so the aliases resolve.

## verification (2026-09-23)

the sole automated gate stays `./scripts/test` (extension build, lint, both
typecheck programs). the cutover was qualified with a temporary geckodriver
harness that operated the installed extension's real toolbar button, popup,
context menu and hosted login against real local services (postgres, minio
behind a delaying proxy, supabase auth, next dev, fastapi, a linux background
worker container) and a fixture origin; the harness was deleted after the runs.
observed:

- toolbar capture while signed out pinned the article, survived hosted login
  and a tab navigation, and published one web_article with its digest and
  canonical url; the background reopened the popup on the same draft.
- two additional libraries chosen by keyboard alone; the packet carried both
  prose sentinels, the resolved relative link, footnote ids and refs, and
  youtube/twitter evidence, and none of the page's script, account, form,
  hidden or `data-*` state; the background lane extracted a fragment with the
  sentinels, the footnote apparatus and both embeds.
- right-click epub and direct, extensionless and signed-query pdf links
  published with byte-identical digests; three identical saves produced one
  media and three receipts; the signed query stayed source data and was never
  displayed.
- refusals without media or a second acquisition: denied origin prompt (draft
  kept), html served for a pdf link, a chunked stream past the pdf limit, a
  cross-origin redirect in page context, a destination deleted after selection.
- a transfer delayed by 8 s completed with the popup closed; quitting firefox
  mid-transfer and relaunching on the same profile offered an explicit resume
  that finished the same operation; discarding a draft freed the slot.
- disconnect with the api down reported the failure and kept the credential;
  retry after the api returned signed out.
- migration 0241 and the one-shot conversion rehearsed on a fresh database with
  pre-cutover rows: backfill, dropped uniques, credential revocation, a verified
  packet with the legacy blobs retained, idempotent second run.

limits: a real subscribed page was not captured in this session; the fixture
article stands in for one. firefox owns escape in a browser-action popup (a
native escape closes the panel before content sees it), and the permission
doorhanger can close the popup, which is why grants are observed by the
background. the mac cannot run the background worker lane; extraction evidence
came from the linux container.
