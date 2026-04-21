# codebase cleanup hard cutover

this document defines the implementation target for the current repo-wide
cleanup pass.

it is a hard cutover plan. do not preserve legacy behavior, duplicate code
paths, backward-compatibility shims, deprecated routes, deprecated schema
fields, or transition wrappers.

## goals

- reduce the number of production code paths for each capability
- make ownership obvious from the file structure and control flow
- remove dead code, dead tests, dead wrappers, dead parameters, and stale docs
- split god files only when the split clearly reduces cognitive load
- keep implementation local and explicit instead of reusable-looking
  indirection
- make tests prove behavior instead of source layout or internal wiring
- align the resulting code with `docs/rules/simplicity.md`,
  `docs/rules/module-apis.md`, `docs/rules/layers.md`,
  `docs/rules/control-flow.md`, and `docs/rules/testing_standards.md`

## non-goals

- product redesign
- feature additions
- speculative abstractions, registries, adapters, builders, or helper
  frameworks
- preserving old response shapes, old routes, old query params, or old test
  seams for compatibility
- rewriting framework-required filesystem entrypoints that still have a clear
  owning purpose
- partial migration plans, feature flags, gradual rollout paths, or fallback
  compatibility modes

## target behavior

- all supported user flows keep working through one canonical production path
- unsupported legacy inputs and routes fail fast or disappear instead of being
  silently translated
- browser streaming uses one canonical transport path
- highlight create, read, update, and delete behavior uses one canonical typed
  model with no legacy bridge semantics
- media-reader behavior stays functionally equivalent for supported flows, but
  the route ownership and local state boundaries become easier to follow
- backend services branch explicitly and exhaustively
- tests fail only on meaningful behavior regressions, not harmless refactors

## final state

- there is one canonical browser streaming path:
  browser -> stream token -> fastapi `/stream/*`
- old BFF-proxied streaming routes are deleted
- unused legacy SSE client code is deleted
- highlight storage and API contracts are typed and canonical only
- highlight code no longer dual-writes to legacy bridge fields or preserves
  fragment-era compatibility shapes
- `useMediaViewState` no longer owns unrelated reader concerns in one file
- transcript fragment selection logic exists in one place only
- one-use wrapper components that only relay props are removed
- one href normalizer exists for workspace/pane navigation
- dead backend wrapper functions and dead parameters are removed
- service files branch exhaustively instead of falling through to silent
  fallback behavior
- `python/nexus/services/podcasts.py` is replaced by a small set of concrete
  subdomain-owned modules, with no compatibility facade preserving the old
  monolith surface
- source-inspection tests, legacy cutover contract tests, and
  compatibility-preserving tests are removed from cleaned areas

## hard cutover rules

- remove deprecated routes instead of forwarding them to the new path
- remove deprecated schema fields instead of continuing additive compatibility
- remove dead wrappers instead of keeping aliases to the canonical function
- remove one-use prop-relay components instead of renaming them
- do not keep old and new highlight models in parallel
- do not keep old and new streaming implementations in parallel
- do not add new generic reader, pane, or service infrastructure to hide the
  cleanup
- if a helper, type, constant, or component is used once and does not hide
  substantial incidental complexity, inline it
- if a split creates a facade layer, the split is wrong
- if a test asserts source text, import topology, or mocked child wiring rather
  than user-visible behavior, delete or rewrite it
- any branch that still exists only to support old callers must be removed

## key decisions

- direct streaming is the only streaming transport
  reason: the current app already uses `sseClientDirect`; the older sync bridge
  and old stream routes are explicit compatibility baggage
- non-streaming message send may remain only as an explicit product path
  reason: failure fallback for a supported product behavior is different from
  preserving a deprecated transport surface
- highlights keep collection routes that match their real owner surface
  reason: fragment-scoped and page-scoped collection reads are real domain
  operations, but the item model and mutation shape must be canonical and typed
- highlight item mutation moves to one typed request model
  reason: `pdf_bounds`, flat fragment fields, and legacy response variants are
  compatibility clutter
