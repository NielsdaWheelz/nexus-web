# codebase cleanup hard cutover

this document defines the implementation target for the current repo-wide
cleanup pass.

it supersedes the previous narrower cleanup note and reflects the current tree.

it is a hard cutover plan. do not preserve legacy behavior, duplicate code
paths, backward-compatibility shims, deprecated routes, deprecated request
shapes, deprecated response shapes, transition wrappers, test-only production
seams, or migration-era docs and tests.

## standards

this cleanup aligns the codebase to:

- `docs/rules/simplicity.md`
- `docs/rules/control-flow.md`
- `docs/rules/codebase.md`
- `docs/rules/module-apis.md`
- `docs/rules/layers.md`
- `docs/rules/errors.md`
- `docs/rules/conventions.md`
- `docs/rules/function-parameters.md`
- `docs/rules/testing_standards.md`

for the frontend test architecture cutover that follows from these standards,
see `docs/frontend-test-cutover.md`.

for the text highlight architecture cutover that follows from these standards,
see `docs/text-highlights-cutover.md`.

## goals

- collapse each capability onto one canonical production path
- make ownership obvious from file structure, module boundaries, and control
  flow
- collapse duplicated search, library-target, membership, and proxy flows onto
  one clear owner
- delete dead code, dead tests, dead exports, dead styles, dead seams, and
  stale docs
- cut up god files and god functions only when the split clearly reduces
  cognitive load
- optimize for maintainer comprehension, not for reuse theater or speculative
  extensibility
- keep implementation local and explicit instead of reusable-looking
  indirection
- remove wrapper pages, runtime fallbacks, and alternate navigation paths that
  preserve a second way to do the same thing
- reduce branching, fallback behavior, and transport normalization passes
- fail fast on unsupported inputs instead of silently translating them
- keep route handlers transport-only and services business-only
- make tests prove user-visible behavior instead of import topology, mocked
  child wiring, source layout, proxy path strings, or private helper calls

## non-goals

- feature additions
- product redesign
- preserving old routes, old query params, old payloads, old schema bridges, or
  old storage semantics for compatibility
- partial migration plans, gradual rollout paths, flags, or fallback modes
- introducing new generic frameworks, registries, adapters, builders, helper
  layers, manifests, or DSLs to hide cleanup work
- extracting every duplicated line into a shared helper
- reorganizing code when the new structure is not materially easier to follow
- broad architectural rewrites outside the concrete hotspots in this document

## hard cutover rules

- remove deprecated routes instead of forwarding them
- remove deprecated request and response shapes instead of translating them
- remove legacy schema/runtime bridges instead of keeping old and new models in
  parallel
- remove one-use helpers, one-use constants, one-use types, and one-use object
  shapes unless they hide substantial incidental complexity
- if a branch exists only to support old callers, remove it
- if a helper exists only because a previous abstraction existed, inline it or
  delete it
- do not add new generic cleanup infrastructure
- do not add feature flags or environment-dependent production branches to make
  cleanup easier to ship
- route handlers normalize transport payloads once and then pass typed service
  inputs
- services do not accept raw transport dicts, route payload fragments, or
  nullable bridge state when the inputs can be classified at the boundary
- do not preserve a second runtime path through wrapper pages, root-navigation
  fallbacks, or compatibility route layers when one authenticated pane runtime
  already owns the product
- module boundaries are real: sibling packages do not import each other's
  underscore helpers
- the only allowed abstraction is one with obvious payoff: real reuse, real
  complexity reduction, or real safety
- collapse copy-pasted BFF proxy handlers to one explicit implementation path
  when they differ only by endpoint and a small header set
- tests that assert mocked child props, import topology, source text, private
  exports, or migration-era route strings should be deleted or rewritten
- if a final module still needs a long comment to explain ownership, the
  ownership is still too indirect

## target behavior

- each supported user flow runs through one explicit production path
- unsupported old inputs and routes fail fast or disappear instead of being
  silently translated
- the media route is easy to follow from `MediaPaneBody.tsx`, while real
  transcript, epub, highlight, and reader behavior lives with the owning leaf
  modules
- pdf, epub, transcript, and highlight behavior do not rely on hidden helper
  bags or test seams
- the authenticated app runs through one pane/workspace runtime path only;
  wrapper pages and root-navigation fallbacks do not preserve a second path
- workspace navigation uses one href normalizer and one route matcher
- workspace titles are derived simply and explicitly; the code does not maintain
  a second title system to hide routing or loading details
