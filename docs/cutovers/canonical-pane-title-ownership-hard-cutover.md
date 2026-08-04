# Canonical Pane Title Ownership Hard Cutover

**Status:** APPROVED SPEC · 2026-08-03

**Type:** Atomic hard cutover — no legacy path, fallback, compatibility shim,
dual API, feature flag, or partial migration

**Scope:** Authenticated primary-pane identity on desktop and mobile

Follow [`docs/rules/`](../rules/index.md) and
[`docs/local-rules/`](../local-rules/index.md), especially cleanliness,
simplicity, boundaries, frontend, tagged unions, and testing.

## Questions and locked decisions

Open questions: none.

- Pane chrome is the sole visible owner of app-generated route identity.
- The pane runtime label is the canonical title source.
- Every pane-header primary title uses one visual and semantic treatment.
- Exact detail identity is primary; section, count, date, and credits are support.
- Authored document titles remain content and are not mistaken for app furniture.
- Keep the current 60px frame, fixed control rails, mobile retreat, and themes.
- Cut the old model atomically; do not preserve aliases or transitional branches.

## Decision and final state

Render one visible app-owned title per pane, in the primary header bar. That
title is the pane's sole route-level `<h1>`. Scrolling body content begins at
`<h2>` and contains no duplicate route opener.

```text
pane runtime label ---------------- canonical exact title
route header contract ------------- kind, context, pending label
accepted route-key publication ---- metadata OR resource status/credits
                 |
                 v
         resolvePaneHeaderModel
                 |
                 v
          PaneHeaderIdentity ------- one title <h1>, zero/one support line
            |              |
            v              v
      SurfaceHeader   MobilePaneBar

same model -> PaneShell landmark name
active pane label -> browser document title
```

`PaneShell` remains the chrome composition owner. Pane bodies publish exact
labels and typed facts; they never render or style route identity.

This specification supersedes the body-`<h1>`, `RunningHead`, `SectionOpener`,
title-folio, and section/resource typography clauses in
[`running-journal-hard-cutover.md`](running-journal-hard-cutover.md),
[`pane-header-identity-hard-cutover.md`](pane-header-identity-hard-cutover.md),
[`pane-chrome-frame-hard-cutover.md`](pane-chrome-frame-hard-cutover.md), and
[`lectern-editorial-surface-hard-cutover.md`](lectern-editorial-surface-hard-cutover.md).
Their unrelated contracts remain authoritative.

## Goals

1. Recover mobile and narrow-pane body space.
2. Give every pane one exact, persistent, equally legible identity.
3. Collapse title derivation, rendering, semantics, and typography to one path.
4. Preserve authored content, controls, focus, loading, and navigation behavior.
5. Delete superseded primitives, APIs, styles, tests, and prose atomically.

## Scope

In scope:

- Route-header, header-publication, and resolved-header types.
- Desktop/mobile title projection and typography.
- Dynamic detail labels, supporting metadata, status, and credits.
- Removal of body route openers and relocation of their useful content.
- Pane landmark naming, active browser title, and return-focus fallback.
- Authenticated pane heading-outline repair and direct proof.
- Current normative documentation made stale by the cut.

No persisted, transport, backend, database, or native schema changes exist.

## Non-goals

- No pane-frame, width, resizing, strip, secondary-pane, or route redesign.
- No adaptive large-title collapse, scroll-reactive type, glass, blur, or animation.
- No title editing in chrome, title-detail sheet, breadcrumbs, or disambiguation UI.
- No action-priority redesign, command registry, analytics, or configurability.
- No reader, player, collection-row, Stats-domain, Oracle-domain, or editor behavior change.
- No heading changes outside authenticated primary panes; `MobileNowPlaying` is excluded.

## Target behavior

| Surface | Primary title | Support | Body result |
| --- | --- | --- | --- |
| Section index | Exact label, e.g. `Lectern` | Count/date when present | No opener |
| Section detail | Exact entity name | Section · count/date | No duplicate title |
| Settings child | `Account`, `Appearance`, etc. | `Settings` | No opener |
| Conversation | Exact conversation title | `Chats` | No body route title |
| Resource | Exact work/page/artifact title | Credits when present | Document content only |
| Pending/failed | Non-empty route label | Typed pending/status state | No body fallback title |
| Authored document | Pane title remains in chrome | Existing support | Authored/editable title remains |

