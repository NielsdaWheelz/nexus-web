# Mobile Nexus Vertical Command List Hard Cutover

**Status:** IMPLEMENTED · 2026-08-26

**Type:** hard cutover · mobile presentation · audit-driven shell closure · 80/20 slice

**Questions requiring an answer:** none.

This specification interprets **Do with query replaces Quick Actions** as one
shared section role and row treatment. Typed Results remain first; **Do with
query** follows them. Desktop behavior and appearance remain unchanged.

Follow [cleanliness](../rules/cleanliness.md),
[simplicity](../rules/simplicity.md), [boundaries](../rules/boundaries.md),
[frontend](../rules/frontend.md), [testing](../rules/testing.md), and the
authoritative [Nexus testing standards](../local-rules/testing-standards.md).

## Decision

Replace every mobile Nexus command rail with one sectioned vertical list.

> Categories are landmarks. Commands are rows. Search is the direct route.

Keep the current categories, caps, ranking, one-tap primary actions, search
focus, Back behavior, nested-page restoration, and sibling `ActionMenu`.
Remove the layout-policy API that permits rails. Reuse `QuickActions` for the
query-aware **Do with query** section; delete `QueryActions` as a distinct
section identity.

This document supersedes only the compact-rail,
`PinnedBelowInput`, Query-Actions placement, and corresponding capability-shape
clauses in [Nexus Intent Router Hard Cutover](nexus-intent-router-hard-cutover.md)
and [App navigation](../modules/app-navigation.md). Their remaining contracts
stay authoritative.

## Goals

1. Give mobile Nexus one natural vertical scroll axis.
2. Preserve every current root capability at one tap; add no disclosure step.
3. Reuse the canonical Nexus row, action menu, full-screen task, and controller.
4. Make typed Results primary while retaining all five query actions.
5. Preserve query and active-entry restoration; add no scroll-position state.
6. Keep desktop Nexus visually and behaviorally unchanged.
7. Delete every rail/layout variant, style, test expectation, and stale clause.
8. Prove one observable contract at each changed ownership boundary, then stop.

## Scope Lock

In scope:

- shared `NexusGroup`/section API simplification;
- blank and typed projection group identity/order;
- mobile Root group structure and vertical presentation;
- desktop renderer cleanup required by the shared API removal;
- content-quality rules for all Root section producers;
- focused unit, real-Chromium, existing-journey, and physical WebView evidence;
- the minimum generic Android Back and visual-evidence repairs required by that
  physical WebView evidence;
- current Nexus module/cutover documentation and residue deletion.

Non-goals:

- desktop redesign;
- section jump, category picker, tabs, chips, accordion, drill-down, or pager;
- favorites, pinning, hiding, reordering, personalization, telemetry, or usage
  learning;
- search, ranking, provider, intent grammar, command, target, or dispatch
  redesign;
- exact pixel scroll-offset restoration;
- sticky section headers, new animation, haptics, or gesture navigation;
- new row, menu, modal, design-system, command-palette, or carousel primitive;
- direct reuse of `NavRail` or `ResourceRow` semantics;
- backend, API, database, persistence, iOS-native, Android capability/wire
  schema, or release changes;
- a palette-specific native bridge, JavaScript interface, history schema, or
  native knowledge of Nexus state;
- broad ARIA refactoring, broad screenshot regression, or a new journey.

No feature flag, compatibility branch, fallback, alias, dual schema, or staged
old/new renderer is authorized.

## Target Behavior

### Projection states

| State | Ordered groups | Contract |
| --- | --- | --- |
| Blank mobile | Open, Quick Actions, optional Continue, Recent, Places | Current membership, caps, omission of empty groups, and labels; all groups are vertical |
| Blank desktop | Open, optional Continue, Recent, Quick Actions | Existing grid and behavior unchanged |
| Non-URL query | Results, Quick Actions labelled **Do with query** | At most eight Results; five query actions remain outside that cap |
| No owned Results | Quick Actions labelled **Do with query** plus the settled no-results message | Action rows do not count as Results |
| Bare URL | Results only | Existing exact Import URL result; no Do with query group |

