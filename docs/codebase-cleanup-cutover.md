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

## goals

- collapse each capability onto one canonical production path
- make ownership obvious from file structure, module boundaries, and control
  flow
- delete dead code, dead tests, dead exports, dead styles, dead seams, and
  stale docs
- cut up god files and god functions only when the split clearly reduces
  cognitive load
- optimize for maintainer comprehension, not for reuse theater or speculative
  extensibility
- keep implementation local and explicit instead of reusable-looking
  indirection
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
- module boundaries are real: sibling packages do not import each other's
  underscore helpers
- the only allowed abstraction is one with obvious payoff: real reuse, real
  complexity reduction, or real safety
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
- workspace navigation uses one href normalizer and one route matcher
- workspace titles are derived simply and explicitly; the code does not maintain
  a second title system to hide routing or loading details
- global player state owns normalized track, chapter, queue, and playback state;
  the footer renders it instead of re-deriving it
- podcast list and detail panes do not duplicate transport types, sync flows,
  settings flows, or library-membership mutation logic
- transcript capability and readiness derive from `media_transcript_states`
  only
- highlight create, read, update, delete, search, and export use one canonical
  typed anchor model only
- conversation send paths accept typed context inputs end-to-end; raw dict
  bridges do not leak through services and schemas
- podcast backend modules have real public APIs and do not behave like one
  monolith split across files
- tests are concentrated in higher-confidence layers and fail only on
  meaningful behavioral regressions
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
- `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx` and
  `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
  do not duplicate subscription sync/settings transport types or mutation
  flows
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
- `apps/web/src/lib/reader/index.ts` is deleted
- legacy pane CSS modules are deleted
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
- podcast service modules expose only public functions they actually own;
  sibling underscore imports are removed
- test-only environment seams in production code are deleted
- mocked-child wiring tests, cutover tests, and stale route-memory tests in
  cleaned areas are gone
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
- unsupported routes are unsupported
  reason: the pane system should not preserve historical route memory
- pane title logic is simplified aggressively
  reason: temporary generic titles are acceptable; a second title/cache/hint
  subsystem is not
- `globalPlayer.tsx` owns normalized track/chapter state
  reason: the footer is presentation and controls, not a second player engine
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
- podcast package boundaries must be real
  reason: sibling-private imports recreate the old monolith under new file
  names
- tests optimize for confidence, not topology coverage
  reason: behavior is the contract; wiring and private shape are not

## workstreams

1. media route and reader ownership cleanup
2. player and chat cleanup
3. workspace, panes, titles, and navigation cleanup
4. frontend podcast simplification
5. backend highlight and transcript hard cutover
6. backend messaging and service-boundary cleanup
7. podcast backend package-boundary cleanup
8. test cleanup
9. docs cleanup

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

- `apps/web/src/lib/workspace/schema.ts`
- `apps/web/src/lib/workspace/urlCodec.ts`
- `apps/web/src/lib/workspace/store.tsx`
- `apps/web/src/lib/panes/openInAppPane.ts`
- `apps/web/src/lib/panes/paneRuntime.tsx`
- `apps/web/src/lib/panes/paneRouteRegistry.tsx`
- `apps/web/src/components/workspace/WorkspaceHost.tsx`
- `apps/web/src/components/workspace/WorkspaceTabsBar.tsx`
- `apps/web/src/lib/reader/index.ts`

### 4. frontend podcast simplification

- `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
- `apps/web/src/app/(authenticated)/browse/BrowsePaneBody.tsx`
- `apps/web/src/components/LibraryMembershipPanel.tsx`
- `apps/web/src/components/LibraryTargetPicker.tsx`
- `apps/web/src/components/AddContentTray.tsx`

### 5. backend highlight and transcript hard cutover

- `python/nexus/services/highlights.py`
- `python/nexus/services/search.py`
- `python/nexus/services/vault.py`
- `python/nexus/services/media.py`
- `python/nexus/services/podcasts/transcripts.py`
- `python/nexus/schemas/highlights.py`
- `python/nexus/api/routes/highlights.py`
- `python/nexus/api/routes/media.py`

### 6. backend messaging and service-boundary cleanup

- `python/nexus/services/send_message.py`
- `python/nexus/services/send_message_stream.py`
- `python/nexus/services/conversations.py`
- `python/nexus/schemas/conversation.py`
- `python/nexus/db/models.py`
- `python/nexus/api/routes/conversations.py`
- `python/nexus/api/routes/stream.py`
- `python/nexus/services/media.py`