The primary title uses one shared token treatment: `--text-base`, semibold,
`--ink`, tight leading, start-aligned. Support uses `--text-xs`, regular,
`--ink-muted`. `projection` may cap visible credits; it never changes title
typography or semantics.

Titles stay one line and ellipsize before controls move. Full text remains in
the DOM, accessible name, and native `title` disclosure where supported. Do not
add a second stored short title.

## Capability contract and API design

### Canonical title

`PaneRuntime`'s label is the only title value. Route `defaultLabel` supplies
first paint; `useSetPaneLabel` publishes resolved dynamic identity. Pane strip,
header, landmark, and browser projections consume that value.

Rules:

- Labels are non-empty user-facing identity, never tool-only placeholders after load.
- Dynamic bodies publish the exact entity title in ready and terminal states.
- Header publications contain no `title` field or title override.
- Truncation and browser formatting are projection concerns, not stored state.
- Existing resource-key and route-key lifecycle fencing remains exact.

### Route declaration

Replace the old contract completely:

```ts
export type PaneRouteHeaderContract =
  | {
      readonly kind: "Section";
      readonly destinationId: DestinationId;
      readonly context: "None" | "Destination";
    }
  | {
      readonly kind: "Resource";
      readonly pendingLabel: string;
    };
```

- Delete `defaultFolio`; do not map or alias it.
- Section indices declare `context: "None"`.
- Details and subpages declare `context: "Destination"` when taxonomy aids
  orientation. The resolver omits context when it equals the exact title.
- Resource pending labels describe loading, not persisted identity.

### Header publication

```ts
export type PaneHeaderMeta =
  | { readonly kind: "None" }
  | { readonly kind: "Pending" }
  | { readonly kind: "Count"; readonly value: number; readonly unit: string }
  | { readonly kind: "Date"; readonly iso: string };

export type PaneResourceHeaderPublication =
  | {
      readonly status: "Ready";
      readonly creditGroups: readonly PaneHeaderCreditGroup[];
    }
  | { readonly status: "Unavailable" }
  | { readonly status: "Failed" };

export type PaneHeaderPublication =
  | { readonly kind: "Section"; readonly meta: PaneHeaderMeta }
  | {
      readonly kind: "Resource";
      readonly resource: PaneResourceHeaderPublication;
    };
```

- This closed shape replaces lowercase variants, `folio`, `pending`, and every
  resource publication `title`.
- `Count` and `Date` retain the existing locale formatting and pluralization.
- `Count` is a non-negative integer with a non-empty unit; `Date` is valid
  date-only ISO. Credit groups retain their current invariants. Violations defect.
- There is no free-form metadata or React-node title/support API.
- Omitted `header` publication means route defaults: no section metadata or a
  pending resource state.
- `usePanePrimaryChrome` remains the sole publication hook; add no title hook.

### Resolved model

```ts
export type PaneHeaderModel =
  | {
      readonly kind: "Section";
      readonly title: string;
      readonly titlePending: boolean;
      readonly context: Presence<string>;
      readonly meta: PaneHeaderMeta;
    }
  | {
      readonly kind: "Resource";
      readonly title: string;
      readonly resource: PaneResourceHeaderState;
    };
```

`PaneResourceHeaderState` is the publication state plus
`{ status: "Pending"; accessibleLabel: string }`. Resolution accepts only the
current `routeKey`, validates non-empty trusted values once, and exhaustively
rejects kind mismatches. No normalizer accepts the old shape.

## Composition and ownership rules

- **Title state:** pane runtime/store owns the label lifecycle; bodies call
  `useSetPaneLabel` only.
- **Header facts:** bodies publish metadata, status, credits, actions, Search,
  instruments, menu, and refresh through existing typed capabilities.
- **Resolution:** `paneHeaderModel.ts` exclusively combines route, label, and
  accepted publication.
- **Projection:** `PaneHeaderIdentity` directly renders the shared `<h1>` and
  support line. It owns credit projection and metadata formatting.
- **Placement:** `SurfaceHeader` and `MobilePaneBar` place the same identity;
  neither derives title data.
- **Landmark:** `PaneShell` keeps its stable local `aria-labelledby` node. Its
  text is exact title plus optional context, never volatile count/date.
