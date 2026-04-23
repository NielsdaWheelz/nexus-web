# frontend test hard cutover

this document defines the target frontend test architecture for the current
cleanup pass.

it aligns the frontend test surface to the repo rules and the current state of
modern browser testing tooling.

it is a hard cutover plan. do not preserve legacy browser-test patterns,
mock-heavy browser suites, mixed browser/node test idioms, stale browser test
projects, compatibility wrappers, or transition-era exceptions once the new
path is in place.

## standards

this cutover aligns the frontend test surface to:

- `docs/codebase-cleanup-cutover.md`
- `docs/rules/simplicity.md`
- `docs/rules/control-flow.md`
- `docs/rules/codebase.md`
- `docs/rules/module-apis.md`
- `docs/rules/layers.md`
- `docs/rules/errors.md`
- `docs/rules/conventions.md`
- `docs/rules/testing_standards.md`

## goals

- make `apps/web` test ownership obvious by tier
- keep `playwright` e2e as the largest frontend confidence layer
- keep `vitest` browser mode as a small, strict, browser-native layer
- keep `vitest` node tests for pure logic only
- delete browser tests that prove wiring, import topology, or mocked internal
  behavior instead of user-visible behavior
- remove mixed browser test styles that combine browser mode with internal
  `vi.mock`, fake browser interactions, or page-level fake integration flows
- make `bun run test:browser` deterministic, explainable, and easy to debug
- collapse browser rendering, querying, interaction, and assertion onto one
  canonical path
- cut direct component-to-component dependencies that exist only to share event
  constants or dispatch helpers
- minimize test indirection, helper stacks, and shared mutable test state

## non-goals

- replacing `playwright` e2e with a new framework
- migrating the repo to `playwright` component testing in this cleanup
- preserving existing browser tests because they already exist
- keeping low-value component tests that duplicate e2e coverage
- introducing a repo-specific test framework, test manifest, custom DSL,
  generic harness factory, or helper registry
- broad product changes unrelated to test ownership and test reliability
- adding fallback test paths so old and new browser suites can coexist long
  term

## hard cutover rules

- browser tests must not use `vi.mock` for internal app modules
- browser tests must not use `@testing-library/user-event`
- browser tests must not simulate routing, auth, api clients, or app stores
  through mocked internal modules
- page-level flows that require real routing, auth, bff calls, or persisted app
  state belong in `playwright` e2e, not in browser mode
- pure derivation and normalization logic belongs in node `vitest`, not in
  browser mode
- browser mode exists only for real-browser behavior that earns the tier:
  layout, selection, focus, media, browser apis, pointer interactions, and
  other browser-native ui behavior
- do not keep a browser test if e2e already proves the same user-visible
  contract at higher confidence and lower maintenance cost
- shared browser setup may contain only stable repo-wide framework shims and
  cleanup; no app-specific mocks, no hidden fake stores, no hidden fake api
  surfaces
- each browser test file must be safe to run alone and safe to run in the full
  suite
- do not preserve dead browser projects, stale includes, stale excludes, or
  serial fallback lanes
- do not add new test-only production seams to make cleanup easier
- if a reusable browser helper is used once, inline it
- if a browser helper only renames direct testing-library or vitest-browser
  calls, delete it
- if a component imports another heavyweight component module only to obtain an
  event constant or dispatcher, cut that dependency

## target behavior

- `bun run test:browser` runs only tests that need a real browser
- `bun run test:browser` starts immediately, does not stall on queued files, and
  finishes reliably from a clean state
- each retained browser test file can run by itself and inside the full browser
  project without hidden order dependencies
- browser tests use browser-native rendering and interactions instead of
  simulated interaction libraries or internal module mocks
- browser tests assert visible ui state, accessibility state, selection state,
  layout-sensitive behavior, and browser-api behavior only
- `playwright` e2e owns authenticated navigation, cross-pane flows, bff
  behavior, auth, persistence, and page-level data flows
- node `vitest` owns pure logic only
- event contracts shared across frontend modules live in small leaf modules with
  obvious ownership, not inside heavyweight component files
