# codebase cleanup hard cutover

this document defines the implementation target for the current repo-wide
cleanup pass.

it supersedes the previous cleanup inventory and reflects the current tree.

it is a hard cutover plan. do not preserve legacy behavior, duplicate code
paths, backward-compatibility shims, deprecated routes, deprecated schema
fields, transition wrappers, or test-only production seams.

## current status

the current tree has already completed these cutovers:

- dead wrappers `PageLayout`, `SplitSurface`, and `PaneStrip` are deleted
- thin reader wrappers `DocumentViewport` and `ReaderContentArea` are deleted
- mocked BFF proxy path tests in the cleaned web routes are deleted
- URL-attached conversation context no longer rehydrates itself through client
  fan-out requests
- browse UI consumes only the grouped `sections` response shape
- `PdfReader.tsx` no longer exposes the `deps` test seam; browser tests mock
  module boundaries instead
- library entry media hydration now reuses canonical media hydration
- shared visibility SQL is imported from `nexus.auth.permissions`, not from
  `nexus.services.search`
- fragment highlight collection responses now use the canonical typed `anchor`
  payload in backend and web code
- backend highlight create, update, transcript sync, and vault sync paths now
  use canonical anchor/subtype rows without runtime fallback through legacy
  `highlights.fragment_id` / `start_offset` / `end_offset`
- the physical highlight bridge columns are removed from the head schema and
  fixture cleanup no longer targets them
- the one-use `findDuplicateHighlight()` helper is deleted
- stale screenshot artifacts for removed pane and transcript tests are deleted

remaining cleanup should treat this document as a target-state spec, not as an
inventory of transition scaffolding that still exists.

the biggest remaining item is:

- delete `useMediaRouteState.tsx` and make `MediaPaneBody.tsx` the only
  media-route controller

## goals

- collapse each capability onto one canonical production path
- make ownership obvious from file structure, module boundaries, and control
  flow
- delete dead code, dead tests, dead wrappers, dead exports, and stale docs
- split god files only when the split clearly reduces cognitive load
- keep implementation local and explicit instead of reusable-looking
  indirection
- make tests prove user-visible behavior instead of import topology, source
  text, mocked child wiring, or route string plumbing
- align the resulting code with `docs/rules/simplicity.md`,
  `docs/rules/module-apis.md`, `docs/rules/layers.md`,
  `docs/rules/control-flow.md`, and `docs/rules/testing_standards.md`

## non-goals

- product redesign
- feature additions
- speculative abstractions, registries, adapters, builders, helper
  frameworks, or generic infrastructure
- preserving old request or response shapes, old routes, old query params, or
  old storage bridges for compatibility
- partial migration plans, gradual rollout paths, feature flags, or fallback
  compatibility modes
- rewriting framework-required filesystem entrypoints that still have one
  clear owner and one clear purpose

## target behavior

- all supported user flows keep working through one explicit production path
- unsupported old inputs and routes fail fast or disappear instead of being
  silently translated
- the media route is easy to follow from `MediaPaneBody.tsx` and the owning
  reader components without a hidden god-hook controller
- transcript-capable media derive read, quote, highlight, and search
  capabilities from one transcript readiness source only
- highlight create, read, update, and delete behavior uses one canonical typed
  model with no fragment bridge semantics and no PDF compatibility payloads
- workspace navigation normalizes hrefs once, in one place, and rejects bad
  inputs explicitly
- backend services branch explicitly and exhaustively instead of relying on
  fallback behavior or broad catch-all parsing
- tests fail only on meaningful behavior regressions, not harmless refactors

## final state

- `apps/web/src/components/Pane.tsx`,
  `apps/web/src/components/PaneContainer.tsx`, and
  `apps/web/src/components/workspace/index.ts` are deleted
- `apps/web/src/components/ui/PageLayout.tsx`,
  `apps/web/src/components/workspace/SplitSurface.tsx`, and
  `apps/web/src/components/workspace/PaneStrip.tsx` are deleted
- stale cutover-only test inventory is gone, including
  `apps/web/src/app/(authenticated)/media/[id]/TranscriptMediaPane.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx` is the only
  media-route controller
- `apps/web/src/app/(authenticated)/media/[id]/useMediaRouteState.tsx` is
  deleted
- `apps/web/src/app/(authenticated)/media/[id]/mediaHelpers.ts` is deleted as
  a mixed-purpose helper dump
- `apps/web/src/components/PdfReader.tsx` exposes only real production API
  surface; the `deps` test seam is removed