- **Browser:** `WorkspaceHost` sets the active label as `Title · Nexus` and
  restores `Nexus` only when no active pane exists. Inactive panes never write it.
- **Headings:** route identity is `<h1>` in chrome; body sections start at `<h2>`.
  Imported reader offsets and separate iframe-document outlines remain intact.
- **Loading:** pending identity is non-empty and `aria-busy`; async replacement
  is not an `aria-live` announcement.
- **Persistence:** workspace persistence keeps existing labels/visits only; no
  header publication or React body is persisted.
- **Responsive composition:** desktop may expose one `<h1>` per mounted pane;
  mobile exposes only the active pane projection. IDs remain pane-scoped.

## Opener-content migration

- Browse standfirst -> `PaneSurface.brief`.
- New Chat and simple Podcast navigation -> existing typed header actions.
- Create Library form -> in-content `PaneSurface.toolbar` or brief composition.
- State/error titles -> canonical pane label plus existing state component copy.
- Library, Podcast, Author, Settings, conversation, Browse Preview, Atlas,
  Stats, and Oracle exact identity must reach chrome before body title removal.
- Editable Page title, imported document headings, transcripts, and generated
  iframe-document headings remain authored content.

## Reuse, consolidation, and deletion

Reuse:

- `PaneRuntime` label lifecycle, `useSetPaneLabel`, and title hints.
- `PaneShell`, `SurfaceHeader`, `MobilePaneBar`, and `PaneHeaderIdentity`.
- `PaneSurface.brief`, `PaneSurface.toolbar`, `PaneToolbar`.
- `ActionDescriptor`, `ActionBar`, `ActionMenu`, focus and landmark helpers.

Consolidate all identity markup and CSS into `PaneHeaderIdentity`. Move the
earned Credits implementation there; add no sibling title primitive.

Delete in the implementation commit:

- `RunningHead.tsx` and `.module.css`.
- `ResourceHead.tsx` and `.module.css`.
- `SectionOpener.tsx` and `.module.css`.
- `folio.ts`, `Folio`, `formatFolio`, and title-folio behavior.
- `PaneSurface.opener`, `CollectionView.opener`, wrappers, styles, and callers.
- `data-pane-return-heading`; return fallback becomes the stable pane landmark.
- Duplicate publication titles, lowercase old variants, `defaultFolio`, tests,
  comments, and current prose for the superseded model.
- Any import, selector, helper, branch, fixture, or export made unreachable.

Do not retain aliases, deprecated exports, fallback CSS, hidden duplicate
headings, old/new decoders, tombstone tests, or source-grep guards.

## Files

| Concern | Final owner / affected files |
| --- | --- |
| Route contract | `apps/web/src/lib/panes/paneRouteModel.ts` |
| Publication contract/equality | `apps/web/src/lib/panes/paneHeaderModel.ts`, `panePublications.ts` |
| Canonical label API | `apps/web/src/lib/panes/paneRuntime.tsx` |
| Identity projection | `apps/web/src/components/ui/PaneHeaderIdentity.tsx`, `.module.css` |
| Desktop/mobile placement | `SurfaceHeader.tsx`, `MobilePaneBar.tsx` and existing CSS |
| Landmark/chrome composition | `apps/web/src/components/workspace/PaneShell.tsx` |
| Browser title | `apps/web/src/components/workspace/WorkspaceHost.tsx` |
| Body slots | `PaneSurface.tsx`, `.module.css`, `CollectionView.tsx` |
| Index consumers | Lectern, Browse/Preview, Conversations, Libraries, Notes, Podcasts, Search, Settings pane bodies |
| Detail consumers | Library, Podcast, Author, conversation, Atlas, Oracle, Stats, and Settings-child pane bodies |
| Delete | `RunningHead*`, `ResourceHead*`, `SectionOpener*`, `apps/web/src/lib/ui/folio.ts` |
| Browser proof | New colocated `PaneHeaderIdentity.browser.test.tsx`; existing `PaneShell.mobileChrome.browser.test.tsx` |
| Journey wiring | Extend `apps/web/e2e/journeys/nexus-search-open-restore.journey.spec.ts`; add no journey |
| Normative docs | `docs/architecture.md`, `docs/modules/workspace.md`, `docs/modules/app-navigation.md`, `docs/modules/reader-implementation.md`, affected current cutover specs |

