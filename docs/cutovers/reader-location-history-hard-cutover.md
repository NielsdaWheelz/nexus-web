# Reader Location History Hard Cutover

Status: PROPOSED REVISION
Type: hard cutover
Date: 2026-07-16

## Decision

Pane history records destination activations, not reader-local movement. The
five in-reader location-target writes update the current media visit; they do
not create Back/Forward checkpoints.

```text
non-media origin -> push media -> replace chapter 2 -> replace chapter 3
                 <- Back (media unmounts)

Forward -> media remount -> load canonical cursor -> render persisted location
                         -> strip coarse loc/fragment when cursor is Positioned
```

Guardrail: Back traverses the stored pane stack. The implementation never
synthesizes a library fallback.

No feature flag, dual behavior, fallback, legacy-history parser, compatibility
shim, or second navigation stack survives the cutover.

## Target Behavior

| User action | Pane operation | Result |
|---|---|---|
| Navigate the primary pane to another route/resource | `push` | Add one destination checkpoint |
| Cross-section/cross-fragment URL write from a reader-location owner | `replace` | Update the mounted media visit |
| Same-fragment reader focus/scroll | none | Focus without changing href or history |
| Generic same-pane note/resource activation | `push` | Add a destination checkpoint, even when it resolves to the same media |
| Launcher or `openInNewPane` | existing `open_pane` contract | Create a pane or apply exact-route reuse/dedupe |
| PDF page/zoom, transcript seek, ordinary scroll | none | Remain reader/player state |
| Pane Back/Forward | workspace traversal | Render the stored destination; a fresh media mount uses normal cursor precedence |

During the mounted visit, explicit reader commands may publish coarse `?loc`
and `?fragment` address state. On a fresh media mount, a Positioned canonical
cursor supersedes those fields and repairs the URL to the stable media route;
unrelated query/hash state still survives. An Empty cursor admits the coarse
target. In the non-media-origin journey, Forward therefore guarantees media
destination re-entry, not immediate restoration of an unsaved local chapter.

URL replacement and cursor persistence are independent. Back inside the save
window may later re-enter at the older persisted cursor.

## Proposed UX Tradeoff

Pane Back/Forward will no longer restore the source passage after an in-reader
same-media footnote, internal-link, apparatus, highlight, or embed jump. The
removed behavior was only coarse cross-section/fragment return, not exact scroll
return. Hover previews may avoid some jumps; Contents, section controls,
Document Map/Evidence, and canonical resume remain, but none returns to the
source passage. Generic same-pane destination activations remain reversible
pushes.

For the one-user prototype, this proposal accepts the loss without adding a
replacement affordance or reader-local return stack.

## Goals

- One Back after any number of the five reader-local location changes returns
  to the resource or surface that opened the media.
- Reader-location replacement consumes neither the 12-entry per-stack budget
  nor the 48-entry workspace budget; it cannot evict another pane's history.
- Desktop and mobile pane controls share the same behavior without new UI.
- The change lowers complexity and leaves one reader-owned location-target
  write seam.

## Scope

- EPUB and web-article location changes inside `MediaPaneBody`.
- Same-media section, fragment, apparatus, highlight, and embed activation.
- Nexus pane-local Back/Forward on desktop and mobile.
- Contradictory reader docs and tests.

## Non-Goals

- Native browser, Android hardware, or gesture Back.
- A generic navigation-intent enum or workspace history redesign.
- A new router, reader history stack, history-cap change, or route-identity rule.
- Exact progress permalinks or projecting ordinary reading progress into URLs.
- New chrome, shortcuts, animations, announcements, or focus-management mechanism.
- A passage-return affordance or reader-local return stack.
- Backend, BFF, database, reader-cursor, or workspace-state schema changes.

## Rules And Ownership

1. The workspace owns generic per-pane `push`, `replace`, Back, and Forward
   mechanics. It never infers history semantics from URL or resource equality.
2. Feature owners choose intent. The reader owns its five location-target
   writes; generic activation owners keep their existing destination semantics.
3. `navigateToSection`, `navigateToWebSection`, apparatus activation, highlight
   activation, and embed activation call one seam with `replace` whenever they
   publish a cross-section/cross-fragment href. Focus-only branches write none.
4. Raw same-pane note/resource activation uses `push` by contract, even if the
   href resolves to the current media. It does not reinterpret resource identity.
5. Launcher/`openInNewPane` behavior is unchanged: a new pane is created or an
   exact route is reused/deduped. Hash-only reuse may push into an existing pane;
   query-distinct media routes may open separately. A new pane never mutates the
   source pane's history.
6. URL addressability, route identity, resource identity, cursor authority, and
   history checkpoints remain distinct contracts.
7. Traversal alone creates no cursor write. Teardown may flush genuine dirty
   input that existed before Back; that flush is not traversal input.
8. A direct deep link or newly opened pane has no synthesized library
   predecessor.

Canonical documentation ownership after the cutover:

- `docs/modules/workspace.md`: generic pane-history semantics.
- `docs/modules/reader-implementation.md`: reader action-to-operation mapping.
- `docs/modules/reader-design-rationale.md`: addressability versus history rationale.
- This document: cutover scope, cleanup, and proof only.