- `apps/web/src/components/LinkedItemsPane.tsx`,
  `apps/web/src/components/PdfReader.tsx`,
  `apps/web/src/app/(authenticated)/media/[id]/TranscriptPlaybackPanel.tsx`,
  `apps/web/src/app/(authenticated)/media/[id]/TranscriptContentPanel.tsx`,
  and `apps/web/src/app/(authenticated)/media/[id]/EpubContentPane.tsx`
  directly own their real behavior
- `apps/web/src/lib/player/globalPlayer.tsx` no longer exports or relies on a
  no-op fallback context
- `apps/web/src/components/GlobalPlayerFooter.tsx` does not duplicate player
  option or chapter logic already owned elsewhere
- `apps/web/src/components/ChatComposer.tsx` keeps one explicit streaming path
  and one explicit non-stream path, with no hidden automatic fallback between
  them
- `apps/web/src/lib/api/client.ts` no longer performs auth recovery by setting
  `sessionStorage` flags and reloading the page
- `apps/web/src/lib/workspace/schema.ts` contains the one canonical href
  normalizer used by workspace and pane navigation code
- `apps/web/src/lib/panes/paneRouteRegistry.tsx` no longer contains a
  hardcoded list of removed historical routes; unknown routes are simply
  unsupported
- frontend podcast panes do not duplicate the same wire types and simple label
  helpers across multiple large files
- transcript readiness for podcast and video media is derived only from
  `media_transcript_states`
- `processing_status` remains a generic ingest state and no longer acts as a
  transcript readiness fallback
- highlight storage and API contracts are canonical only
- highlight bridge columns and bridge-only integrity helpers are removed
- `python/nexus/services/highlight_kernel.py` is deleted
- `python/nexus/services/libraries.py` no longer manually rebuilds `MediaOut`
  or duplicates canonical hydration logic from `python/nexus/services/media.py`
- visibility SQL helpers do not live in `python/nexus/services/search.py`
- route handlers normalize transport payloads once, then pass typed service
  inputs instead of raw dicts and duplicated normalization logic
- podcast service modules have real boundaries and do not import each other's
  private helpers as an unofficial compatibility surface
- source-inspection tests, proxy path plumbing tests, mocked child wiring
  tests, and stale cutover contract tests are removed from cleaned areas
- cleanup docs match the final tree and do not reference missing files

## hard cutover rules

- remove deprecated routes instead of forwarding them to the new path
- remove deprecated schema fields and bridge columns instead of continuing
  additive compatibility
- remove dead wrappers instead of keeping aliases to the canonical function
- remove one-use prop-relay components instead of renaming them
- do not keep old and new transcript readiness logic in parallel
- do not keep old and new highlight models in parallel
- do not keep old and new navigation normalization paths in parallel
- do not keep old and new chat transport behavior in parallel via hidden
  fallback
- do not add new generic reader, pane, workspace, player, or service
  infrastructure to hide the cleanup
- if a helper, type, constant, or component is used once and does not hide
  substantial incidental complexity, inline it
- if a split creates a facade layer, registry, or compatibility wrapper, the
  split is wrong
- if a branch still exists only to support old callers, remove it
- if a test asserts source text, import topology, mocked child wiring, proxy
  path strings, or private helper exports instead of user-visible behavior,
  delete or rewrite it

## key decisions

- `MediaPaneBody.tsx` is the only media-route controller
  reason: the current media route already has substantive leaf owners, and the
  extra god-hook layer makes control flow harder to follow
- `useMediaRouteState.tsx` is deleted, not replaced by another generic
  controller hook
  reason: replacing one mega-hook with another would preserve the same
  indirection problem
- `mediaHelpers.ts` is deleted, not renamed or split into another catch-all
  helper layer
  reason: mixed-purpose utility bags hide ownership and encourage drift
- real reader behavior stays with the existing reader owners
  reason: `PdfReader.tsx`, `LinkedItemsPane.tsx`, transcript panels, and epub
  content already have clear runtime ownership; the cleanup should sharpen that
  ownership instead of inventing a framework
- `normalizeWorkspaceHref()` in `apps/web/src/lib/workspace/schema.ts` is the
  only href normalizer
  reason: duplicate normalization paths create silent divergence and extra
  fallback branches
- removed routes are handled generically as unsupported
  reason: the router should know current routes, not preserve historical route
  memory
- transcript media capability derivation uses `media_transcript_states` only
  reason: transcript readiness is a transcript concern, not a `processing_status`
  inference problem