No file outside these owners changes unless an acceptance criterion proves the
inventory incomplete. Do not touch backend, Android, persistence, or transport.

## Implementation order

1. Add failing real-Chromium behavior proof from this specification; record red.
2. Hard-cut route/publication/model types; migrate every producer until compile-clean.
3. Consolidate shared identity rendering and typography; delete old projections.
4. Move exact detail labels into chrome, relocate useful opener content, then
   delete body openers and repair body heading levels.
5. Cut return-focus and active-browser-title projections at their existing owners.
6. Delete residue, update normative docs, run focused proof and public gates.

These are build-order steps, never coexistence phases. Rollback is commit revert;
there is no runtime rollback path.

## Acceptance criteria

- [ ] Every authenticated pane renders one visible canonical app title in chrome.
- [ ] Every pane projection exposes exactly one route-level `<h1>` with full title.
- [ ] Lectern/media and section/resource title typography is structurally identical.
- [ ] Library, Podcast, Author, Settings, conversation, Browse Preview, Atlas,
  Oracle, and Stats preserve exact identity and useful support.
- [ ] No app-generated body route opener remains; authored document titles remain.
- [ ] Body heading outlines begin below the chrome `<h1>` and imported IDs/offsets survive.
- [ ] Pending, ready, unavailable, failed, and invalid states have non-empty identity.
- [ ] Stale publications cannot alter a newer route; kind/state matching is exhaustive.
- [ ] At 320px, 390px, narrow split, and 200% zoom, title truncates before fixed
  controls overlap or shrink; document horizontal overflow is zero.
- [ ] Desktop split panes and duplicate-resource panes retain pane-scoped IDs and headings.
- [ ] Keyboard return degrades to the pane landmark without a body heading;
  pointer navigation gains no focus movement.
- [ ] New Library, New Chat, Podcast actions, Browse brief, Search, Options,
  credits, refresh, and reader controls retain behavior and focus return.
- [ ] Active pane changes update `document.title`; inactive panes cannot race it.
- [ ] Study and Press use the same structure and existing semantic tokens.
- [ ] All named old APIs, files, styles, tests, comments, and current normative
  claims are absent; no compatibility path remains.
- [ ] No persisted/wire/backend/native schema or behavior changes.

## Required proof

Follow [`docs/local-rules/testing-standards.md`](../local-rules/testing-standards.md).

- Primary owner: real-Chromium component proof using semantic headings,
  landmarks, text, keyboard, focus, and actual bounding/overflow behavior.
- Cover section index/detail, Settings child, conversation, resource pending/
  ready/failed, long/RTL title, duplicate panes, and desktop/mobile replacement.
- Demonstrate sensitivity against the old non-heading section chrome and body
  duplicate before deleting legacy proof.
- Extend the existing Nexus open/restore journey only for real workspace wiring,
  active browser title, and focus handoff. Do not duplicate component edge cases.
- Manually review selected 320px, 390px, narrow split, and 1440px screenshots in
  Study and Press at normal and 200% text scale, plus forced colors.
- Use `./scripts/test changed ...`, then the smallest `confidence`/`pr` lane
  selected by the typed registry. Direct runners are debugging evidence only.

One-time residue audit after implementation:

```sh
rg -n 'RunningHead|ResourceHead|SectionOpener|defaultFolio|data-pane-return-heading' \
  apps/web/src
rg -n 'defaultFolio|\bfolio\b|kind: "(section|resource)"|status: "(ready|pending|unavailable|failed)"' \
  apps/web/src/lib/panes/paneHeaderModel.ts \
  apps/web/src/lib/panes/paneRouteModel.ts \
  apps/web/src/lib/panes/panePublications.ts
rg -n 'opener\?: ReactNode|opener=\{|styles\.opener' \
  apps/web/src/components/ui/PaneSurface.tsx \
  apps/web/src/components/collections/CollectionView.tsx \
  'apps/web/src/app/(authenticated)'
rg -n 'RunningHead|ResourceHead|SectionOpener|defaultFolio|data-pane-return-heading' \
  docs/architecture.md docs/modules docs/cutovers \
  --glob '!canonical-pane-title-ownership-hard-cutover.md'
```

The first three commands return no result. Classify historical cutover
references from the fourth deliberately; current architecture contains no
superseded claim. Delete temporary residue checks after the cut is complete.