For a nonblank query, static blank Quick Actions and query-aware Quick Actions
never coexist. The shared Quick Actions section contains, in current order:

1. Ask Nexus about the query;
2. Add the query to Today;
3. Browse for the query;
4. Create from the query;
5. See all results for the query.

Selection remains required. Availability, target materialization, Daily Page
handoff, Browse/Create nested pages, and action identity do not change.

### Mobile structure

```text
MobileFullScreenTask
└─ Nexus Root
   ├─ header: Nexus, Account, Done
   ├─ search: Find anything…
   └─ one content scroller
      ├─ section heading
      │  └─ full-width SwitchboardRow list
      └─ next section…
```

- Header and search stay outside the sole content scroller.
- Every group renders as `<section aria-labelledby>`, heading, `<ul>`, and the
  existing `SwitchboardRow` `<li>`.
- Headings are quiet, noninteractive landmarks and scroll with content.
- Rows are full width with the existing icon, primary label, factual metadata,
  state, snippet, shortcut, active accent, and sibling More button.
- Primary and More targets remain at least 48 px. Labels grow or wrap under text
  scaling; identity never depends on clipped text.
- Group surfaces use the existing vertical border/divider treatment. No row is
  projected as an individual card.
- Root introduces no horizontal overflow, snap point, hidden horizontal
  scrollbar, or horizontal gesture.
- Up/Down continues through one flattened entry order; Enter invokes the active
  primary action. Active rows scroll vertically into view.
- A pointer tap on a primary row invokes that row directly. No category or
  expansion tap is inserted.

### Restoration and dismissal

Keep `NexusReturnPoint` exactly as query plus active `NexusEntryKey`. Returning
from Choose Create, Choose Browse, Manage Tabs, Add, or recovery restores both.
The active row uses nearest vertical scrolling; exact scroll pixels are not
state.

Back/Escape remains:

1. nested page → exact Root query and active identity;
2. nonblank Root → clear query and retain input focus;
3. blank Root → dismiss and apply the existing focus-owner contract.

Android Back keeps native WebView traversal first when it is available. When
System WebView does not expose same-document history through `canGoBack()`, the
shell dispatches one cancelable Escape key event to the renderer's existing
top-owner arbiter. A prevented event consumes Back; an unhandled or failed
arbitration rechecks native history and then delegates ordinary Activity Back.
No Nexus marker or renderer state crosses the native boundary.

## Final Architecture

```text
command / destination / search owners
                 │ NexusEntry
                 ▼
       composeNexusProjection
   section identity, label, order, caps
          ┌────────┴────────┐
          ▼                 ▼
 desktop grid renderer   mobile vertical renderer
          │                 │
          └─── canonical actions ───┘
                   │
          target materializer / dispatch
```

Ownership remains:

| Concern | Sole owner |
| --- | --- |
| Command identity, aliases, targets, shortcuts | `apps/web/src/lib/nexus/commands.ts` and `intent.ts` |
| Section membership, labels, order, caps, query-action composition | `apps/web/src/lib/nexus/results.ts` |
| Ranking and progressive stability | `apps/web/src/lib/nexus/ranking.ts` and `useNexusController.ts` |
| Shared semantic contract | `apps/web/src/lib/nexus/model.ts` |
| Desktop grid semantics | `apps/web/src/components/nexus/desktop/` |
| Mobile Root structure and scroll | `apps/web/src/components/switchboard/SwitchboardSearch.tsx` and `switchboard.module.css` |
| Mobile row/action projection | `apps/web/src/components/switchboard/SwitchboardRow.tsx` over existing `components/ui/ActionMenu.tsx` |
| Modal, visual viewport, focus, Back lifecycle | existing `components/ui/MobileFullScreenTask.tsx` and `useNexusController.ts` |
| Target materialization and execution | existing Nexus/workspace dispatch owners |
| Native WebView/renderer Back arbitration | `apps/android/app/src/main/java/app/nexus/android/MainActivity.kt` |
| Authenticated physical capture integrity | `python/nexus_test_control/android_visual.py` |