- `processing_status` remains for ingest state only
  reason: keeping it separate prevents media capability logic from silently
  bridging two eras of state
- highlights keep the current real collection routes
  reason: fragment and pdf collection surfaces express real ownership, but item
  storage and mutation contracts must be canonical and typed
- the canonical highlight item contract is the typed anchor model
  reason: `TypedHighlightOut` and `UpdateHighlightRequest` already express the
  intended end state; the remaining work is to delete bridge behavior around
  them
- canonical media hydration stays in `python/nexus/services/media.py`
  reason: multiple services need the same output shape, and the current bug is
  duplicate ownership, not insufficient reuse
- visibility SQL moves to an auth-owned module, not a feature service
  reason: visibility is access control, and `search.py` is the wrong owner for
  code used across unrelated services
- route handlers convert transport payloads once and services accept typed
  inputs
  reason: duplicating normalization in both layers weakens the service
  boundary and adds extra branches
- podcast package modules may depend on public functions only
  reason: importing private helpers across package boundaries recreates the old
  monolith under a new directory layout
- `useGlobalPlayer()` fails fast when the provider is missing
  reason: silent no-op fallbacks hide wiring bugs and compatibility clutter
- thin framework entrypoints may remain
  reason: the problem is extra behavior and extra layers, not filesystem
  entrypoints that are required by Next.js or FastAPI

## workstreams

1. dead surface deletion
2. media route hard cutover
3. player, chat, auth, and workspace cleanup
4. frontend podcast simplification
5. transcript and highlight backend cutover
6. backend service ownership cleanup
7. podcast package boundary cleanup
8. test and docs cleanup

## files in scope

### dead surface deletion

- `apps/web/src/components/Pane.tsx`
- `apps/web/src/components/PaneContainer.tsx`
- `apps/web/src/components/workspace/index.ts`
- `apps/web/src/__tests__/components/Pane.test.tsx`
- `apps/web/src/__tests__/components/PaneContainer.test.tsx`
- `apps/web/src/__tests__/components/SplitSurface.test.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/TranscriptMediaPane.test.tsx`

### media route hard cutover

- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/useMediaRouteState.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/EpubContentPane.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/TranscriptPlaybackPanel.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/TranscriptContentPanel.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/TranscriptStatePanel.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaHighlightsPaneBody.tsx`
- `apps/web/src/components/PdfReader.tsx`
- `apps/web/src/components/LinkedItemsPane.tsx`

### player, chat, auth, and workspace cleanup

- `apps/web/src/lib/player/globalPlayer.tsx`
- `apps/web/src/components/GlobalPlayerFooter.tsx`
- `apps/web/src/lib/player/subscriptionPlaybackSpeed.ts`
- `apps/web/src/components/ChatComposer.tsx`
- `apps/web/src/lib/api/client.ts`
- `apps/web/src/lib/workspace/schema.ts`
- `apps/web/src/lib/workspace/store.tsx`
- `apps/web/src/lib/panes/openInAppPane.ts`
- `apps/web/src/lib/panes/paneRuntime.tsx`
- `apps/web/src/lib/panes/paneRouteRegistry.tsx`
- `apps/web/src/components/workspace/WorkspaceHost.tsx`

### frontend podcast simplification

- `apps/web/src/app/(authenticated)/browse/BrowsePaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx`
- `apps/web/src/app/(authenticated)/podcasts/[podcastId]/PodcastDetailPaneBody.tsx`
- `apps/web/src/components/AddContentTray.tsx`
- `apps/web/src/app/(authenticated)/settings/billing/SettingsBillingPaneBody.tsx`

### transcript and highlight backend cutover

- `python/nexus/db/models.py`
- `python/nexus/services/capabilities.py`
- `python/nexus/services/highlights.py`
- `python/nexus/services/highlight_kernel.py`
- `python/nexus/services/media.py`
- `python/nexus/services/libraries.py`
- `python/nexus/services/reader.py`
- `python/nexus/schemas/highlights.py`
- `python/nexus/api/routes/highlights.py`
- `python/nexus/api/routes/media.py`
- `apps/web/src/app/api/media/[id]/pdf-highlights/route.ts`
- `apps/web/src/app/api/highlights/[highlightId]/route.ts`
- `apps/web/src/app/api/highlights/[highlightId]/annotation/route.ts`
- `apps/web/src/app/api/fragments/[fragmentId]/highlights/route.ts`

### backend service ownership cleanup

- `python/nexus/services/media.py`
- `python/nexus/services/libraries.py`
- `python/nexus/services/search.py`
- `python/nexus/services/send_message.py`
- `python/nexus/services/send_message_stream.py`
- `python/nexus/api/routes/conversations.py`
- `python/nexus/api/routes/stream.py`
- `python/nexus/auth/permissions.py`

### podcast package boundary cleanup

- `python/nexus/services/podcasts/catalog.py`
- `python/nexus/services/podcasts/subscriptions.py`
- `python/nexus/services/podcasts/provider.py`
- `python/nexus/services/podcasts/transcripts.py`
- `python/nexus/services/podcasts/sync.py`
- `python/nexus/services/podcasts/__init__.py`

### test and docs cleanup

- `apps/web/src/app/api/media/media-routes.test.ts`
- `apps/web/src/app/api/billing/billing-routes.test.ts`
- `apps/web/src/app/api/podcasts/podcasts-routes.test.ts`
- `apps/web/src/app/api/libraries/libraries-media-routes.test.ts`
- `apps/web/src/app/api/libraries/invites-routes.test.ts`
- `apps/web/src/app/api/playback/playback-routes.test.ts`
- `apps/web/src/app/api/conversations/shares-routes.test.ts`
- `apps/web/src/app/api/me/command-palette-recents/route.test.ts`
- `apps/web/src/app/api/vault/route.test.ts`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx`
- `apps/web/src/__tests__/components/WorkspaceHost.test.tsx`
- `apps/web/src/lib/panes/paneRouteRegistry.test.tsx`
- `apps/web/src/lib/api/proxy.test.ts`
- `apps/web/src/lib/ui/mobileScrollFixes.test.ts`
- `apps/web/src/lib/workspace/store-recents.test.tsx`
- `python/tests/test_library_target_picker_cutover.py`
- `python/tests/test_pdf_highlights_integration.py`
- `python/tests/test_highlight_kernel.py`
- `python/tests/test_ingest_remediation_contracts.py`
- `python/tests/test_reader_integration.py`
- `python/tests/test_command_palette_recents_integration.py`
- `docs/mobile-pane-chrome-cutover.md`
- `docs/mobile-highlights-pane-cutover.md`
- `docs/codebase-cleanup-cutover.md`