### 7. podcast backend package-boundary cleanup

- `python/nexus/services/podcasts/catalog.py`
- `python/nexus/services/podcasts/subscriptions.py`
- `python/nexus/services/podcasts/provider.py`
- `python/nexus/services/podcasts/transcripts.py`
- `python/nexus/services/podcasts/sync.py`
- `python/nexus/services/podcasts/__init__.py`
- `python/nexus/services/upload.py`

### 8. test cleanup

- `e2e/tests/pdf-reader.spec.ts`
- `e2e/tests/pane-chrome.spec.ts`
- `python/tests/test_library_target_picker_cutover.py`
- `python/tests/test_command_palette_recents_integration.py`
- `python/tests/test_reader_integration.py`
- `python/tests/test_pdf_highlights_integration.py`
- `python/tests/fixtures.py`

### 9. docs cleanup

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

- keep one href normalizer
- keep one route matcher
- reduce workspace store ownership to state, url sync, pane actions, and
  explicit recents posting
- remove title-hint, title-cache, and fallback-title machinery unless a current
  supported flow still requires it after simplification
- remove barrel exports and dead pane leftovers
- delete unsupported historical route handling

### 4. frontend podcast simplification

- remove duplicated transport types where one canonical owner is clearly
  warranted
- consolidate duplicated sync/settings/library mutation flows without building a
  new abstraction stack
- inline trivial one-use helpers inside the large pane files
- keep only substantive extracted code with obvious payoff

### 5. backend highlight and transcript hard cutover

- remove transcript highlight bridge behavior from runtime services
- remove vault fallback selector/quote export paths that preserve old models
- make transcript readiness derive from `media_transcript_states` only
- remove `processing_status` transcript readiness inference from podcast
  transcript flows
- keep only the typed highlight anchor contract

### 6. backend messaging and service-boundary cleanup

- replace `list[dict]` context bridges with a typed canonical model
- normalize transport payloads once in routes
- keep service interfaces typed and explicit
- remove broad parsing funnels and dead duplicate-insert error handling that do
  not materially improve safety

### 7. podcast backend package-boundary cleanup

- remove sibling-private imports
- expose only the small public functions each module actually owns
- keep package boundaries aligned to real subdomains: catalog, subscriptions,
  provider, transcripts, and sync
- remove test-only environment branches from production code

### 8. test cleanup

- delete mocked child-wiring tests and replace them only where real behavior
  coverage is still needed
- delete cutover-only tests and route-memory tests
- move api behavior assertions up to responses and user flows
- move schema/persistence assertions down to migration or schema-level tests
- keep fewer, higher-confidence browser, integration, and e2e tests

### 9. docs cleanup

- ensure every referenced file exists
- ensure every stated cut line matches the code
- ensure only one cleanup target-state doc exists for this pass

## acceptance criteria

- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx` is the only
  media-route controller and no longer owns transcript-specific or epub-specific
  leaf behavior
- `apps/web/src/components/PdfReader.tsx` does not expose or depend on a
  test-only runtime seam
- `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx` and
  `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
  do not duplicate subscription sync/settings transport types or mutation flows
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
- `apps/web/src/lib/reader/index.ts` does not exist
- legacy pane CSS modules do not exist
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
- podcast service modules do not import private underscore helpers from sibling
  podcast modules
- `Environment.TEST` branches do not remain in production transcript enqueue
  code
- mocked proxy-path tests, mocked child-wiring tests, cutover tests, and stale
  route-memory tests in cleaned areas do not remain
- cleanup docs do not reference missing files
- `make verify` passes
- `make test-e2e` passes

## implementation order

1. docs and dead-surface cleanup first
2. media route and reader ownership cleanup
3. workspace, panes, titles, and navigation cleanup
4. player and chat cleanup
5. frontend podcast simplification
6. backend highlight and transcript hard cutover
7. backend messaging and service-boundary cleanup
8. podcast backend package-boundary cleanup
9. test cleanup
10. final docs sync and full verification

## validation

- `make verify`
- `make test-e2e`
- targeted browser coverage for media readers, workspace panes, highlights, and
  podcast flows
- targeted backend integration coverage for media, highlights, conversations,
  and podcasts

## shipping bar

- do not ship partial cutover
- do not keep dead compatibility code in production files
- do not keep stale tests to preserve removed seams
- do not keep stale doc references to deleted files
- do not add new abstractions to compensate for not deleting old ones
- if a cleanup decision cannot be made without preserving two paths, choose one
  path and delete the other