- media reader cleanup stays local to the media route
  reason: the repo rules favor direct local ownership over a reusable reader
  framework
- `TranscriptMediaPane.tsx` is removed
  reason: it is a one-use orchestration wrapper between `MediaPaneBody` and
  more substantive transcript leaf components
- `MediaHighlightsPaneBody.tsx` stays only if it continues to own real
  highlight-pane behavior
  reason: substantive local ownership is fine; prop plumbing is not
- workspace navigation uses one href normalizer
  reason: duplicate normalization APIs create subtle divergence and extra
  branches
- `podcasts.py` is split by subdomain, not wrapped by a new facade
  reason: smaller concrete modules reduce collision and search cost without
  adding another abstraction layer

## workstreams

1. streaming hard cutover
2. highlight contract hard cutover
3. media reader decomposition and wrapper removal
4. backend service cleanup and dead-surface removal
5. podcasts service split
6. workspace navigation normalization cleanup
7. test suite cleanup

## files in scope

### streaming

- `apps/web/src/lib/api/sse.ts`
- `apps/web/src/components/ChatComposer.tsx`
- `apps/web/src/lib/api/proxy.ts`
- `python/nexus/services/send_message_stream.py`
- `python/nexus/api/routes/conversations.py`
- `python/nexus/api/routes/stream.py`

### highlights

- `python/nexus/services/highlights.py`
- `python/nexus/api/routes/highlights.py`
- `python/nexus/schemas/highlights.py`
- `apps/web/src/app/(authenticated)/media/[id]/mediaHelpers.ts`
- `apps/web/src/app/(authenticated)/media/[id]/useMediaViewState.tsx`
- `apps/web/src/components/PdfReader.tsx`
- `apps/web/src/app/api/fragments/[fragmentId]/highlights/route.ts`
- `apps/web/src/app/api/highlights/[highlightId]/route.ts`
- `apps/web/src/app/api/highlights/[highlightId]/annotation/route.ts`
- `apps/web/src/app/api/media/[id]/pdf-highlights/route.ts`

### media reader

- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/useMediaViewState.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/TranscriptMediaPane.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/TranscriptPlaybackPanel.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/TranscriptContentPanel.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/EpubContentPane.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaHighlightsPaneBody.tsx`

### backend service cleanup

- `python/nexus/services/media.py`
- `python/nexus/services/capabilities.py`
- `python/nexus/services/search.py`
- `python/nexus/services/libraries.py`

### podcasts split

- `python/nexus/services/podcasts.py`
- `python/nexus/api/routes/podcasts.py`
- any tests directly targeting the current monolith layout

### workspace cleanup

- `apps/web/src/lib/workspace/schema.ts`
- `apps/web/src/lib/workspace/store.tsx`
- `apps/web/src/lib/panes/openInAppPane.ts`
- `apps/web/src/lib/panes/paneRuntime.tsx`
- `apps/web/src/components/workspace/WorkspaceHost.tsx`

### test cleanup

- `apps/web/src/lib/panes/workspacePaneCutover.contract.test.ts`
- `apps/web/src/__tests__/components/Navbar.test.tsx`
- `apps/web/src/__tests__/components/AddContentTray.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx`
- `python/tests/test_upload.py`
- `python/tests/test_media.py`
- `python/tests/test_search.py`
- `python/tests/test_route_structure.py`
- `python/tests/test_job_cutover_contract.py`
- `python/tests/test_pdf_highlights_integration.py`

## workstream targets

### 1. streaming hard cutover

- delete `/conversations/messages/stream` and
  `/conversations/{conversation_id}/messages/stream`
- delete `stream_send_message()` and its thread/queue bridge
- delete unused `sseClient()` and any comments pointing to the old BFF
  streaming path
- remove unused SSE-specific proxy surface from the BFF layer if no remaining
  route needs it
- keep only the direct `/stream/*` fastapi transport for streaming

### 2. highlight contract hard cutover

- remove fragment legacy response compatibility and PDF generic compat wording
- remove dual-write and legacy bridge semantics from highlight storage and
  service code
- remove `pdf_bounds` compatibility request shape
- replace mixed legacy request/response variants with one typed item model
- keep collection routes only where they express real collection ownership,
  not compatibility
- update frontend highlight calls to the canonical request and response shapes

### 3. media reader decomposition and wrapper removal

- split `useMediaViewState` into a small set of route-local files by concern,
  with no generic reader framework
- move transcript fragment selection into one explicit implementation
- inline or delete one-use wrappers that only relay props
- remove `TranscriptMediaPane.tsx`
- keep transcript timestamp formatting in one shared local utility only
- eliminate `MediaPaneBody` dependency suppressions caused by unstable
  all-in-one hook return objects

### 4. backend service cleanup and dead-surface removal

- delete dead wrappers in `media.py`
- delete dead parameters in `capabilities.py`
- remove stale constants and silent fallback branches in `search.py`
- replace service-layer `assert` boundary checks with explicit validated
  control flow
- remove stale docs and comments that describe already-removed compatibility
  behavior

### 5. podcasts service split

- replace the single `podcasts.py` monolith with a small concrete package or
  module set split by ownership:
  discovery/catalog, subscriptions/opml, transcript, and sync
- route handlers import the defining module directly
- do not keep a compatibility facade mirroring the old file's public surface

### 6. workspace navigation normalization cleanup

- choose one canonical href normalizer
- delete the duplicate normalizer
- update open-pane, workspace store, and pane runtime code to use the same
  normalization logic
- remove fallback chaining between normalizers

### 7. test suite cleanup

- remove source-text and route-layout contract tests
- remove tests whose only purpose is to preserve compatibility response fields
- rewrite heavily mocked tests toward behavior checks or delete them if higher
  confidence coverage already exists
- keep only cutover tests that reject removed legacy inputs and routes

## implementation rules

- keep control flow linear and explicit
- prefer explicit `if` and `elif` branches over generic dispatch maps when the
  variant set is small and known
- enforce exhaustiveness in typed branching
- do not add new context layers, reusable state machines, strategy objects, or
  policy objects
- do not add new option flags to support old and new behavior side by side
- do not preserve old names as aliases after the new name lands
- do not keep TODO comments about future deletion for code that should be
  deleted in this cutover
- route files stay transport-only
- services stay framework-free
- tests assert public behavior, not child component composition or source text

## acceptance criteria

- the only remaining streaming browser transport is `/stream/*`
- no deprecated stream routes remain in fastapi route files
- no sync bridge remains in `send_message_stream.py`
- no unused SSE client surface remains in the web app
- highlight item requests and responses use one typed canonical contract
- no highlight dual-write or legacy bridge behavior remains in production code
- no `pdf_bounds` compatibility branch remains
- `useMediaViewState` no longer duplicates transcript fragment resolution logic
- transcript timestamp formatting exists in one place only
- `TranscriptMediaPane.tsx` is deleted
- dead wrappers `can_read_media`, `get_media_for_viewer_or_404`, and
  `enqueue_web_article_from_url` are deleted if still unused at implementation
  time
- dead `capabilities.py` parameters are removed
- `search.py` has no stale ANN-cutover constant and no silent unknown-type
  fallback
- `libraries.py` contains no bare `assert` for request invariants in the
  cleaned path
- `podcasts.py` no longer exists as a single multi-domain god file
- only one href normalizer remains in the workspace path
- no compatibility-preserving ingest/retry tests remain
- no source-inspection cutover tests remain in cleaned areas
- no heavily mocked component test remains where a behavior-level browser or
  e2e test already covers the same contract

## validation

- `make verify`
- `make test-e2e`
- targeted browser tests for media reader, highlights, and workspace panes
- targeted backend integration tests for highlights, streaming, media, search,
  libraries, and podcasts

## shipping bar

- do not ship partial cutover
- do not leave dead code in place because removal felt risky
- do not leave old tests asserting previous contracts
- do not leave comments that say code is deprecated or will be removed later
- if two production code paths still exist for the same capability after the
  cutover, the cutover is not done
