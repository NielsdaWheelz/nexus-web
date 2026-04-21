# reader restore cutover

this doc owns the hard cutover for reader resume and restore behavior in:

- `apps/web/src/app/(authenticated)/media/[id]/`
- `apps/web/src/lib/reader/`
- `python/nexus/services/reader.py`
- `python/nexus/schemas/reader.py`

it replaces the current restore model built from:

- a flat optional-field `ReaderLocator`
- best-effort frontend locator normalization
- epub section boot logic that re-runs on live persisted updates
- late anchor fallback scrolls after the user has already started reading
- heading-label fallback that can snap the pane to the top of a section

after cutover, restore is a one-shot, abortable navigation session driven by
one canonical persisted contract.

there is no backward compatibility layer.

## goals

- make reader restore deterministic across reloads, deep links, and slow
  async hydration
- make epub resume exact when enough data exists and stable when exact data
  is stale
- prevent any late auto-scroll from overriding user intent
- make one module own restore orchestration instead of spreading it across
  unrelated effects
- replace the flat locator bag with an explicit discriminated union
- remove dead fallback behavior and legacy parsing paths
- keep the final code easy to reason about under
  `docs/rules/control-flow.md`

## non-goals

- no new public sharing UI for exact epub locations
- no migration layer that reads both old and new reader-state shapes
- no support for old persisted `reader_media_state.locator` payloads
- no heading-text heuristics for restore
- no generic router-wide scroll restoration framework
- no rewrite of highlight anchor storage in this cutover
- no adoption of full epub cfi generation/parsing in this cutover

## target behavior

### shared restore contract

- every reader persists exactly one explicit resume shape
- `GET /api/media/{id}/reader-state` returns `ReaderResumeState | null`
- `PUT /api/media/{id}/reader-state` accepts `ReaderResumeState | null`
- the payload is discriminated by `kind`
- the frontend does not coerce unknown objects into a locator
- the backend does not accept removed fields or removed payload shapes

### initial open

- the reader resolves restore intent once per media open
- restore intent precedence is:
  - explicit URL deep link
  - explicit in-app navigation target
  - persisted reader resume state snapshot
  - default open target
- after the restore session settles or is cancelled, later persisted updates
  do not restart restore

### epub open

- with `?loc={section_id}`, the reader opens that section first
- if the resolved intent also carries an exact anchor or exact text locator,
  the reader restores inside that section once
- if exact restore fails, epub fallback order is:
  - exact anchor id in the rendered section
  - exact text locator within the rendered section
  - quote-context match within the rendered section
  - section-local progression
  - publication `total_progression`
  - publication `position`
  - section top
- fallback to section top is allowed only during the initial restore session
- section top fallback never happens later as a consequence of persistence

### explicit epub navigation

- toc clicks, previous/next section, manual section select, and internal epub
  links are explicit navigation commands
- an explicit navigation command starts a new restore session only for that
  command
- explicit in-section anchor links may scroll to the requested anchor once
- explicit navigation updates persisted reader state after the new location is
  settled
- explicit navigation does not rely on heading-label matching

### user interruption

- any user scroll input cancels a pending automatic restore immediately
- any manual section change cancels the prior restore session immediately
- any explicit internal link jump cancels the prior restore session
- once cancelled, an automatic restore session never re-arms itself
- the reader may still keep persisting current position after cancellation

### reload and history behavior

- reload restores from the saved resume state snapshot once
- browser back/forward for epub respects the current `?loc` section first
- URL synchronization mirrors the active epub section after resolution
- URL synchronization is descriptive only and does not create a second restore
  loop

### typography and reflow

- reflowable readers restore against canonical text and progression, not raw
  scroll pixels
- changing reader theme, font family, font size, line height, or column width
  does not trigger a new restore session
- after a typography change, the current visible location continues to be the
  source of truth for later persistence

### stale or invalid state

- if the persisted state kind does not match the media kind, the state is
  rejected
- if an epub state points to a missing section, the reader falls back through
  the initial restore order and then rewrites persisted state with the
  resolved location
- if an exact epub anchor is stale, the reader ignores it and continues to the
  next fallback
- stale state never causes a late jump after the user has started scrolling

## final state

### persisted contract

the flat `ReaderLocator` type is deleted.

the final persisted contract is a discriminated union:

```ts
type ReaderResumeState =
  | {
      kind: "pdf";
      page: number;
      page_progression: number | null;
      zoom: number | null;
      position: number | null;
    }
  | {
      kind: "web";
      target: { fragment_id: string };
      locations: {
        text_offset: number | null;
        progression: number | null;
        total_progression: number | null;
        position: number | null;
      };
      text: {
        quote: string | null;
        quote_prefix: string | null;
        quote_suffix: string | null;
      };
    }
  | {
      kind: "transcript";
      target: { fragment_id: string };
      locations: {
        text_offset: number | null;
        progression: number | null;
        total_progression: number | null;
        position: number | null;
      };
      text: {
        quote: string | null;
        quote_prefix: string | null;
        quote_suffix: string | null;
      };
    }
  | {
      kind: "epub";
      target: {
        section_id: string;
        href_path: string;
        anchor_id: string | null;
      };
      locations: {
        text_offset: number | null;
        progression: number | null;
        total_progression: number | null;
        position: number | null;
      };
      text: {
        quote: string | null;
        quote_prefix: string | null;
        quote_suffix: string | null;
      };
    };
```

contract rules:

- `kind` is required
- `target` is required for non-pdf readers
- `href_path` is required for epub
- `section_id` is required for epub
- `page` is required for pdf
- `quote_prefix` and `quote_suffix` require `quote`
- blank strings are invalid
- removed flat fields such as top-level `source`, `anchor`, `text_offset`,
  `progression`, and `total_progression` are invalid

### restore ownership

- `useReaderResumeState.ts` owns only:
  - strict load
  - strict save
  - debounce/flush
- `useReaderResumeState.ts` does not own navigation decisions
- a new feature-local restore module owns restore orchestration for the media
  pane
- the restore module owns:
  - initial restore intent resolution
  - restore session lifecycle
  - cancellation on user intent
  - settle semantics
- `useMediaViewState.tsx` consumes the restore module instead of rebuilding
  restore control flow from independent effects

### restore session model

- restore is a state machine, not a loose collection of refs
- one restore session has these states:
  - `idle`
  - `resolving`
  - `opening_target`
  - `restoring_exact`
  - `restoring_fallback`
  - `settled`
  - `cancelled`
- only one restore session may be active at a time
- a newer session cancels the older session
- any async step must check session identity before mutating state

### epub exactness model

- epub resume is publication- and section-aware
- the persisted epub target is the pair:
  - `section_id`
  - `href_path`
- exact intra-section restore is driven by:
  - `text_offset`
  - quote context
  - optional `anchor_id`
  - progression fields
- `anchor_id` is a narrow exact hint only
- `anchor_id` is never allowed to degrade into heading-label matching
- if `anchor_id` is absent or stale, restore continues through text and
  progression fallbacks without inventing a synthetic anchor

### url model

- `?loc={section_id}` remains the canonical epub section deep link
- the URL reflects the resolved active section after navigation settles
- URL updates do not trigger restore if they describe the current settled
  section

### code shape

- restore branching is explicit and exhaustive
- removed fallback paths are deleted, not hidden behind flags
- one-use restore helpers live beside the media pane, not in a new shared
  cross-reader framework
- persistence and restore remain separate responsibilities

## key decisions

### 1. the active reader view is the single source of truth

persisted state describes where the user was.

it does not continuously instruct the reader where to go after the reader is
already live.

### 2. restore is one-shot and abortable

restore is an initialization behavior.

it is not a background loop that can re-apply itself later.

### 3. replace the flat locator bag with an explicit union

the current shape allows too many impossible states.

the cutover makes payload validation structural instead of heuristic.

### 4. epub resume restores exact text before coarse section fallback

exact restore data is more valuable than section-level heuristics.

the cutover preserves that ordering strictly.

### 5. delete heading-label fallback

matching a heading by label is not a valid resume locator.

it is a chapter-top heuristic and caused the class of bug this cutover is
removing.

### 6. wipe persisted reader-state rows on cutover

supporting both old and new payloads would keep legacy complexity alive in the
service and frontend.

the cutover clears old rows and starts clean.

### 7. strict frontend decoding is part of correctness

the frontend should not silently normalize malformed payloads.

malformed data is a defect and should surface as such.

## rules