- search ui and command palette use one canonical request, normalization, and
  view-model path
- library-target selection and library-membership mutation flows use one
  canonical frontend path
- global player state owns normalized track, chapter, queue, and playback state;
  the footer renders it instead of re-deriving it
- podcast list and detail panes do not duplicate transport types, sync flows,
  settings flows, or library-membership mutation logic
- extension capture and extension-session routes use one explicit proxy pattern
  instead of several copy-pasted handlers
- transcript capability and readiness derive from `media_transcript_states`
  only
- highlight create, read, update, delete, search, and export use one canonical
  typed anchor model only
- conversation send paths accept typed context inputs end-to-end; raw dict
  bridges do not leak through services and schemas
- backend search and context rendering do not pass raw dict rows or raw dict
  context bags through service boundaries
- podcast backend modules have real public APIs and do not behave like one
  monolith split across files
- tests are concentrated in higher-confidence layers, share harnesses only where
  the sharing removes mechanical repetition, and fail only on meaningful
  behavioral regressions
- docs describe the current tree only

## final state

- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx` remains the
  only media-route controller, but it no longer owns transcript forecasting,
  transcript polling internals, epub restore internals, highlight mutation
  helpers, and pane-specific behavior that belongs to leaf owners
- `apps/web/src/app/(authenticated)/media/[id]/EpubContentPane.tsx`,
  `TranscriptContentPanel.tsx`, `TranscriptPlaybackPanel.tsx`,
  `TranscriptStatePanel.tsx`, and `MediaHighlightsPaneBody.tsx` directly own
  their runtime behavior instead of receiving large prop bags from a central
  god file
- `apps/web/src/components/PdfReader.tsx` exposes only production API surface
  and keeps only pdf-specific runtime behavior
- `apps/web/src/app/(authenticated)/layout.tsx` and
  `apps/web/src/components/workspace/WorkspaceHost.tsx` are the only
  authenticated pane runtime owners; wrapper pages and root-navigation fallback
  branches do not preserve an alternate navigation stack
- `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx` and
  `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
  do not duplicate subscription sync/settings transport types or mutation
  flows
- `apps/web/src/app/(authenticated)/search/SearchPaneBody.tsx` and
  `apps/web/src/components/CommandPalette.tsx` use one canonical search fetch,
  normalize, and adapt path
- `apps/web/src/app/(authenticated)/browse/BrowsePaneBody.tsx`,
  `apps/web/src/components/AddContentTray.tsx`,
  `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`,
  `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`,
  and `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
  do not duplicate library-target loading or membership mutation logic
- `apps/web/src/lib/player/globalPlayer.tsx` is the only owner of track/chapter
  normalization and queue progression semantics
- `apps/web/src/components/GlobalPlayerFooter.tsx` does not recompute current
  chapter, normalize chapters again, or duplicate queue/progression semantics
- `apps/web/src/lib/workspace/schema.ts` contains the one canonical href
  normalizer used by workspace and pane navigation code
- `apps/web/src/lib/panes/paneRuntime.tsx`,
  `apps/web/src/lib/panes/paneRouteRegistry.tsx`, and
  `apps/web/src/lib/workspace/urlCodec.ts` do not implement parallel href
  normalization behavior
- `apps/web/src/lib/workspace/store.tsx` owns workspace state, url sync,
  open/close/activate/resize, and explicit recents posting only
- workspace title indirection and the resource-title cache machinery are
  deleted unless a currently supported user flow demonstrably requires them
  after the surrounding simplification
- `apps/web/src/components/workspace/WorkspaceHost.tsx` renders panes with one
  explicit title source and one explicit route-resolution path
- `apps/web/src/app/api/media/capture/article/route.ts`,
  `apps/web/src/app/api/media/capture/url/route.ts`,
  `apps/web/src/app/api/media/capture/file/route.ts`, and
  `apps/web/src/app/api/extension/session/route.ts` do not carry duplicated
  auth/header/abort/error proxy logic
- `apps/web/src/lib/reader/index.ts` is deleted
- legacy pane CSS modules are deleted
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx` uses a
  discriminated entry shape that cannot express `kind="media"` without `media`
  or `kind="podcast"` without `podcast`
- `python/nexus/services/highlights.py`, `python/nexus/services/search.py`, and
  `python/nexus/services/vault.py` do not read from or write to transcript
  highlight bridge rows or alternate quote-selector fallback models