- the browser test setup is short enough to understand in one read
- the browser tier is small enough that a maintainer can identify why a test is
  in browser mode without guessing

## final state

- `apps/web/vitest.config.ts` defines one browser project with only
  browser-worthy files
- `apps/web/package.json` keeps one `test:browser` command that runs that
  project only
- `apps/web/vitest.browser-setup.ts` contains only stable framework shims and
  cleanup needed by every browser file
- browser tests use one canonical browser-native path:
  `vitest-browser-react` for rendering react components and `vitest/browser`
  locators, interactions, and assertions for browser-mode behavior
- `apps/web/src/components/Navbar.tsx` no longer imports
  `apps/web/src/components/CommandPalette.tsx` just to dispatch add-content
  events
- add-content event names and dispatch helpers live in one small leaf module
  shared by `Navbar`, `CommandPalette`, `AddContentTray`, and their tests
- `apps/web/src/__tests__/components/Navbar.test.tsx` is deleted, moved to a
  higher-confidence tier, or rewritten so it does not rely on async internal
  mocks, `vi.importActual`, `next/link` mocks, or shared global mutation
- `apps/web/src/__tests__/components/CommandPalette.test.tsx`,
  `AddContentTray.test.tsx`, `ConversationPaneBody.test.tsx`,
  `ReaderSettingsPage.test.tsx`, `AppList.test.tsx`, and browser-run settings
  page suites are either:
  rewritten to use real browser owners and browser-native interactions,
  promoted to e2e, demoted to node unit tests when the value is pure logic, or
  deleted if the behavior is already covered elsewhere
- `apps/web/src/__tests__/components/GlobalPlayerFooter.test.tsx`,
  `GlobalPlayerQueue.test.tsx`, `GlobalPlayerPersistence.test.tsx`,
  `GlobalPlayerMediaSession.test.tsx`, and
  `GlobalPlayerAudioEffects.test.tsx` no longer depend on fragile timer,
  animation-frame, media-session, or descriptor patching patterns that leak
  across tests
- browser-entitled suites such as `LinkedItemsPane`, `SelectionPopover`,
  `PaneShell`, highlight DOM logic, and other browser-api-heavy behavior remain
  in browser mode only if they stay local, explicit, and stable
- `.test.tsx` browser files do not contain `vi.mock`
- `.test.tsx` browser files do not import `@testing-library/user-event`
- the browser suite no longer needs dead compatibility config or special-case
  serial projects to pass

## files in scope

- `apps/web/vitest.config.ts`
- `apps/web/package.json`
- `apps/web/vitest.browser-setup.ts`
- `apps/web/src/components/Navbar.tsx`
- `apps/web/src/components/CommandPalette.tsx`
- `apps/web/src/components/AddContentTray.tsx`
- the new leaf module that owns the add-content event contract
- `apps/web/src/__tests__/components/Navbar.test.tsx`
- `apps/web/src/__tests__/components/CommandPalette.test.tsx`
- `apps/web/src/__tests__/components/AddContentTray.test.tsx`
- `apps/web/src/__tests__/components/ConversationPaneBody.test.tsx`
- `apps/web/src/__tests__/components/AppList.test.tsx`
- `apps/web/src/__tests__/components/ReaderSettingsPage.test.tsx`
- `apps/web/src/__tests__/components/GlobalPlayerFooter.test.tsx`
- `apps/web/src/__tests__/components/GlobalPlayerQueue.test.tsx`
- `apps/web/src/__tests__/components/GlobalPlayerPersistence.test.tsx`
- `apps/web/src/__tests__/components/GlobalPlayerMediaSession.test.tsx`
- `apps/web/src/__tests__/components/GlobalPlayerAudioEffects.test.tsx`
- `apps/web/src/__tests__/components/PaneShell.test.tsx`
- `apps/web/src/__tests__/components/SelectionPopover.test.tsx`
- `apps/web/src/__tests__/components/LinkedItemsPane.test.tsx`
- `apps/web/src/lib/highlights/**/*.test.ts`
- `apps/web/src/components/LibraryMembershipPanel.test.tsx`
- `apps/web/src/components/LibraryTargetPicker.test.tsx`
- `apps/web/src/app/(authenticated)/search/page.test.tsx`
- `apps/web/src/app/(authenticated)/settings/**/*.test.tsx`
- `e2e/tests/**/*.spec.ts`