## Final Architecture And Composition

```text
generic same-pane destination activation
  -> PaneScopedRouter.push
  -> workspace push transition
  -> destination checkpoint

launcher / openInNewPane
  -> existing open_pane + exact-route dedupe contract

reader-local location write (five owners, only when href is needed)
  -> replaceReaderLocation(target)
  -> buildReaderLocationHref(mediaId, target)
  -> PaneScopedRouter.replace
  -> workspace replace transition
  -> mounted href changes; back/forward stacks do not
  -> focus/scroll resolves
  -> genuine movement may save the canonical cursor after the existing debounce

Back/Forward -> workspace stack traversal -> normal target-entry contract above
```

The workspace store, route/resource identity, mounted-reader preservation,
reader target, and cursor coordinator keep their current responsibilities.

## Capability And Internal API Contract

Reuse the existing `PaneScopedRouter` capability unchanged:

```ts
router.push(href, options?)
router.replace(href, options?)
router.back()
router.forward()
```

Narrow the existing type owned by `readerLocationHref.ts`:

```ts
export type ReaderLocationTarget =
  | { loc: string; fragmentId?: string }
  | { fragmentId: string; loc?: never };
```

`MediaPaneBody` imports that type, requires the existing `usePaneRouter()`
capability for routing, and adds one non-exported reader-local seam:

```ts
replaceReaderLocation(target: ReaderLocationTarget): void
```

It performs exactly:

```ts
paneRouter.replace(buildReaderLocationHref(id, target));
```

It owns no reader state, progress, validation, restore, or focus behavior. Those
remain at existing call sites. Make the builder target required, remove nullable
field inputs and empty-target construction, and delete its unused `highlightId`
field and test. `?highlight=` is not a live URL contract; highlight targets use
`#highlight-{id}` or pulse state. Coarse-query repair continues to preserve live
unrelated state such as `apparatus`, other query fields, and hashes. Required
reader routing uses `usePaneRouter`; no optional-call no-op survives.

## State And Schema Contract

- Stable media entry: `/media/{id}`. During a mounted visit, explicit local
  commands may publish `?loc={section}&fragment={fragment}`.
- Workspace state/history arrays: unchanged.
- Reader cursor and progress APIs: unchanged.
- Backend, BFF, and database: unchanged.
- Persisted workspace history: no migration, normalization, or reset. Existing
  chapter stacks are unsupported historical data and may persist or be adopted
  from the most-recent non-trivial session on another device. Deterministic
  all-device removal requires a separately authorized workspace-state reset and
  is outside this cutover. Acceptance starts from isolated seeded state.

## Consolidation And Deletion

- Replace the five direct same-media
  `paneRouterPush(buildReaderLocationHref(...))` paths with
  `replaceReaderLocation(...)`.
- The five owners are `navigateToSection`, `navigateToWebSection`, apparatus
  activation, highlight activation, and embed activation.
- Keep `handleOpenNoteLink`, the two `activateResource(... navigate)` callbacks,
  and global open/dedupe behavior unchanged; they are destination activations,
  not reader-location writes.
- Reuse `readerLocationHref.ts`; do not create a hook, router wrapper, or barrel.
- Delete the old chapter-Back E2E expectation instead of preserving both modes.
- Replace only the contradictory reader-history statements named below; retain
  cursor precedence, URL repair, no-write echo, and layered-restore contracts.
- Rewrite live comments that describe reader locations as pane-history pushes.
- Delete only the adjacent unused `highlightId` builder field/assertion; no
  unrelated cleanup enters this change. Replace the phantom `?highlight=` route
  identity fixture with live query/hash state, and rewrite the builder header
  comment accordingly; existing coarse-query repair coverage already proves
  unrelated-query preservation.
- In `MediaPaneBody.test.tsx`, remove the routing-callback assertions and rename
  the two observable tests to `keeps the desktop secondary pane open after
  Contents selection` and `closes the mobile secondary sheet after Contents
  selection`.

## Documentation Cutover

- `workspace.md`: add the generic owner contract now misplaced under reader
  pane history: push records the current visit and clears Forward; replace
  changes the current visit href without changing its id or either stack;
  Back/Forward traverse visit occurrences;
  feature owners choose the operation.
- `reader-implementation.md`: change the overview, Contents navigation,
  progress/URL paragraph, pane-history mapping, and EPUB active-section URL
  statement. Move generic history mechanics to `workspace.md`; retain the
  caller-owned hash-consumption/repair, restore-order, and cursor-precedence
  rules. Consuming a target hash explicitly replaces with `pathname + search`;
  coarse-query repair preserves unrelated hashes.
- `reader-design-rationale.md`: replace active-section-history claims with
  addressable reader state plus structural Back/Forward rationale.
- `reader-progress-continuity-hard-cutover.md`: edit only the live Back/Forward
  target row, section 7's after-mount sentence, AC14's live-history tail, and the
  real-stack `live history` test description. Leave AC10's no-write echo and all
  repair, precedence, and layered-restore clauses intact.