- `python/nexus/services/media.py` and
  `python/nexus/services/podcasts/transcripts.py` use
  `media_transcript_states` as the only transcript-readiness source of truth
- `python/nexus/services/send_message.py`,
  `python/nexus/services/send_message_stream.py`,
  `python/nexus/services/conversations.py`,
  `python/nexus/schemas/conversation.py`, and `python/nexus/db/models.py` use a
  typed context model instead of `list[dict]` bridges
- `python/nexus/services/search.py`, `python/nexus/services/contexts.py`, and
  `python/nexus/services/context_rendering.py` do not use raw dict result rows
  or raw dict context bags as their canonical internal model
- podcast service modules expose only public functions they actually own;
  sibling underscore imports are removed
- test-only environment seams in production code are deleted
- duplicate linked-items, player, pane-layout, and proxy-route tests are
  collapsed to one meaningful behavioral owner per behavior
- mocked-child wiring tests, cutover tests, stale route-memory tests, and
  implementation-detail geometry/layout tests in cleaned areas are gone
- cleanup docs reference only files that exist

## key decisions

- `MediaPaneBody.tsx` stays as the only media-route controller
  reason: the route needs one owner for navigation and top-level fetch state,
  but the current problem is too much behavior living there, not too little
- no replacement mega-hook or helper bag for the media route
  reason: replacing one central indirection layer with another preserves the
  same ownership problem
- leaf reader and transcript modules own their own substantive behavior
  reason: real behavior should sit with the module that renders and mutates it
- `PdfReader.tsx` keeps only pdf-specific runtime logic
  reason: pdf concerns should not leak into a fake generic reader layer
- podcast list/detail duplication is removed without creating a generic podcast
  framework
  reason: the transport and mutation duplication is real, but adding an
  abstraction stack would violate the simplicity target
- `normalizeWorkspaceHref()` in `apps/web/src/lib/workspace/schema.ts` is the
  only href normalizer
  reason: multiple normalization paths create silent divergence and fallback
  branches
- `resolvePaneRoute()` remains the one route matcher
  reason: the router should know current supported routes only
- `AuthenticatedLayout` plus `WorkspaceHost` are the only authenticated pane
  runtime owners
  reason: wrapper pages and root-navigation fallbacks preserve a second control
  path that makes the app harder to reason about
- unsupported routes are unsupported
  reason: the pane system should not preserve historical route memory
- pane title logic is simplified aggressively
  reason: temporary generic titles are acceptable; a second title/cache/hint
  subsystem is not
- search pane and command palette share one canonical search adapter path
  reason: duplicated request + normalize + adapt code multiplies contract drift
- library-target and membership flows consolidate around one explicit owner
  reason: the same fetch and mutation logic is currently repeated across
  unrelated panes and trays
- `globalPlayer.tsx` owns normalized track/chapter state
  reason: the footer is presentation and controls, not a second player engine
- extension capture/session routes share one explicit proxy implementation
  reason: four near-identical route handlers are duplication, not clarity
- conversation send paths keep explicit streaming and non-streaming flows
  reason: explicit branches are easier to debug than hidden transport fallback
- typed highlight anchors are the only highlight contract
  reason: keeping bridge semantics alive preserves two storage models
- transcript readiness uses `media_transcript_states` only
  reason: transcript capability is a transcript concern, not an ingest-state
  inference problem
- route handlers normalize transport once and services accept typed inputs
  reason: duplicated normalization weakens the service boundary and multiplies
  control flow
- backend search and context rendering replace raw dict bridges with typed
  owners
  reason: raw dict bags leak transport ambiguity across service boundaries
- podcast package boundaries must be real
  reason: sibling-private imports recreate the old monolith under new file
  names
- test cleanup prefers deletion and coverage collapse before helper extraction
  reason: sharing test harnesses only helps when the duplication is mechanical;
  otherwise it hides behavior under more indirection
- tests optimize for confidence, not topology coverage
  reason: behavior is the contract; wiring and private shape are not

## workstreams

1. media route and reader ownership cleanup
2. player and chat cleanup
3. workspace, panes, titles, and navigation cleanup
4. shared frontend flow and bff cleanup
5. frontend podcast simplification
6. backend highlight and transcript hard cutover
7. backend messaging and service-boundary cleanup
8. podcast backend package-boundary cleanup
9. test cleanup
10. docs cleanup

## files in scope

### 1. media route and reader ownership cleanup

- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/EpubContentPane.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/TranscriptContentPanel.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/TranscriptPlaybackPanel.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/TranscriptStatePanel.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaHighlightsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/transcriptView.ts`
- `apps/web/src/app/(authenticated)/media/[id]/mediaHighlights.ts`
- `apps/web/src/components/PdfReader.tsx`
- `apps/web/src/components/LinkedItemsPane.tsx`

### 2. player and chat cleanup

- `apps/web/src/lib/player/globalPlayer.tsx`
- `apps/web/src/components/GlobalPlayerFooter.tsx`
- `apps/web/src/lib/player/subscriptionPlaybackSpeed.ts`
- `apps/web/src/components/ChatComposer.tsx`

### 3. workspace, panes, titles, and navigation cleanup

- `apps/web/src/app/(authenticated)/layout.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/page.tsx`
- `apps/web/src/app/(authenticated)/libraries/page.tsx`
- `apps/web/src/lib/workspace/schema.ts`
- `apps/web/src/lib/workspace/urlCodec.ts`
- `apps/web/src/lib/workspace/store.tsx`
- `apps/web/src/lib/panes/openInAppPane.ts`
- `apps/web/src/lib/panes/paneRuntime.tsx`
- `apps/web/src/lib/panes/paneRouteRegistry.tsx`
- `apps/web/src/components/workspace/WorkspaceHost.tsx`
- `apps/web/src/components/workspace/WorkspaceTabsBar.tsx`
- `apps/web/src/lib/reader/index.ts`

### 4. shared frontend flow and bff cleanup

- `apps/web/src/app/(authenticated)/search/SearchPaneBody.tsx`
- `apps/web/src/components/CommandPalette.tsx`
- `apps/web/src/app/(authenticated)/browse/BrowsePaneBody.tsx`
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
- `apps/web/src/components/LibraryMembershipPanel.tsx`
- `apps/web/src/components/LibraryTargetPicker.tsx`
- `apps/web/src/components/AddContentTray.tsx`
- `apps/web/src/app/api/media/capture/article/route.ts`
- `apps/web/src/app/api/media/capture/url/route.ts`
- `apps/web/src/app/api/media/capture/file/route.ts`
- `apps/web/src/app/api/extension/session/route.ts`
- `apps/web/src/lib/api/proxy.ts`

### 5. frontend podcast simplification

- `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
- `apps/web/src/app/(authenticated)/browse/BrowsePaneBody.tsx`
- `apps/web/src/components/LibraryMembershipPanel.tsx`
- `apps/web/src/components/LibraryTargetPicker.tsx`
- `apps/web/src/components/AddContentTray.tsx`

### 6. backend highlight and transcript hard cutover

- `python/nexus/services/highlights.py`
- `python/nexus/services/search.py`
- `python/nexus/services/vault.py`
- `python/nexus/services/media.py`
- `python/nexus/services/podcasts/transcripts.py`
- `python/nexus/schemas/highlights.py`
- `python/nexus/api/routes/highlights.py`
- `python/nexus/api/routes/media.py`

### 7. backend messaging and service-boundary cleanup

- `python/nexus/services/send_message.py`
- `python/nexus/services/send_message_stream.py`
- `python/nexus/services/conversations.py`
- `python/nexus/services/contexts.py`
- `python/nexus/services/context_rendering.py`
- `python/nexus/schemas/conversation.py`
- `python/nexus/db/models.py`
- `python/nexus/api/routes/conversations.py`
- `python/nexus/api/routes/stream.py`
- `python/nexus/services/media.py`

### 8. podcast backend package-boundary cleanup

- `python/nexus/services/podcasts/catalog.py`
- `python/nexus/services/podcasts/subscriptions.py`
- `python/nexus/services/podcasts/provider.py`
- `python/nexus/services/podcasts/transcripts.py`
- `python/nexus/services/podcasts/sync.py`
- `python/nexus/services/podcasts/__init__.py`
- `python/nexus/services/upload.py`

### 9. test cleanup