- follow `docs/rules/simplicity.md`
- follow `docs/rules/control-flow.md`
- follow `docs/rules/timing.md`
- follow `docs/rules/retries.md`
- follow `docs/rules/codebase.md`
- follow `docs/rules/testing_standards.md`

feature-specific implementation rules:

- do not keep the flat `ReaderLocator` type
- do not keep best-effort frontend locator normalization
- do not keep `pendingAnchorId` as a general restore control channel
- do not keep heading-label restore fallback
- do not let live persisted resume fields re-drive epub section resolution
- do not let URL sync trigger a second restore pass for the current section
- do not preserve old `reader_media_state.locator` rows
- do not add compatibility props or dual-schema parsing
- do not add a repo-wide generic scroll restoration abstraction

## files

### add

- `docs/reader-restore-cutover.md`
- `apps/web/src/app/(authenticated)/media/[id]/readerRestore.ts`
- `apps/web/src/app/(authenticated)/media/[id]/readerRestore.test.ts`
- one alembic migration in `migrations/alembic/versions/` to clear
  `reader_media_state.locator`

### modify

- `apps/web/src/app/(authenticated)/media/[id]/useMediaViewState.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/mediaHelpers.ts`
- `apps/web/src/app/(authenticated)/media/[id]/mediaHelpers.test.ts`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx`
- `apps/web/src/lib/reader/types.ts`
- `apps/web/src/lib/reader/useReaderResumeState.ts`
- `apps/web/src/lib/reader/useReaderResumeState.test.tsx`
- `python/nexus/schemas/reader.py`
- `python/nexus/services/reader.py`
- `python/tests/test_reader_integration.py`
- `e2e/tests/reader-resume.spec.ts`
- `e2e/tests/epub.spec.ts`
- `docs/reader-implementation.md`

### delete

- the flat `ReaderLocator` shape in frontend and backend code
- frontend parsing paths that accept unknown locator bags
- the epub restore effect that re-runs section boot from live resume updates
- the heading-label fallback restore path
- tests that assert removed payload shapes or removed fallback behavior

## plan

### 1. contract cutover

- replace the frontend and backend reader-state types with the discriminated
  union
- update backend validation and persistence rules
- clear old persisted reader-state rows with an alembic migration
- reject old flat payloads in integration tests

### 2. restore orchestration cutover

- add the feature-local restore state machine
- move restore intent resolution into that module
- make `useMediaViewState.tsx` consume one resolved restore session instead of
  stitching restore from multiple effects
- cancel restore on user scroll, manual navigation, and explicit link jumps

### 3. epub cutover

- resolve initial epub section once from explicit target or persisted snapshot
- remove heading-label fallback
- treat `anchor_id` as an optional narrow hint only
- keep exact restore ordering inside the resolved section
- persist top-of-section explicitly for manual section jumps instead of
  relying on late anchor heuristics

### 4. verification cutover

- add backend integration coverage for the new contract
- add component or hook tests for restore session cancellation and settling
- add e2e coverage for:
  - slow resume hydration
  - user scroll before restore settles
  - no late snap-back
  - `?loc` precedence
  - exact intra-section resume after reload
  - typography change without restore restart

### 5. docs cutover

- update `docs/reader-implementation.md` to describe the shipped final model
- do not keep the old flat locator contract documented anywhere

## acceptance criteria

### contract

- `GET /api/media/{id}/reader-state` returns only the new discriminated union
  shape or `null`
- `PUT /api/media/{id}/reader-state` rejects the removed flat payload shape
- old persisted reader-state rows are cleared during cutover

### restore behavior

- opening an epub and doing nothing restores exactly once
- opening an epub, scrolling manually before restore settles, and waiting does
  not snap the view back
- explicit `?loc` deep links win over saved resume state on initial open
- explicit internal epub anchor links jump once and do not trigger a second
  late jump
- manual section changes persist the new section cleanly and do not re-open
  the old section from a later debounce flush
- reloading after a manual section change restores to that section

### async safety

- no async restore step can mutate state after its session was cancelled
- no late save can restart epub section boot
- no URL sync can cause a second restore pass for the current section

### code state

- there is no heading-label fallback in the codebase
- there is no flat `ReaderLocator` type in the codebase
- there is no best-effort frontend locator normalizer in the codebase
- restore ownership is local and explicit