## workstream targets

### 1. dead surface deletion

- delete runtime-dead pane layers and their dead tests
- delete the unused workspace barrel
- delete stale test files and stale names that refer to removed wrappers
- delete underscored test-only exports from production modules

### 2. media route hard cutover

- remove `useMediaRouteState.tsx`
- move the remaining route orchestration into one explicit `MediaPaneBody.tsx`
- keep `MediaPaneBody.tsx` as the only media-route controller
- move behavior to the true owners instead of creating another shared
  controller
- inline one-use media helpers, constants, and object shapes from the deleted
  hook where they do not hide real incidental complexity
- keep only coherent, reused local utilities where the reuse is real
- eliminate duplicated selection snapshot utilities, DOM escape helpers, and
  pass-through prop bundles that exist only because the hook existed

### 3. player, chat, auth, and workspace cleanup

- remove `FALLBACK_CONTEXT` and make missing-provider access fail fast
- eliminate duplicate speed and chapter logic in `GlobalPlayerFooter.tsx`
- keep player ownership clear between provider state and footer rendering
- remove the hidden `sendNonStreaming` fallback from the streaming path in
  `ChatComposer.tsx`
- remove auth recovery reload logic from `apps/web/src/lib/api/client.ts`
- keep one href normalizer
- remove duplicate normalization passes and silent early-return branches
- reduce `store.tsx` to one clear ownership boundary instead of reducer,
  hydration, URL sync, telemetry, recents, and event bridge all at once
- remove historical route special cases from `paneRouteRegistry.tsx`

### 4. frontend podcast simplification

- remove duplicated wire types and label helpers where one canonical owner is
  clearly warranted
- inline trivial one-use helpers inside the large pane files
- keep only substantive extracted components or utilities
- reduce repeated subscription settings, library membership, and refresh flow
  code where the duplication is large enough to create maintenance risk

### 5. transcript and highlight backend cutover

- make transcript capability derivation use `media_transcript_states` only
- remove transcript readiness fallback from `processing_status`
- delete remaining runtime highlight bridge semantics from services and vault
- remove any bridge-only integrity handling once the schema cleanup lands
- delete `highlight_kernel.py`
- delete highlight tests that exist only to preserve bridge behavior
- keep only the typed highlight anchor model and canonical mutation contract
- remove the generic `/media/{id}/fragments` compatibility surface if no
  supported product flow still depends on it