- `apps/web/src/__tests__/components/LinkedItemsPane.test.tsx`
- `apps/web/src/__tests__/components/GlobalPlayerFooter.test.tsx`
- `apps/web/src/__tests__/components/GlobalPlayerQueue.test.tsx`
- `apps/web/src/__tests__/components/GlobalPlayerPersistence.test.tsx`
- `apps/web/src/__tests__/components/GlobalPlayerMediaSession.test.tsx`
- `apps/web/src/__tests__/components/GlobalPlayerAudioEffects.test.tsx`
- `apps/web/src/__tests__/components/PaneShell.test.tsx`
- `apps/web/src/__tests__/components/SelectionPopover.test.tsx`
- `apps/web/src/__tests__/components/ConversationPaneBody.test.tsx`
- `apps/web/src/lib/search/resultRowAdapter.test.ts`
- `e2e/tests/pdf-reader.spec.ts`
- `e2e/tests/non-pdf-linked-items.spec.ts`
- `e2e/tests/epub.spec.ts`
- `e2e/tests/reader-resume.spec.ts`
- `e2e/tests/pane-chrome.spec.ts`
- `apps/web/src/app/api/media/capture/article/route.test.ts`
- `apps/web/src/app/api/media/capture/url/route.test.ts`
- `apps/web/src/app/api/media/capture/file/route.test.ts`
- `apps/web/src/app/api/extension/session/route.test.ts`

### 10. docs cleanup

- `docs/codebase-cleanup-cutover.md`
- any doc that references deleted files or removed routes

## workstream targets

### 1. media route and reader ownership cleanup

- move transcript-specific behavior to transcript owners
- move epub-specific behavior to epub owners
- keep only route-level orchestration in `MediaPaneBody.tsx`
- inline one-use media helpers and constants that only exist because the god
  file accumulated them
- keep only coherent, reused local utilities with real payoff
- reduce prop tunneling from `MediaPaneBody.tsx` into leaf render shells

### 2. player and chat cleanup

- keep chapter normalization and chapter-selection logic in one player owner
- remove footer-side derivation of player state already owned elsewhere
- keep chat streaming and non-streaming paths explicit and separate
- remove any fallback branch or side effect that exists only to preserve an old
  behavior contract

### 3. workspace, panes, titles, and navigation cleanup

- remove wrapper pages and root-navigation fallback logic that preserve a
  second authenticated runtime path
- keep one href normalizer
- keep one route matcher
- reduce workspace store ownership to state, url sync, pane actions, and
  explicit recents posting
- remove title-hint, title-cache, and fallback-title machinery unless a current
  supported flow still requires it after simplification
- remove barrel exports and dead pane leftovers
- delete unsupported historical route handling

### 4. shared frontend flow and bff cleanup

- keep one search request + normalize + adapt path shared by search ui and
  command palette
- keep one library-target loading and membership mutation owner used by browse,
  trays, library, media, and podcast panes
- remove impossible library-entry transport shapes and classify bad payloads at
  the boundary
- collapse extension capture/session routes to one explicit proxy path without
  building a new proxy framework
- delete dead search helpers and duplicate validation-only entry points that no
  production caller uses

### 5. frontend podcast simplification

- remove duplicated transport types where one canonical owner is clearly
  warranted
- consolidate duplicated sync/settings/library mutation flows without building a
  new abstraction stack
- inline trivial one-use helpers inside the large pane files
- keep only substantive extracted code with obvious payoff

### 6. backend highlight and transcript hard cutover

- remove transcript highlight bridge behavior from runtime services
- remove vault fallback selector/quote export paths that preserve old models
- make transcript readiness derive from `media_transcript_states` only
- remove `processing_status` transcript readiness inference from podcast
  transcript flows
- keep only the typed highlight anchor contract

### 7. backend messaging and service-boundary cleanup

- replace `list[dict]` context bridges with a typed canonical model
- replace raw dict search-result rows and raw dict prompt-context bags with
  typed internal owners
- normalize transport payloads once in routes
- keep service interfaces typed and explicit
- remove broad parsing funnels and dead duplicate-insert error handling that do
  not materially improve safety

### 8. podcast backend package-boundary cleanup

- remove sibling-private imports
- expose only the small public functions each module actually owns
- keep package boundaries aligned to real subdomains: catalog, subscriptions,
  provider, transcripts, and sync
- remove test-only environment branches from production code

### 9. test cleanup

- delete mocked child-wiring tests and replace them only where real behavior
  coverage is still needed
- collapse duplicated linked-items and player coverage across component and e2e
  layers
- share e2e helpers and browser harnesses only where the sharing removes
  mechanical repetition instead of hiding behavior
- delete cutover-only tests and route-memory tests
- move api behavior assertions up to responses and user flows
- move schema/persistence assertions down to migration or schema-level tests
- keep fewer, higher-confidence browser, integration, and e2e tests

### 10. docs cleanup

- ensure every referenced file exists
- ensure every stated cut line matches the code
- ensure only one cleanup target-state doc exists for this pass

## acceptance criteria

- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx` is the only
  media-route controller and no longer owns transcript-specific or epub-specific
  leaf behavior
- `apps/web/src/components/PdfReader.tsx` does not expose or depend on a
  test-only runtime seam
- `apps/web/src/app/(authenticated)/layout.tsx`,
  `apps/web/src/components/workspace/WorkspaceHost.tsx`, and
  `apps/web/src/lib/panes/paneRuntime.tsx` do not preserve a second
  authenticated navigation/runtime path through wrapper pages or root fallback
  branches
- `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx` and
  `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
  do not duplicate subscription sync/settings transport types or mutation flows
- `apps/web/src/app/(authenticated)/search/SearchPaneBody.tsx` and
  `apps/web/src/components/CommandPalette.tsx` use the same search request,
  normalization, and row-adaptation path
- `apps/web/src/app/(authenticated)/browse/BrowsePaneBody.tsx`,
  `apps/web/src/components/AddContentTray.tsx`,
  `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`,
  `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`,
  and `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
  do not duplicate library-target loading or membership mutation logic
- `apps/web/src/lib/player/globalPlayer.tsx` is the sole owner of chapter
  normalization and current-chapter semantics
- `apps/web/src/components/GlobalPlayerFooter.tsx` does not contain
  chapter-resolution logic
- `apps/web/src/lib/workspace/schema.ts` is the only href normalizer used by
  workspace and pane-navigation code
- `apps/web/src/lib/workspace/store.tsx` does not own title-cache or title-hint
  persistence unless a supported flow demonstrably requires it
- no extra workspace title-indirection layer remains between route chrome,
  runtime titles, and the rendered pane shell
- `apps/web/src/app/api/media/capture/article/route.ts`,
  `apps/web/src/app/api/media/capture/url/route.ts`,
  `apps/web/src/app/api/media/capture/file/route.ts`, and
  `apps/web/src/app/api/extension/session/route.ts` do not duplicate the same
  proxy boilerplate
- `apps/web/src/lib/reader/index.ts` does not exist
- legacy pane CSS modules do not exist
- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx` does
  not admit impossible entry states that require post-fetch defensive guards
- `python/nexus/services/highlights.py`, `python/nexus/services/search.py`, and
  `python/nexus/services/vault.py` do not read from or write to transcript
  highlight bridge rows or alternate selector-handle fallback models
- `python/nexus/services/media.py` and
  `python/nexus/services/podcasts/transcripts.py` do not derive transcript
  readiness from `processing_status`
- `python/nexus/services/send_message.py`,
  `python/nexus/services/send_message_stream.py`,
  `python/nexus/services/conversations.py`,
  `python/nexus/schemas/conversation.py`, and `python/nexus/db/models.py` do
  not use `list[dict]` as the canonical message-context model
- `python/nexus/services/search.py`, `python/nexus/services/contexts.py`, and
  `python/nexus/services/context_rendering.py` do not use raw dict bridges as
  their canonical internal model
- podcast service modules do not import private underscore helpers from sibling
  podcast modules
- `Environment.TEST` branches do not remain in production transcript enqueue
  code
- linked-items, player, pane-layout, and proxy-route tests do not repeat the
  same behavior across multiple layers without adding confidence
- mocked proxy-path tests, mocked child-wiring tests, cutover tests, and stale
  route-memory tests in cleaned areas do not remain
- cleanup docs do not reference missing files
- `make verify` passes
- `make test-e2e` passes

## implementation order

1. docs and dead-surface cleanup first
2. media route and reader ownership cleanup
3. workspace, panes, titles, and navigation cleanup
4. shared frontend flow and bff cleanup
5. player and chat cleanup
6. frontend podcast simplification
7. backend highlight and transcript hard cutover
8. backend messaging and service-boundary cleanup
9. podcast backend package-boundary cleanup
10. test cleanup
11. final docs sync and full verification

## validation

- `make verify`
- `make test-e2e`
- targeted browser coverage for media readers, workspace panes, highlights,
  search, library-target flows, and podcast flows
- targeted backend integration coverage for media, highlights, conversations,
  and podcasts

## shipping bar

- do not ship partial cutover
- do not keep dead compatibility code in production files
- do not keep stale tests to preserve removed seams
- do not keep stale doc references to deleted files
- do not add new abstractions to compensate for not deleting old ones
- do not keep wrapper pages, root fallbacks, or copy-pasted proxy handlers
  solely because they already exist
- if a cleanup decision cannot be made without preserving two paths, choose one
  path and delete the other