Renderers receive ordered semantic groups. They do not regroup, rerank, hide,
or infer meaning from labels, IDs, icons, or target URLs.

## Capability And API Contract

Hard-replace the shared group shape with:

```ts
type NexusSectionId =
  | "Open"
  | "Continue"
  | "Recent"
  | "QuickActions"
  | "Places"
  | "Results";

interface NexusGroup {
  readonly id: NexusSectionId;
  readonly label: string;
  readonly entries: readonly NexusEntry[];
}

interface NexusProjection {
  readonly surface: "Desktop" | "Mobile";
  readonly groups: readonly NexusGroup[];
  readonly activeKey: NexusEntryKey | null;
}
```

Rules:

- Delete `QueryActions`; query-aware actions use `QuickActions`.
- Delete `NexusGroup.layout`; do not replace it with a one-value `Flow` enum,
  renderer hint, optional field, or CSS-oriented variant.
- `composeNexusProjection` remains the sole group membership/order/cap owner.
- `NexusEntry`, `NexusEntryKey`, action availability, command IDs, targets,
  activation kinds, and return-point schema remain unchanged.
- Group labels are owner-authored presentation. Identity never derives from a
  label.
- The renderer derives result count and no-results state from the `Results`
  group only, never from total visible rows.
- Every registered command remains reachable from desktop and mobile.
- This is an internal TypeScript hard cut; there is no persisted or wire schema.

## Content Design Contract

Content design stays with each existing semantic producer; there is no new
content service or generic schema. The implementation owner acts as content
designer for each producer it touches and reviews its output against this
table.

| Feature | Content-design owner | Good content |
| --- | --- | --- |
| Open / Continue / Recent | pane, player, history, and result projectors | Canonical object label; factual type/source/open state only; no invented summary |
| Blank Quick Actions | command registry plus Today destination | Stable, verb-first labels; current icons; no explanatory card copy |
| Do with query | intent/projection owner | Clear verb first; trimmed query exactly once in the label; no repeated query metadata; owner-supplied unavailable reason |
| Places | destination registry | Canonical destination noun and icon; no parallel mobile label map |
| Results | each result adapter | Canonical primary label, then factual type/owner/state, then an existing matched excerpt |

Universal rubric:

- visible label and accessible name begin with the same words;
- every row is distinguishable without color or truncation;
- action labels are verbs; objects and destinations use canonical nouns;
- metadata adds a fact and never restates the heading or primary label;
- section headings classify rows once; rows do not repeat their category;
- unavailable copy says why and remains owned by the capability that refused;
- no AI-generated summary, confidence, recommendation, or promotional copy is
  introduced by this cutover.

## Hard-Cut Residue Gate

Delete, do not deprecate:

- `NexusSectionId` member `QueryActions`;
- `NexusGroup.layout`, `CompactRail`, and `PinnedBelowInput`;
- mobile `groupClassName`, `pinnedGroups`, `scrollingGroups`, and `compact` prop;
- `data-compact`, `.compactRail`, `.pinnedGroup`, rail snap/overflow/card rules;
- desktop `groupLayoutClass`, `.compactRailGroup`, and `.pinnedGroup`;
- tests that assert the removed identity, layout modes, or pinned placement;
- normative prose that still describes compact rails or Query Actions before
  mobile Results.

Do not retain a source-grep tombstone test. Perform an implementation-time
residue audit, then let types, behavior proof, and current docs own the final
contract.

## Non-Overlapping Work Packages