- No architecture document changes.

## File Plan

Change:

- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx`
- `apps/web/src/lib/reader/readerLocationHref.ts`
- `apps/web/src/lib/reader/readerLocationHref.test.ts`
- `apps/web/src/lib/panes/paneIdentity.test.ts`
- `apps/web/src/lib/workspace/store.test.tsx`
- `e2e/tests/reader-progress-continuity.spec.ts`
- `docs/modules/workspace.md`
- `docs/modules/reader-implementation.md`
- `docs/modules/reader-design-rationale.md`
- `docs/cutovers/reader-progress-continuity-hard-cutover.md`

Do not change `ReaderContentsNav`, `WorkspaceHost.tsx`, `paneRuntime.tsx`,
`store.tsx`, workspace transition/schema/persistence code, route identity,
`useReaderProgress.ts`, backend code, or migrations.

## Implementation Order

1. Replace the contradictory real-stack journey with the red target behavior;
   add owner-layer budget coverage and migrate touched component assertions to
   user-visible outcomes.
2. Add `replaceReaderLocation` and cut all five location writes to it.
3. Remove the dead builder field, phantom fixture, and obsolete push assertions.
4. Apply the exact documentation cutover above.
5. Run targeted gates and deploy the single cutover.

## Acceptance Criteria

- AC1: From a seeded non-media structural origin, at least 13 EPUB section
  changes—by ping-ponging across the seeded three-chapter fixture—leave pane
  Back enabled for that origin; one Back reaches it.
- AC2: In the non-media-origin journey, after the chapter-three cursor reaches
  the server and its cursor-bearing PUTs quiesce, Back reaches the origin and
  Forward remounts the media rendering chapter three. The assertion is rendered
  content, not `?loc`; Positioned precedence may repair the URL to bare
  `/media/{id}`.
- AC3: Previous, Next, selector, Contents, same-book links, and cross-fragment
  apparatus/highlight/embed activation owned by the reader do not add
  pane-history entries. At the 48-entry workspace boundary, repeated reader
  replacements leave every history stack unchanged and evict nothing.
- AC4: While the reader remains mounted, every branch that publishes a reader
  location href replaces the active href with its latest coarse target without
  remounting. Focus-only branches publish none. After the AC2 Forward remount,
  normal cursor precedence and URL repair apply.
- AC5: Raw note/resource and global launcher/open-pane activations retain their
  existing push/new-pane/dedupe behavior, including same-media destinations;
  no resource-equality inference or fabricated predecessor is introduced.
- AC6: Traversal emits no new cursor-bearing write or revision beyond flushing
  genuine dirty input that predates Back. The E2E tracks cursor-bearing
  `PUT /api/media/{id}/reader-state` requests, waits for zero in flight and a
  quiet window longer than the 500 ms save debounce, then records write count
  and revision. Repeating that wait after Back/Forward leaves both unchanged;
  later genuine input persists.
- AC7: Direct media deep links preserve the existing cursor/query precedence
  without inventing an origin.
- AC8: Existing workspace coverage proves Back/Forward remains pane-isolated.
- AC9: Desktop and mobile Contents use replace; mobile still closes its sheet
  and desktop still leaves its secondary pane open.
- AC10: No old behavior flag, compatibility path, session-history migration, or
  contradictory current documentation remains. Pre-cutover stored stacks are
  unsupported data, not an automated migration acceptance target.

| Proof owner | Acceptance |
|---|---|
| `reader-progress-continuity.spec.ts` | AC1, AC2, representative AC3, AC4, AC6, AC7, and routing half of AC9; observe cursor PUT completion/quiescence before Back and assert rendered section after Forward |
| `MediaPaneBody.test.tsx` | AC9 user-visible surface behavior; remove the obsolete push-spy assertions, keep desktop secondary open and close the mobile sheet |
| `store.test.tsx` and existing workspace tests | AC3 12/48-budget invariance, AC5 activation semantics, AC8 isolation |
| `readerLocationHref.test.ts`, `paneIdentity.test.ts` | AC4/AC7 URL construction, repair, and live route identity fixtures |
| Source/doc negative audit | all five AC3/AC9 location owners use one seam; AC10 has no obsolete contract |

## Verification

```sh
make check-front
cd apps/web && bun run test:unit -- readerLocationHref paneIdentity
cd apps/web && bun run test:browser -- MediaPaneBody store
make test-e2e PLAYWRIGHT_ARGS='tests/reader-progress-continuity.spec.ts tests/workspace-history.spec.ts --project=chromium'
```

Review audit:

```sh
rg -n 'buildReaderLocationHref\(' 'apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx'
rg -n 'replaceReaderLocation\(' 'apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx'
rg -n 'paneRouterPush' 'apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx'
```

The first has exactly one call, inside the seam. Manually inspect the five named
owners through the second search and classify every remaining push from the
third as generic same-pane activation. No new navigation abstraction or stale
reader-section push contract remains.

## Final State

Pane history is a compact story of visited destinations. Reader location stays
URL-addressable and durable without becoming traversal noise. The existing
workspace engine executes history; the reader supplies the correct semantics.