## key decisions

- `playwright` e2e remains the highest-confidence frontend integration layer
  reason: it already owns the real app, real routing, real auth, and real bff
  paths, and it matches `docs/rules/testing_standards.md`

- `vitest` browser mode stays as the frontend component/browser-api tier
  reason: the repo already standardizes this tier, and replacing it with another
  framework would add migration cost and a second component-test stack

- browser mode becomes strict and small instead of broad and permissive
  reason: broad browser suites encourage mock-heavy pseudo-integration tests
  that are harder to understand than either true e2e tests or pure node tests

- browser tests use `vitest-browser-react` and `vitest/browser` as the one
  browser-native path
  reason: mixed `@testing-library/react` plus `@testing-library/user-event`
  patterns are a bad fit for vitest browser mode and create unnecessary
  indirection

- internal-module `vi.mock` is removed from browser files instead of being
  stabilized
  reason: the repo rules already disallow this pattern for browser tests, and
  the current failures point directly at that surface

- low-value browser tests are deleted instead of rewritten by default
  reason: fewer, higher-confidence tests are better than preserving broad
  legacy coverage that proves wiring instead of behavior

- page-level mocked browser tests move up to e2e, not sideways into larger
  browser harnesses
  reason: adding larger browser harnesses preserves the wrong tier instead of
  using the tier that actually owns the behavior

- event contracts move to leaf modules only when multiple real owners need them
  reason: this specific extraction cuts real component coupling and removes a
  direct source of brittle browser imports

- shared browser setup stays minimal
  reason: hidden global behavior in setup files makes browser failures harder to
  localize and violates the directness target

- automatic mock/global restoration config is a guardrail, not the architecture
  reason: the long-term-safe fix is to remove shared mutable test state, not to
  depend on cleanup magic to make brittle tests survive

- browser determinism is more important than browser throughput during this
  cutover
  reason: a smaller, explainable suite is worth more than speculative parallel
  speed

## implementation order

1. cut browser test eligibility
   remove or move browser files that do not earn the browser tier

2. cut direct component coupling
   move the add-content event contract out of `CommandPalette.tsx` and stop
   importing heavyweight component modules just for event dispatch

3. rewrite or delete the direct blockers
   start with `Navbar.test.tsx` and the other mock-heavy browser files that rely
   on internal `vi.mock`

4. normalize the browser test path
   move retained browser files to the canonical browser-native render and
   interaction path and delete mixed interaction styles

5. harden browser state ownership
   remove global mutation leaks, timer leaks, and descriptor patching patterns
   from retained browser files

6. collapse duplicate coverage
   delete browser tests whose behavior is already proven in e2e or pure logic
   tests

7. verify and lock the cutover
   run the full frontend verification path and keep only the minimal docs and
   config needed by the final architecture

## acceptance criteria

- `apps/web/src/**/*.test.tsx` contains no `vi.mock`
- `apps/web/src/**/*.test.tsx` contains no `@testing-library/user-event` import
- `apps/web/src/**/*.test.tsx` contains no async `vi.importActual` mock
  factories
- `apps/web/src/components/Navbar.tsx` does not import
  `apps/web/src/components/CommandPalette.tsx`
- `bun run test:browser` passes from a clean state
- `bun run test:browser` passes in repeated local runs without queued-file hangs
- each retained browser file passes when run alone
- retained browser tests assert browser-native behavior only
- app-level navigation and data-flow behavior is covered at the e2e layer, not
  via mocked browser suites
- `make verify` passes with the final browser architecture
- docs describe the final test architecture only; no stale browser-project
  notes, migration notes, or legacy exceptions remain

## shipping bar

- no known queued-file browser hangs remain
- no browser-file order dependencies remain
- no hidden app-specific mocks remain in browser setup
- no compatibility lane remains for the previous mixed browser test style
- a maintainer can explain why each remaining browser file is still in browser
  mode in one sentence