### 6. backend service ownership cleanup

- keep `MediaOut` hydration in one owner only
- remove manual hydration duplication from `libraries.py`
- move visibility SQL ownership out of `search.py`
- replace broad cursor parsing fallbacks with explicit validation
- make route handlers the only transport-normalization layer for message
  contexts
- make services accept typed normalized inputs, not `list[dict]`
- remove dead wrappers such as `can_read_media` aliases outside the canonical
  auth owner

### 7. podcast package boundary cleanup

- remove private cross-module imports between `sync.py` and `transcripts.py`
- expose only the small public functions each podcast module actually owns
- keep package boundaries aligned to real subdomains: catalog, subscriptions,
  provider, transcripts, and sync
- do not add a compatibility facade in `__init__.py`
- remove test-only or compatibility-only bridge helpers inside the package

### 8. test and docs cleanup

- delete mocked proxy route tests and replace them only where real behavior
  coverage is still needed
- delete mocked child-wiring and source-layout tests
- keep higher-confidence browser, e2e, and API-behavior tests
- collapse duplicate cutover rejection coverage to one owner per removed
  surface
- rename or delete stale test files that preserve migration-era terminology
- update docs so every referenced file exists and every stated cut line matches
  the code

## acceptance criteria

- `apps/web/src/app/(authenticated)/media/[id]/useMediaRouteState.tsx` does
  not exist
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx` is the only
  media-route controller and does not consume a one-consumer controller-hook
  prop bag
- `apps/web/src/app/(authenticated)/media/[id]/mediaHelpers.ts` does not exist
- `apps/web/src/components/Pane.tsx`,
  `apps/web/src/components/PaneContainer.tsx`, and
  `apps/web/src/components/workspace/index.ts` do not exist
- `apps/web/src/app/(authenticated)/media/[id]/TranscriptMediaPane.test.tsx`
  does not exist
- `apps/web/src/components/PdfReader.tsx` does not expose `PdfReaderDeps` or
  `deps?: Partial<PdfReaderDeps>`
- `apps/web/src/lib/player/globalPlayer.tsx` does not contain
  `FALLBACK_CONTEXT`
- `apps/web/src/components/ChatComposer.tsx` does not automatically fall back
  from streaming send to non-stream send
- `apps/web/src/lib/api/client.ts` does not read or write auth-recovery flags
  in `sessionStorage` and does not reload the page on `401`
- `apps/web/src/lib/workspace/schema.ts` is the only href normalizer used by
  workspace and pane navigation code
- `apps/web/src/lib/panes/paneRouteRegistry.tsx` does not enumerate removed
  legacy routes by pathname
- `python/nexus/services/capabilities.py` does not derive transcript media
  readability from `processing_status`
- `python/nexus/services/highlights.py` and
  `python/nexus/services/vault.py` do not read from or write to highlight
  bridge columns at runtime
- `python/nexus/services/highlight_kernel.py` does not exist
- `python/nexus/services/libraries.py` does not manually construct `MediaOut`
  from duplicated hydration logic
- no service imports a visibility SQL helper from
  `python/nexus/services/search.py`
- `python/nexus/services/send_message.py` and
  `python/nexus/services/send_message_stream.py` accept typed normalized
  contexts, not raw `list[dict]` transport payloads
- podcast service modules do not import private helpers from sibling podcast
  modules
- mocked proxy route tests and mocked child-wiring tests in cleaned areas do
  not remain
- cleanup docs do not reference missing files
- `make verify` passes
- `make test-e2e` passes

## implementation order

1. delete dead surfaces and stale tests first
2. cut over the media route and remove the god-hook/helper layer
3. remove frontend compatibility fallbacks and duplicate navigation logic
4. finish transcript and highlight backend cutover
5. clean up backend service ownership boundaries
6. tighten podcast package boundaries
7. delete or rewrite low-value tests
8. sync docs to the final tree and rerun full verification

## validation

- `make verify`
- `make test-e2e`
- targeted browser coverage for media readers, workspace panes, highlights, and
  chat streaming
- targeted backend integration coverage for media, highlights, conversations,
  and podcasts

## shipping bar

- do not ship partial cutover
- do not leave dead compatibility code in production files
- do not keep stale tests to preserve removed seams
- do not keep stale doc references to deleted files
- if a final module still needs a large comment to explain ownership, the
  ownership is still too indirect and the cleanup is not done