| Package | Owned files | Exit condition |
| --- | --- | --- |
| A — semantic projection | `apps/web/src/lib/nexus/model.ts`, `results.ts`, `rankingProjection.unit.test.ts` | Target group order/label/caps are green; no layout API remains |
| B — mobile presentation | `apps/web/src/components/switchboard/SwitchboardSearch.tsx`, `SwitchboardRow.tsx`, `switchboard.module.css`, mobile cases in `components/nexus/Nexus.browser.test.tsx` | One vertical scroller, full-width rows, one-tap actions, restoration, no x-overflow |
| C — desktop adapter | `apps/web/src/components/nexus/desktop/DesktopNexusResults.tsx`, `desktopNexus.module.css`, only necessary cases in `DesktopNexusSelection.browser.test.tsx` | Shared API compiles; desktop grid/order/actions are unchanged |
| D — contract and closeout | this spec, `docs/cutovers/nexus-intent-router-hard-cutover.md`, `docs/modules/app-navigation.md`, `testdata/proofs.json` | Superseded prose removed, journey routing complete, residue audit clean, evidence classified |
| E — native Back fallback | `MainActivity.kt`, focused `MainActivityBackNavigationTest.kt` | A real WebView consumes renderer-owned Back once and delegates unhandled or exceptional arbitration without crashing |
| F — physical-proof integrity | `android_visual.py` and its kernel test | PASS requires the authenticated owned-origin WebView and resumed Nexus Activity on both sides of capture |
| G — encountered build residue | generated `apps/android/app/src/main/assets/nexus-offline/**`; identifier-only repair in the pre-existing outbox instrumentation test | Canonical generator and Android verifier agree; the Android test APK dexes without changing test behavior |

Packages do not edit one another's files. A defines the target API; B and C
adapt independently to it. A, B, and C are one atomic Green integration, not
separately mergeable commits: removing the shared layout field intentionally
breaks both renderers until their adapters land. D updates normative docs only
after the executable contract is green. Login and Android download entry
surfaces remain untouched. E–G are audit-driven closure, not new product scope:
physical acceptance exposed a real fallback defect, a false-positive capture,
and stale committed generated assets that prevented a trustworthy APK build.

## Red / Green / Refactor

Risk score: **medium**. This is browser interaction/layout plus one bounded
native Back fallback, with no persistence, irreversibility, provider, protocol,
or release change. Real Chromium owns presentation; focused instrumentation and
physical WebView evidence own the shell boundary.

1. **Baseline:** on an implementation branch, run `./scripts/test confidence`
   and record pre-existing failures.
2. **Red:** change independent-oracle expectations first:
   - projection expects typed `[Results, QuickActions]`, `Do with query`, and
     the existing caps;
   - mobile Root expects one vertical stream and no horizontal overflow;
   - nested return expects the exact query and active row.
   - the Android fallback expects renderer-owned Back to be consumed before an
     unhandled Back exits;
   - physical capture expects the Nexus Activity, not a stale task record, to
     be globally resumed.
   Type checking, not a runtime structure assertion, owns removal of the layout
   field and every stale consumer.
   Capture the natural parent failure. For restoration proof, use a temporary
   wrong `restoreReturnPoint` result if a natural red is unavailable; remove it
   before Green.
3. **Green:** implement A, B, and C with the minimum existing primitives. Run
   owner-qualified proof while diagnosing; once all three integrate, run
   `./scripts/test changed <all exact A/B/C paths>` for the first green verdict.
4. **Refactor:** delete the residue list, simplify counts/group rendering,
   update docs, and run the same focused proofs again. Add no abstraction whose
   second caller does not exist.
5. **Integration:** run `./scripts/test confidence`, then `./scripts/test pr`
   before merge. The existing proof registry may select
   `nexus-search-open-restore`; run it as routed nonregression evidence, but add
   no new journey and do not duplicate its workspace contract. Add the three
   mobile renderer owner paths to that existing proof's source globs.
6. **Android focus:** compile the main and instrumentation Kotlin sources; run
   only `MainActivityBackNavigationTest` on the authorized wireless device.
   Verify the offline bundle with its canonical generator and Gradle verifier.
7. **Physical:** run `./scripts/test android-visual --sha <exact-commit-sha>
   --path / --device primary`, then perform the operator checks below.

Do not run `full`, `nightly`, `release`, hosted-provider, database, or broad
native instrumentation solely for this cutover. The one focused Back scenario
above is the explicit shell-boundary proof; otherwise follow typed selection.

## Proof And Acceptance Matrix

One primary proof owns each changed boundary.

| Boundary / risk | Primary proof | Required observable acceptance |
| --- | --- | --- |
| Projection identity/order/caps | `rankingProjection.unit.test.ts` | Blank orders unchanged; typed order is Results then Quick Actions; five actions remain outside the eight-result cap; URL has no action group |
| Mobile layout/content reachability | mobile scenario in `Nexus.browser.test.tsx` | At 390 px, 320 px, short landscape, and text scaling: labeled sections, full-width rows, one content scroller, no Root x-overflow, every row reachable |
| Mobile input/action semantics | same owner, separate coherent scenario | Search focus; Up/Down/Enter; primary and More remain usable in one tap; unavailable action remains actionable and explained |
| Nested restoration/Back | mobile scenario in `Nexus.browser.test.tsx` | Enter a query-owned nested page, return, and observe exact query plus active row; next Back clears; next Back dismisses and restores focus |
| Desktop nonregression | existing `DesktopNexusSelection.browser.test.tsx` plus projection proof | Grid/combobox, Results-first order, action cells, keyboard vocabulary, and visible styling unchanged |
| Browser/server/workspace wiring | existing routed `nexus-search-open-restore` journey | Existing real-stack open/persist/restore behavior remains green; no new cases added |
| Native Back fallback | focused `MainActivityBackNavigationTest` on a real WebView | With native history empty, a renderer Escape owner consumes one Back; unhandled or exceptional arbitration delegates without a crash |
| Physical-capture truth | `test_android_visual.py` plus `android-visual` artifact | Stale task history or a background Nexus Activity cannot produce PASS; capture is bracketed by authenticated-session and resumed-Activity checks |
| Android WebView composition | `android-visual` artifact plus operator review | Portrait and landscape; keyboard open; long query; bottom and final rows reachable; no sideways Root motion; Android Back sequence; TalkBack reading order; gesture and three-button navigation |

The currently connected wireless device is an SM-S906W and is suitable for the
explicit `android-visual` review. Resolve and record its serial at execution
time; do not commit it. Wireless ADB is **not** `android-device`, signed-release,
or USB-attested evidence and must never be reported as such. The bounded debug
shell proof does not require or imply those stronger lanes.

Screenshots are reviewed evidence for geometry, not pixel-golden tests. Report
Chromium, journey, wireless-device, and operator evidence separately. A missing
device run is `not_run`, never a browser pass.

## Acceptance Criteria

The cutover is complete only when all are true:

1. Mobile blank Root shows the five current semantic sections in current order,
   omitting only empty Continue/Recent/Open groups as already specified.
2. Every mobile Root item remains directly reachable and its primary action is
   one tap; no category disclosure exists.
3. Nonblank text shows up to eight Results first and one vertical **Do with
   query** Quick Actions section second.
4. Static Quick Actions and Do with query never coexist. Bare URL shows neither
   blank nor query-aware Quick Actions.
5. Query actions do not suppress the settled no-results message.
6. Mobile Root has one content scroll axis and no horizontal overflow at the
   accepted Chromium/device geometries.
7. Rows preserve 48 px targets, label legibility, factual metadata, active
   identity, unavailable feedback, and sibling `ActionMenu` behavior.
8. Search focus, IME handling, Up/Down/Enter, Back/Escape, one-tap pointer
   activation, and current performance marks remain intact.
9. Nested return restores exact query and active key; no scroll-offset state is
   added.
10. Desktop visual structure, order, keyboard/grid semantics, actions, and
    performance behavior are unchanged.
11. No backend, persisted, wire, provider, database, palette-specific native,
    or release contract changes; the generic shell knows only whether Escape
    was handled.
12. Every proof above has an independent oracle, required red/sensitivity
    evidence, diagnostic failure output, and a named public `./scripts/test`
    lane.
13. The hard-cut residue gate is empty; current owner docs describe only the
    final state.
14. `changed`, `confidence`, `pr`, and Android visual evidence are reported at
    their actual levels; no unrun gate is claimed.

## Completion Invariant

There is one semantic Nexus projection, one Quick Actions section role, one
mobile vertical Root renderer, and one canonical row/action path. Desktop and
mobile may differ in geometry, never in command meaning, availability, target,
or restoration. If a horizontal command rail, layout hint, alternate query
section, hidden category path, or compatibility branch survives, the cutover is
incomplete.
