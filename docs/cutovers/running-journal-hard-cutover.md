# The Running Journal — running heads and section openers — Hard Cutover

**Status:** Spec · Rev 1 · 2026-07-07
**Type:** Hard cutover — no legacy code, no fallbacks, no compat shims, no flags-for-old-behavior. Frontend-only.

## One-line

Give every pane the furniture of a real periodical: a hairline **running head** in the chrome (section standing-head, small-caps, flush-left; a typed **folio** flush-right) and, on list surfaces, a Tschichold-asymmetric **section opener** (flush-left display line, one thin rule, generous air) at the top of the body — two new `PaneSurface`-kit citizens (`RunningHead`, `SectionOpener`), adopted across all collection surfaces in one cut, deleting the cramped chrome-title label and the free-form `meta` slot it leaned on.

---

## 0. Prerequisites (hard, no fallback)

- **P-1.** The collection-surface cutover is landed (it is — `docs/cutovers/collection-surface-hard-cutover.md`, Implemented 2026-06-19). Every row-shaped list surface already renders through `CollectionView` → `PaneSurface`. This cutover changes the *header/opener* layer only; it does not touch presenters, `CollectionRowView`, or the row grammar.
- **P-2.** The nav destination registry is the single source of navigation truth: `lib/navigation/destinations.ts` (`DESTINATIONS`) feeds `NAV_MODEL` (`components/appnav/navModel.ts:36`) by derivation. Standing heads derive from the same registry — no second list.
- **P-3.** The pane route model (`lib/panes/paneRouteModel.ts`, `PaneRouteId` union + `PANE_ROUTE_MODELS`) is the isomorphic route resolver. The route→section mapping is exhaustive over `PaneRouteId`.
- **P-4.** The chrome-override seam exists: `usePaneChromeOverride` (`components/workspace/PaneShell.tsx:97`) lets a body publish chrome slots without routing through the workspace store; `useSetPaneTitle` (`lib/panes/paneRuntime.tsx:448`) publishes the resolved dynamic title for tab identity.

> Rationale: this is a pure furniture cutover. No new storage, no new route, no new API, no worker job. Its value is a single owner for "sense of page" and the first real use of the display type ladder (`--text-display-1/2`), which exist in `app/globals.css:21-22` but are currently unused by any surface title.

---

## 1. Problem (grounded diagnosis)

### 1.1 The seed's "centered pane titles" is factually wrong — the real defect is worse

There is no centered title. `SurfaceHeader` (`components/ui/SurfaceHeader.tsx`) renders the pane title **flush-left** inside a 44px chrome bar (`SurfaceHeader.module.css:1-11`, `.title` at `:72-81`), at `font-size: var(--text-base)` (0.9375rem) `font-weight: var(--weight-semibold)`, truncated with `text-overflow: ellipsis`. The actual dashboard-itis is subtler and more corrosive:

- **The display type ladder is dead.** `--text-display-1: 2.5rem` and `--text-display-2: 3.5rem` (`globals.css:21-22`) are defined and used **nowhere**. Every surface — a six-book library, a 400-episode podcast, the whole Authors directory — announces itself with the same 0.9375rem chrome label. Nothing has a front page.
- **No folio, no running head, no continuity.** Panes carry no section standing-head and no live per-surface signal (count/date/what-you're-reading). The only "where am I" cue is the ellipsised chrome label; split two panes and neither has a sense of belonging to a section.
- **The header conflates navigation with identity.** `SurfaceHeader` owns back/forward (`:54-74`), the options menu (`:101-107`), *and* a free-form `title: ReactNode` (`:16`) plus a `subtitle` rendered `sr-only` (`:90-94`) and a free-form `meta: ReactNode` (`:19`). Identity and pane-runtime chrome are tangled in one component with no typed contract.
- **The folio's would-be data rides a free-form escape hatch.** The only per-surface signal today is the untyped `meta` chrome override — used by exactly one caller, the media reader (`media/[id]/MediaPaneBody.tsx:4840`, `meta: mediaHeaderMeta`). It is an unconstrained `ReactNode`, the classic slot that grows into dashboard chrome.

### 1.2 The list body opens with a toolbar, not a page

After the collection cutover, a list pane body is `CollectionView` → `PaneSurface` with a `toolbar` slot directly above the rows (`CollectionView.tsx:192-196`). There is no section opener: the surface has no grand entrance, no standfirst, no rule, no air. The list starts mid-thought.

### 1.3 The known landmine — `PaneSurface` treats an empty fragment as content

`PaneSurface` (`components/ui/PaneSurface.tsx:24-25`) computes `hasContent = children !== undefined && children !== null && children !== false`. An empty fragment `<></>` is a valid React element (an object), so it passes as content and **suppresses the `empty` slot**. Any opener slot we add must not sit behind this toggle, and the toggle itself must be hardened (§4.4, §5-guard).

---

## 2. Target behavior (user-facing)

- **Every pane wears a running head.** A hairline bar at the top of the pane chrome: the section standing-head (e.g. `LIBRARIES`, `AUTHORS`, `CHATS`) set in small-caps, tracked-out, flush-left beside the back/forward controls; and a folio flush-right — a count (`37 sources`), a date (`Mon 7 Jul`), or the title of what you're reading — set in dimmed tabular figures. It is sticky; it is the periodical running head.
- **List surfaces open with a display line.** Below the running head, at the top of the scrolling body, one flush-left display headline (`Libraries`, an author's name, a podcast's title) using the real display ladder, followed by a single thin rule and generous air, then the toolbar and rows. Asymmetric, type-forward, editorial — a section front, not a card grid.
- **One grid.** Standing head, display line, toolbar, and every row title share one left edge and one measure across all surfaces.
- **Detail surfaces echo the index.** A library/author/podcast detail keeps its parent standing head (`LIBRARIES`) in the running head; its own name becomes the section opener; its folio counts its contents (`214 entries`).
- **The reader keeps a running head, no opener.** A document reader shows its parent standing head with the document title as folio; its body treatment stays owned by the reader cutover (#8).
- **Mobile ships the same furniture.** The mobile top bar renders a compact running head (standing head + folio); the section opener renders in the body and scrolls under the sticky bar. No desktop-only chrome.

---

## 3. Goals / Non-goals

### Goals

- **G1.** Two domain-free kit citizens — `RunningHead` and `SectionOpener` (`components/ui/`) — with typed props, adopted across every list surface in one cut.
- **G2.** `SurfaceHeader` stops owning a free-form `title`/`subtitle`/`meta`; it owns navigation + options and renders a `RunningHead` from a typed `standingHead: string` + `folio: Folio`.
- **G3.** One derivation: `standingHeadForRoute(routeId)` maps every `PaneRouteId` to a `DESTINATIONS` label (single source, exhaustive match). No standing-head literal in a pane body.
- **G4.** The folio is a typed union (`count | date | title | none`), published through the chrome-override seam, **replacing** the free-form `meta` override.
- **G5.** `SectionOpener` finally uses the display ladder (`--text-display-1` for index surfaces, `--text-3xl` for detail), flush-left, one hairline rule, named spacing.
- **G6.** Mobile parity: the mobile top bar and pane host render the same running head; the opener renders in the body.
- **G7.** Fix the empty-fragment landmine centrally in `PaneSurface`, and add the `opener` slot outside the empty/content toggle.
- **G8.** Net deletion: the chrome `title`/`subtitle`/`meta`/`headingLevel` props, the `meta` override, and the bespoke chrome-label CSS die.

### Non-goals

- **N1.** No change to `CollectionView`, presenters, `CollectionRowView`, rows, or the collection toolbar — this is the header/opener layer only.
- **N2.** No new machine/AI voice. `RunningHead`/`SectionOpener` are human editorial furniture; they do not overlap `MachineText` (sibling #1) and render no generated text.
- **N3.** No reader body redesign. The reader (`media`, `page`, `note`, `daily`) gets a running head (chrome), but its body/sidecars stay owned by #8. The opener is a list-surface element.
- **N4.** No backend, no migration, no API, no worker job. Frontend furniture only.
- **N5.** No breadcrumb trail. One standing head per pane (the section), not a path.
- **N6.** No folio *metrics dashboard*. The folio is at most one typeset signal; it is not a stats row.

---

## 4. Architecture and final state

### 4.1 Ownership map

| Concern | Final owner | Replaces |
|---|---|---|
| Section standing-head + folio rendering (chrome) | `components/ui/RunningHead.tsx` (+ css) | `SurfaceHeader` `.titles`/`.title`/`.meta` |
| Display line + standfirst + rule + air (body) | `components/ui/SectionOpener.tsx` (+ css) | (new — no prior owner) |
| Pane chrome: nav + options + running head host | `components/ui/SurfaceHeader.tsx` (rewritten) | its own free-form `title`/`subtitle`/`meta` |
| Folio type | `lib/ui/folio.ts` (`Folio` union + `formatFolio`) | free-form `meta: ReactNode` |
| Route → standing head | `lib/navigation/standingHead.ts` (`standingHeadForRoute`) | (new; derives from `DESTINATIONS`) |
| Folio publication seam | `usePaneChromeOverride({ folio })` (`PaneShell.tsx`) | `usePaneChromeOverride({ meta })` |
| Body slot host + empty/content toggle | `components/ui/PaneSurface.tsx` (gains `opener`, hardened `hasContent`) | its current `hasContent` landmine |
| Mobile running head | `components/appnav/NavTopBar.tsx` + `MobilePaneChrome` (typed) | `MobilePaneChrome.title: ReactNode` |

### 4.2 Where each element lives (the boundary decision — binding (b))

The chrome and the body are two DOM regions separated by `PaneShell`. The running head belongs to the **chrome** (always visible, sticky — that is what a running head *is*); the section opener belongs to the **body** (scrolls away — that is what a section opener *is*).

```
PaneShell (owns pane-runtime chrome)
 └─ chrome bar  ──▶ SurfaceHeader  ──▶ [ back/fwd ]  <RunningHead standingHead folio/>  [ options ]
 └─ body ──▶ pane content ──▶ CollectionView ──▶ PaneSurface
                                                   ├─ opener  ──▶ <SectionOpener heading standfirst/>
                                                   ├─ toolbar (collection controls, unchanged)
                                                   ├─ state / content | empty / footer  (unchanged)
```

`SurfaceHeader` keeps back/forward + options + copy-link — those are pane-runtime chrome, not page furniture — and delegates identity to `RunningHead`. Rejected: `RunningHead` fully replacing `SurfaceHeader` (would orphan navigation and the options menu) and putting the running head in the body (it would scroll away, losing the continuity the whole cutover is about). See D-1/D-2.

### 4.3 The standing head derives from the destination registry

`standingHeadForRoute` maps `PaneRouteId` → a `DESTINATIONS` id, then reads that destination's label. The map is exhaustive over `PaneRouteId` (`satisfies Record<PaneRouteId, string>`), so the compiler forces the map to change when a route is added or removed. `PaneRouteId` guards the *keys*; the *values* are section ids validated at runtime by the `find` — there is no `DestinationId` literal type today (`Destination.id` is `string`), so the S0 unit test (which asserts every `PaneRouteId` resolves to a non-empty label) is what catches a mistyped id (`find` → `undefined` → empty label):

```ts
// lib/navigation/standingHead.ts
import { DESTINATIONS } from "@/lib/navigation/destinations";
import type { PaneRouteId } from "@/lib/panes/paneRouteModel";

const ROUTE_SECTION = {
  libraries: "libraries", library: "libraries", media: "libraries",
  authors: "authors", author: "authors",
  podcasts: "podcasts", podcastDetail: "podcasts",
  notes: "notes", page: "notes", note: "notes", daily: "notes", dailyDate: "notes",
  conversations: "chats", conversationNew: "chats", conversation: "chats",
  search: "search",
  settings: "settings", settingsAccount: "settings", settingsBilling: "settings",
  settingsReader: "settings", settingsAppearance: "settings", settingsKeys: "settings",
  settingsLocalVault: "settings", settingsIdentities: "settings", settingsKeybindings: "settings",
  browse: "browse", // transitional — sibling #6 removes this key when it deletes the browse route id
} satisfies Record<PaneRouteId, string>;

// Natural-case label. The `.standing` class applies text-transform: uppercase (§7.8), so all-caps
// never enters the DOM — screen readers read the natural-case word, not letter-by-letter.
export function standingHeadForRoute(routeId: PaneRouteId): string {
  const id = ROUTE_SECTION[routeId];
  return DESTINATIONS.find((d) => d.id === id)?.label ?? "";
}
```

**Standing-head set after siblings #6 and #7** (binding (f)), as rendered (uppercased by `.standing`; the derivation returns natural-case labels): `LIBRARIES · AUTHORS · PODCASTS · NOTES · CHATS · SEARCH · SETTINGS`. No `BROWSE` once #6 lands (the transitional `browse` key becomes a compile error when #6 deletes the `browse` route id, forcing its removal), no `TODAY` (the `today` destination is deleted by #7; `daily`/`dailyDate` map to `NOTES`). `ORACLE` joins the set when #9 turns the oracle shell into panes and adds oracle route ids — at which point the exhaustive map forces the addition. The set is derived, never hardcoded.

`WorkspaceHost`/`PaneShell` compute the standing head from `resolvePaneRouteModel(pane.href).id` and pass `standingHead: string` down to `SurfaceHeader` (and into `MobilePaneChrome`). The primitive receives a string; it imports no route model (boundary preserved — same rule as `ResourceRow`, `paneSurfaceCutover.guards.test.ts:125-136`).

### 4.4 The empty-fragment landmine, designed around (binding (e))

Two moves:

1. **The `opener` slot renders unconditionally**, before the toolbar/state/content toggle — it is never gated by `hasContent`, so an empty list still shows its opener + the `empty` state.
2. **`hasContent` is hardened** to reject an empty fragment, so the collection empty-state can never be masked by a `<></>` passed as `children`:

```tsx
function isRenderableContent(node: ReactNode): boolean {
  if (node === undefined || node === null || node === false) return false;
  if (isValidElement(node) && node.type === Fragment) {
    const kids = (node.props as { children?: ReactNode }).children;
    return Children.toArray(kids).some(isRenderableContent);
  }
  return true;
}
```

A unit test asserts `<PaneSurface empty={E}>{<></>}</PaneSurface>` renders `E`, and `<PaneSurface opener={O} empty={E} />` renders both `O` and `E`.

### 4.5 Grid + measure (one grid governs every surface — binding, seed)

Standing head, display line, toolbar, and row titles share one horizontal content inset. `PaneSurface` already pads the body `var(--space-4)` (`PaneSurface.module.css:8`). The running head's chrome inset is normalized to `var(--space-4)` (from the current `var(--space-3)`, `SurfaceHeader.module.css:8`) so the small-caps standing head sits on the same left edge as the display line and the row titles below it. The `SectionOpener` standfirst is measure-constrained (`max-width: 60ch`) for readability; the display line is not clamped (it may run full width).

---

## 5. Data model / migration

**None.** No table, no column, no Alembic migration. The folio is a client-side typed value; the standing head is derived from the existing route + destination registries. This is a frontend furniture cutover.

## 6. API

**None.** No new route, no BFF proxy change, no `API_ROUTE_COUNT` change, no worker job. Every folio value is computed client-side from data the pane already holds (entry counts, a resolved title, the local date).

---

## 7. Frontend

### 7.1 `Folio` type (`lib/ui/folio.ts`)

It lives in `lib/ui/` (kit-adjacent), **not** `lib/panes/`: `RunningHead` is a ui-kit primitive on the boundary allowlist, and the primitive boundary guard (`paneSurfaceCutover.guards.test.ts:125-136`) forbids any `@/lib/panes/*` import from a kit primitive. `lib/ui/` is outside that banned namespace, so `RunningHead` can import `folio.ts` without tripping the guard.

```ts
export type Folio =
  | { kind: "count"; value: number; unit: string }   // { value: 37, unit: "sources" } → "37 sources"
  | { kind: "date"; iso: string }                     // ISO local date → "Mon 7 Jul" (viewer locale)
  | { kind: "title"; value: string }                  // the resource being read (reader)
  | { kind: "none" };

export function formatFolio(folio: Folio): string | null;
// count → `${value.toLocaleString()} ${pluralize(unit, value)}`; date → short weekday+day+month;
// title → value (truncated by CSS, not here); none → null (RunningHead renders nothing).
```

The folio is a small typed contract, not free-form children (binding (c)). `count` renders in tabular figures; it is a *folio*, not a badge — see D-4.

### 7.2 `RunningHead` (`components/ui/RunningHead.tsx`) — domain-free kit primitive

```tsx
interface RunningHeadProps {
  standingHead: string;    // section, rendered uppercase small-caps
  folio?: Folio;           // flush-right; default { kind: "none" }
  folioPending?: boolean;  // folio skeleton while the count/title resolves
}
```

Renders `<p class={standing}>{standingHead}</p>` flush-left and `formatFolio(folio)` flush-right. When `folioPending` is true, the folio region renders the visual skeleton `<span aria-hidden>` paired with `<span class="sr-only">Loading…</span>` so the pending state carries accessible text (mirrors the current `titlePending` sr-only pattern at `SurfaceHeader.tsx:80-87`). No heading element (the `<h1>` lives in `SectionOpener`/reader body). Imports only `@/lib/ui/folio` + css — no route model, no workspace, no API (boundary rule; new file added to the primitive boundary test allowlist).

### 7.3 `SectionOpener` (`components/ui/SectionOpener.tsx`) — domain-free kit primitive

```tsx
interface SectionOpenerProps {
  heading: ReactNode;            // the display line (index static title, or detail dynamic title)
  scale?: "display" | "title";   // "display" (index) → --text-display-1; "title" (detail) → --text-3xl
  standfirst?: ReactNode;        // optional editorial lede, measure-constrained
  pending?: boolean;             // skeleton for async dynamic headings (reuses the pending pattern)
  actions?: ReactNode;           // rare opener-level action (e.g. "New library")
}
```

Renders `<h1 class={display} data-scale={scale}>` flush-left, an optional standfirst `<p>`, then a single hairline rule and generous bottom air. Domain-free (css only). Default `scale="display"`.

### 7.4 `SurfaceHeader` (rewritten)

```tsx
interface SurfaceHeaderProps {
  standingHead: string;
  folio?: Folio;
  folioPending?: boolean;
  actions?: ReactNode;
  options?: ActionMenuOption[];
  navigation: SurfaceHeaderNavigation;
  className?: string;
}
```

Drops `title`, `titlePending`, `subtitle`, `meta`, `headingLevel`. Renders `<RunningHead .../>` in the `.leading` cluster between the nav controls and the trailing options. The 44px bar + hairline `border-bottom` + `background: var(--surface-2)` stay. DOM-contract change (§7.7).

### 7.5 Wiring: `PaneShell` / `WorkspaceHost` / `PaneSurface` / `CollectionView`

- `PaneShell` receives `standingHead: string` (computed by `WorkspaceHost` from `standingHeadForRoute(resolvePaneRouteModel(pane.href).id)`) and `folio`/`folioPending`. It passes them to `SurfaceHeader` and into `setPaneChrome` for mobile.
- **The resolved pane title survives, narrowly.** `PaneShell`'s `titlePending`/`subtitle` props are removed, but the resolved `title` prop (from `pane.title`, fed by `useSetPaneTitle`) is **kept** — no longer forwarded to `SurfaceHeader` (which now renders `standingHead` + `folio`), but still used for (i) the resize-handle `aria-label` (`PaneShell.tsx:417`, `` `Resize pane ${title}` ``), for which the standing head alone is too coarse when several panes are open, and (ii) the document-mode folio auto-derive below. `useSetPaneTitle` keeps publishing the resolved title for **tab identity** (unchanged).
- **Folio resolution.** `folio` comes from the chrome override when a body publishes one (list/detail surfaces publish `count`). When no override is published **and** the route's `bodyMode === "document"` (the reader family — `media`/`page`/`note`/`daily`/`dailyDate`, per `paneRouteModel.ts`), `PaneShell` auto-derives `folio: { kind: "title", value: resolvedTitle }` (with `folioPending` mirroring `titleState === "pending"`). This gives every reader a title folio **centrally, with no per-reader-body edit** (D-8); an explicit override still wins (e.g. `podcastDetail`, also `document`, publishes `count`). Otherwise the default is `{ kind: "none" }`.
- `PaneChromeOverrides` (`PaneShell.tsx:42-47`) drops `meta`, adds `folio?: Folio` + `folioPending?: boolean`; the `arePaneChromeOverridesEqual` check (`PaneShell.tsx:63`) swaps `left.meta === right.meta` for the folio fields. The media reader (§7.6) just stops publishing `meta`.
- `WorkspaceHost` stops threading `subtitle`: it no longer reads `chrome?.subtitle` (`WorkspaceHost.tsx:563`), drops `subtitle` from its internal pane type (`WorkspaceHost.tsx:89`), and drops `subtitle={pane.subtitle}` + `titlePending` from the `<PaneShell>` mount (`WorkspaceHost.tsx:1237-1239`), passing `standingHead`/`folio` instead (`title={pane.title}` stays, for the resize label + auto-folio).
- `PaneSurface` gains `opener?: ReactNode`, rendered first and unconditionally (§4.4).
- `CollectionView` gains an optional `opener?: ReactNode` prop it forwards to `PaneSurface` (`surface` path) or renders before `toolbar` (`surface={false}` path). Panes pass `<SectionOpener .../>`.

### 7.6 Per-surface adoption map (the collection cutover's surfaces are the map — binding (a))

Each list pane body constructs its opener + publishes its folio. Folio counts come from data the pane already holds.

| Surface (route id) | Standing head | Section opener heading (scale) | Folio |
|---|---|---|---|
| Libraries index (`libraries`) | LIBRARIES | "Libraries" (display) | `count` N libraries |
| Library detail (`library`) | LIBRARIES | library name (title) | `count` N entries |
| Authors index (`authors`) | AUTHORS | "Authors" (display) | `count` N authors |
| Author detail (`author`) | AUTHORS | author name (title) | `count` N works |
| Podcasts index (`podcasts`) | PODCASTS | "Podcasts" (display) | `count` N shows |
| Podcast detail (`podcastDetail`) | PODCASTS | podcast title (title) | `count` N episodes |
| Notes (`notes`) | NOTES | "Notes" (display) | `count` N pages |
| Conversations (`conversations`) | CHATS | "Chats" (display) | `count` N chats |
| Search (`search`) | SEARCH | "Search" (display) | `count` N results, else `none` |
| Settings roots (`settings*`) | SETTINGS | section static title (display) | `none` |
| Daily page via Page pane (`daily`/`dailyDate`, post-#7) | NOTES | date title (title) | `title` (auto, resolved title) |
| Reader (`media`, `page`, `note`) | LIBRARIES / NOTES | — (no opener; #8 owns body) | `title` (auto, resolved title) |

The reader folios (`media`/`page`/`note`/`daily`) are **auto-derived** from the resolved pane title by `PaneShell` for `bodyMode === "document"` panes (§7.5, D-8) — no per-reader-body edit, so `PagePaneBody`/`NotePaneBody`/`DailyNotePaneBody` are untouched. The media pane's only change is a **deletion**: it stops publishing the `meta: mediaHeaderMeta` chrome override (`MediaPaneBody.tsx:4840`) and deletes its `mediaHeaderMeta` `useMemo` node (`MediaPaneBody.tsx:4428`) — the title folio then comes for free from the document-mode default. (The unrelated `styles.documentEmbedMeta` article-embed class at `MediaPaneBody.tsx:2720` is **not** touched — it is embed-card CSS, unrelated to the chrome `meta` override.) A formatted `date` folio for daily pages is an optional override owned by #7's daily rendering; this cutover serves daily with the auto title folio. Detail-surface headings reuse the pane's resolved title (the same value passed to `useSetPaneTitle`) so identity has one source, two consumers (tab + opener).

### 7.7 DOM / test contract (documented breaking change)

The accessible pane heading moves from the chrome to the body: `SectionOpener` renders the `<h1>`; `RunningHead`'s standing head is a `<p>` label (not a heading). The reader keeps its own `<h1>` (owned by #8). `SurfaceHeader.test.tsx` (which asserts `getByRole("heading", { name: title })` in the chrome, `:33`/`:44`) is rewritten to assert the standing head + folio in the running head and the `<h1>` in the opener. The `data-surface-header="true"` hook and the `Options` button label stay.

The `sr-only` `subtitle` and its `aria-describedby` on the chrome header (`SurfaceHeader.tsx:52`, fed by `PaneChromeDescriptor.subtitle` in `paneRouteTable.ts`) are **removed** with the `subtitle` prop — so the per-pane header description goes away. The replacement accessible name is the `SectionOpener` `<h1>` (list surfaces) / reader `<h1>` (reader), which is the true page title; the standing head is a supplementary `<p>` label. This is a deliberate DOM-contract change (the descriptions were rarely populated and duplicated the heading), not a regression to paper over — no `aria-describedby` shim is reintroduced.

### 7.8 Typography specifics (binding (g) — art-directable; all tokens verified in `globals.css`)

**Running head — standing head** (`.standing`):
- `font-size: var(--text-xs)` (0.75rem); `line-height: var(--leading-tight)` (1.2)
- `text-transform: uppercase`; `letter-spacing: var(--tracking-widest)` (0.08em)
- `font-weight: var(--weight-medium)` (500); `color: var(--ink-muted)`
- Enhancement where the font supports it: `font-variant-caps: all-small-caps` (progressive; uppercase+tracking is the robust baseline, not dependent on OpenType features)

**Running head — folio** (`.folio`): `font-size: var(--text-xs)`; `font-variant-numeric: tabular-nums`; `letter-spacing: var(--tracking-wide)` (0.02em); `color: var(--ink-faint)`; flush-right. No pill, no box, no background.

**Running head bar / rule:** the existing `SurfaceHeader` bar — `height: 44px`, `border-bottom: var(--stroke-hairline) solid var(--edge-subtle)` (1px), `background: var(--surface-2)`, inset normalized to `padding-inline: var(--space-4)`.

**Section opener — display line** (`.display`):
- `scale="display"`: `font-size: var(--text-display-1)` (2.5rem); `scale="title"`: `font-size: var(--text-3xl)` (1.875rem)
- `line-height: var(--leading-tight)` (1.2); `letter-spacing: var(--tracking-tight)` (-0.02em)
- `font-weight: var(--weight-bold)` (700); `color: var(--ink)`; flush-left, no truncation
- container step-down on narrow panes: `display` → `--text-2xl` (1.5rem) below a ~34rem pane width (media query on the pane; panes are already width-scoped by `PaneShell`)

**Section opener — standfirst** (`.standfirst`): `font-size: var(--text-md)` (1rem); `font-family: var(--font-serif)`; `color: var(--ink-muted)`; `line-height: var(--leading-normal)` (1.5); `max-width: 60ch`.

**Section opener — spacing + rule** (generous air): `padding-block-start: var(--space-8)` (2rem); heading→standfirst gap `var(--space-2)` (0.5rem); standfirst→rule `var(--space-5)` (1.25rem); rule `border-bottom: var(--stroke-hairline) solid var(--edge-subtle)`; rule→toolbar `var(--space-6)` (1.5rem). All theme-invariant tokens, so Study/Press (sibling #3) reskin for free.

No new tokens are invented. There is no `--rule-*` weight token in the system (verified — only `--stroke-hairline: 1px`, `globals.css:54`); "thin" comes from `--edge-subtle`, not a sub-pixel weight.

### 7.9 Mobile (binding (d))

`MobilePaneChrome` (`lib/workspace/mobileChrome.tsx:36-41`) changes `title: ReactNode` → `standingHead: string; folio?: Folio; folioPending?: boolean`. `PaneShell`'s `setPaneChrome` call (`PaneShell.tsx:266-272`) publishes these. `NavTopBar` (`components/appnav/NavTopBar.tsx:62`, `.topBarTitle`) renders a compact `<RunningHead standingHead folio/>` in place of `paneChrome?.title`. The `SectionOpener` renders in the pane body and scrolls under the sticky top bar — same component, same tokens, no desktop-only furniture. The opener's container step-down keeps the display line legible at phone widths.

---

## 8. Key decisions

- **D-1. Running head in the chrome; section opener in the body.** The running head is the persistent, sticky identity — it belongs in the always-visible pane chrome (`SurfaceHeader`). The section opener is the once-per-surface grand entrance that scrolls away — it belongs at the top of the scrolling body (`PaneSurface`). *Rejected:* both in the body (the running head would scroll away, losing the continuity that is the entire point), or both in the chrome (a 44px bar has no room for a display line).
- **D-2. `SurfaceHeader` keeps navigation, delegates identity to `RunningHead`.** Back/forward, options, and copy-link are pane-runtime chrome, not page furniture; they stay. `SurfaceHeader` drops its free-form `title`/`subtitle`/`meta` and renders a typed `RunningHead`. *Rejected:* `RunningHead` replacing `SurfaceHeader` wholesale (orphans navigation + the options menu).
- **D-3. Standing head derives from the destination registry, exhaustively over `PaneRouteId`.** One derivation, single-sourced labels, compiler-forced to reflect route add/remove — so #6 and #7 automatically shrink the set (binding (f)). *Rejected:* a per-pane `standingHead` literal (drift; violates "one grid"), and matching nav active-state prefixes (would couple the standing head to rail highlighting and mis-map `/media/*`, which has no destination).
- **D-4. The folio is a typed union, and a count is a folio — not a badge.** A folio count is set in dimmed tabular figures, flush-right, no pill/box/background — a page number, not a notification. This honors the seed's `date | count | title` while respecting the owner's loathing of badges/counts: the editorial framing is exactly what makes a count acceptable here. Surfaces where a count would read as a metric use `date` or `title` instead. *Rejected:* free-form `meta: ReactNode` (the escape hatch that becomes dashboard chrome — binding (c)).
- **D-5. The `opener` slot renders unconditionally and `hasContent` is hardened.** The opener must survive an empty list; the empty-fragment landmine is fixed centrally so no future caller can mask the empty state. *Rejected:* threading the opener through `children` (would collide with the empty/content toggle).
- **D-6. The accessible `<h1>` moves to the section opener.** The true page title is the display line; the running head standing-head is a `<p>` label. *Rejected:* keeping the `<h1>` in the chrome (it is now a section label, not the page title) — the DOM-contract change is documented and applied with the test rewrite in the same slice.
- **D-7. Reader gets a running head but no section opener.** Universal chrome furniture applies to every pane (mechanical, within `SurfaceHeader` ownership); the reader body/sidecars stay #8's. *Rejected:* excluding the reader from the running head (it would be the one pane with no sense of page) or specifying its body opener here (overreach into #8).
- **D-8. The reader's title folio is auto-derived centrally in `PaneShell`, not published per body.** For `bodyMode === "document"` panes with no explicit folio override, `PaneShell` derives `folio: { kind: "title", value: resolvedTitle }` from the resolved pane title it already holds (the same value that names the tab and labels the resize handle). One owner, one source; `media`/`page`/`note`/`daily` all get a title folio with zero per-body edits. *Rejected:* editing `PagePaneBody`/`NotePaneBody`/`DailyNotePaneBody` to each publish a folio (drift, three near-identical publishes for a value the shell already knows), and reintroducing the free-form `meta` node in the media pane (the whole point is to delete it). An explicit override still wins, so a detail surface like `podcastDetail` (also `document`) publishes its own `count`.

---

## 9. What dies (exhaustive)

- `SurfaceHeader` props `title`, `titlePending`, `subtitle`, `meta`, `headingLevel` and their rendering (`SurfaceHeader.tsx:16-25`, `:75-95`); the `.titles`/`.title`/`.meta`/`.titleSkeleton` CSS (`SurfaceHeader.module.css:64-94`, `:113-126`) — replaced by the `RunningHead` mount + its css.
- The free-form `meta` chrome override: `PaneChromeOverrides.meta` (`PaneShell.tsx:46`), its equality check (`left.meta === right.meta`, `PaneShell.tsx:63`), and its sole caller — the `meta: mediaHeaderMeta` publish (`MediaPaneBody.tsx:4840`) and the `mediaHeaderMeta` `useMemo` node (`MediaPaneBody.tsx:4428`). No CSS class dies here: `mediaHeaderMeta` is a `ReactNode` (there is no `.mediaHeaderMeta` selector), and `styles.documentEmbedMeta` (`MediaPaneBody.tsx:2720`) is **unrelated** article-embed CSS — leave it alone.
- `PaneShell` props `titlePending`/`subtitle` (superseded by `standingHead` + `folio`); `PaneChromeDescriptor.subtitle` (`paneRouteTable.ts:40`) + its ~15 populated `subtitle` entries; `WorkspaceHost`'s `subtitle` plumbing (internal pane type `:89`, `subtitle: chrome?.subtitle` `:563`, `subtitle={pane.subtitle}` `:1239`). The `PaneShell` `title` prop is **retained** (not dead) — no longer forwarded to `SurfaceHeader`, but used for the resize-handle `aria-label` + the document-mode folio auto-derive (§7.5, D-8). `WorkspaceHost` passes `standingHead`/`folio` (+ retained `title={pane.title}`) instead (`WorkspaceHost.tsx:1237-1239`).
- `MobilePaneChrome.title: ReactNode` (`mobileChrome.tsx:38`) → typed `standingHead`/`folio`; `NavTopBar`'s free-form `paneChrome?.title` render (`NavTopBar.tsx:62`).
- The dead-until-now assumption that surface titles never use the display ladder — `--text-display-1` is now live.

Nothing else. Presenters, rows, `CollectionRowView`, the collection toolbar, and the row grammar are untouched (N1).

## 10. Sibling cutovers and sequencing

- **#6 `browse-surface-deletion-hard-cutover.md`** and **#7 `daily-surface-consolidation-hard-cutover.md`** delete the `browse`/`today` destinations and (for #6) the `browse` route id. The `ROUTE_SECTION` map's exhaustiveness (D-3) forces their removal, so the standing-head set reflects siblings 6+7 automatically (binding (f)). This spec must NOT hardcode `BROWSE`/`TODAY`. If this cutover lands first, the `browse` key stays transitionally and the negative gate (§13) only forbids a *literal* BROWSE/TODAY standing head, not the derived one.
- **#7** changes where daily pages render (the Page pane, not a Daily pane); this spec's `daily`/`dailyDate` → NOTES mapping serves daily pages under NOTES with no assumption of a standalone Daily surface. Daily gets the document-mode auto title folio (§7.5, D-8) by default; publishing a formatted `folio: { kind: "date" }` override is #7's option (the `date` kind is defined here for it).
- **#1 `machine-hand-hard-cutover.md`** owns machine-voice typography (`MachineText`). `RunningHead`/`SectionOpener` are human editorial furniture and render no machine output — disjoint scope, no dependency.
- **#3 `two-rooms-hard-cutover.md`** forks theme tokens. The opener/running head use only semantic, theme-invariant tokens, so Study/Press reskin for free; no coordination needed.
- **#8 `reader-sidecar-consolidation-hard-cutover.md`** owns the reader body/sidecars. This spec gives the reader a chrome running head (`folio: title`) and explicitly does not touch the reader body. The only shared file is `MediaPaneBody.tsx` (this spec removes its `meta` override; #8 owns its sidecars) — coordinate the single chrome-override edit.
- **#9 `oracle-shell-dissolution-hard-cutover.md`** turns the oracle shell into panes; when it adds oracle route ids, the `ROUTE_SECTION` exhaustive map forces an `ORACLE` entry. Today oracle is `externalShell` (a separate route group) and out of this cutover's scope.

Ordering: independent of #1/#4/#10. Best landed after #6/#7 so the standing-head set is final; if before, it self-corrects when they land.

## 11. Slices (each independently buildable + verification)

- **S0 — Kit primitives + folio + derivation.** Create `lib/ui/folio.ts` (`Folio` + `formatFolio`), `lib/navigation/standingHead.ts` (`standingHeadForRoute`, exhaustive), `components/ui/RunningHead.tsx`(+css), `components/ui/SectionOpener.tsx`(+css). Add both primitives to the boundary-test allowlist (`paneSurfaceCutover.guards.test.ts:128-133`); `RunningHead` imports `@/lib/ui/folio`, which is outside the guard's banned `lib/panes/*` namespace. *Verify:* `typecheck`/`lint`/`lint:css-tokens` green; unit tests for `formatFolio` (all four kinds, pluralization, locale date) and `standingHeadForRoute` (every `PaneRouteId` resolves to a label); browser snapshot tests for `RunningHead` (count/date/title/pending) and `SectionOpener` (display/title scale, standfirst, pending); no surface migrated yet.
- **S1 — `PaneSurface` `opener` slot + landmine fix.** Add `opener?`, render it unconditionally; harden `hasContent` via `isRenderableContent` (§4.4). *Verify:* the empty-fragment unit test passes; existing `PaneSurface`/collection browser tests stay green.
- **S2 — `SurfaceHeader` + chrome rewrite ⟵ load-bearing.** Rewrite `SurfaceHeader` to the new props; render `RunningHead`. Change `PaneChromeOverrides` (`meta`→`folio`), `PaneShell` props (`title`→`standingHead`+`folio`), `WorkspaceHost` wiring, `MobilePaneChrome` + `NavTopBar`. Rewrite `SurfaceHeader.test.tsx` DOM contract. Migrate the media pane's `meta`→`folio`. *Verify:* `typecheck`/`lint` green; `SurfaceHeader`, `PaneShell`, `NavTopBar`, media-pane tests green; every pane shows a running head desktop + mobile.
- **S3 — Section-opener adoption (all list surfaces).** For each surface in §7.6, thread `opener={<SectionOpener .../>}` through `CollectionView` and publish `folio` via `usePaneChromeOverride`. *Verify:* `paneSurfaceCutover.guards.test.ts` still green; new browser tests assert opener + running head per surface; the negative gates (§13) pass; `make check-bundle` ≤ 115 kB gz.
- **S4 — Polish + a11y + reduced-motion.** Container step-down for the display line; pending skeletons; `RunningHead` folio truncation; focus order (nav → running head is non-interactive → options). *Verify:* FE unit + browser suites green; `make test-e2e` (pane header/opener selectors) + `make test-csp` green.

## 12. Acceptance criteria

- **AC-1.** Every pane (list, detail, reader; desktop + mobile) renders a running head: section standing-head flush-left small-caps + folio flush-right (or nothing when `folio.kind === "none"`).
- **AC-2.** Every list surface in §7.6 renders a `SectionOpener` display line above the toolbar, using `--text-display-1` (index) or `--text-3xl` (detail), flush-left, one hairline rule, generous air.
- **AC-3.** The standing head is derived from `standingHeadForRoute` (single source `DESTINATIONS`); no pane body contains a standing-head literal; the set after #6/#7 is exactly `LIBRARIES · AUTHORS · PODCASTS · NOTES · CHATS · SEARCH · SETTINGS`.
- **AC-4.** The folio is a typed `Folio`; counts render as tabular figures with no pill/box; there is no free-form `meta` chrome override anywhere.
- **AC-5.** `PaneSurface` renders `opener` unconditionally; an empty list shows both the opener and the `empty` state; `<PaneSurface empty={E}>{<></>}</PaneSurface>` renders `E`.
- **AC-6.** The accessible pane `<h1>` is the section opener's display line (list surfaces) or the reader body's heading (reader); the running head standing-head is a non-heading label.
- **AC-7.** `SurfaceHeader` exposes no `title`/`subtitle`/`meta`/`headingLevel` props; it renders `RunningHead` and keeps navigation + options.
- **AC-8.** Mobile parity: the mobile top bar renders the running head; the section opener renders in the body; no desktop-only furniture; reduced-motion honored.
- **AC-9.** `RunningHead`/`SectionOpener` import no route model, workspace, pane runtime, or API client (primitive boundary preserved).
- **AC-10.** `make check-bundle` ≤ 115 kB gz; `lint:css-tokens` clean (no raw colors, all tokens verified present).

## 13. Negative gates (grep-able)

```bash
# SurfaceHeader no longer takes a free-form title/subtitle/meta
if rg -n "title:|subtitle:|meta:|headingLevel" apps/web/src/components/ui/SurfaceHeader.tsx; then
  echo "FAIL: SurfaceHeader still owns free-form identity props"; exit 1; fi
# no meta chrome override survives
if rg -n "\bmeta\b" apps/web/src/components/workspace/PaneShell.tsx | rg -v "//"; then
  echo "FAIL: meta chrome override remains"; exit 1; fi
# primitives stay domain-free
if rg -n "@/lib/panes/paneRouteModel|@/lib/navigation/destinations|@/components/workspace|@/lib/api" \
  apps/web/src/components/ui/RunningHead.tsx apps/web/src/components/ui/SectionOpener.tsx; then
  echo "FAIL: RunningHead/SectionOpener import a domain/route layer"; exit 1; fi
# no standing-head literal in a pane body (must derive) — cover both JSX string and expression forms
if rg -n "standingHead=[{\"'](LIBRARIES|AUTHORS|PODCASTS|NOTES|CHATS|SEARCH|SETTINGS)" \
  "apps/web/src/app/(authenticated)"; then
  echo "FAIL: standing-head literal in a pane body"; exit 1; fi
# no dead BROWSE/TODAY standing head after #6/#7
if rg -n "\"BROWSE\"|\"TODAY\"|standingHead.*Browse|standingHead.*Today" apps/web/src/lib/navigation/standingHead.ts; then
  echo "FAIL: dead BROWSE/TODAY standing head"; exit 1; fi
# section opener uses the display ladder
if ! rg -n "var\(--text-display-1\)" apps/web/src/components/ui/SectionOpener.module.css; then
  echo "FAIL: SectionOpener does not use the display ladder"; exit 1; fi
# no centered pane title/opener anywhere
if rg -n "text-align:\s*center" apps/web/src/components/ui/SectionOpener.module.css \
  apps/web/src/components/ui/RunningHead.module.css apps/web/src/components/ui/SurfaceHeader.module.css; then
  echo "FAIL: centered header/opener"; exit 1; fi
# folio is typed, not free-form children
if rg -n "ReactNode|children" apps/web/src/lib/ui/folio.ts; then
  echo "FAIL: folio leaks free-form nodes"; exit 1; fi
```

## 14. Test plan

- **Unit (`.test.ts`, node):** `formatFolio` (count pluralization + `toLocaleString`, short date in viewer locale, title passthrough, none→null); `standingHeadForRoute` (every `PaneRouteId` → a non-empty **natural-case** label, e.g. `"Libraries"` not `"LIBRARIES"` — casing is CSS's job, §7.8; `satisfies` compile check); `isRenderableContent` (empty fragment → false, fragment with a child → true).
- **Browser (`.test.tsx`, Chromium):** `RunningHead` snapshots (each folio kind + pending, incl. the pending folio exposing `Loading…` accessible text); `SectionOpener` snapshots (display/title scale, with/without standfirst, pending); `PaneSurface` opener-always + empty-fragment; rewritten `SurfaceHeader` (running head + folio + Options button, no chrome heading); the resize handle's accessible name matches the **resolved pane title** (not the standing head), and the document-mode folio auto-derives from that same title; `NavTopBar` mobile running head; two representative surfaces (Libraries index + a library detail) render opener + running head + folio.
- **Guards:** `paneSurfaceCutover.guards.test.ts` stays green; new furniture guard test for the §13 gates.
- **E2E (`make test-e2e`):** open Libraries → assert `LIBRARIES` running head + "Libraries" opener + folio count; open a library → parent standing head + name opener + entry count; mobile viewport → running head in the top bar, opener in the body.
- **Static/bundle:** `typecheck`, `lint`, `lint:css-tokens`, `make check-bundle` ≤ 115 kB gz, `make test-csp`.

## 15. Files (touched / created / deleted)

**Created (FE):** `apps/web/src/lib/ui/folio.ts`; `apps/web/src/lib/navigation/standingHead.ts`; `apps/web/src/components/ui/RunningHead.tsx` + `.module.css`; `apps/web/src/components/ui/SectionOpener.tsx` + `.module.css`; unit/browser tests for each.

**Modified (FE):** `components/ui/SurfaceHeader.tsx` (+ `.module.css`, + rewritten `SurfaceHeader.test.tsx`); `components/ui/PaneSurface.tsx` (+ `.module.css`); `components/workspace/PaneShell.tsx`; `components/workspace/WorkspaceHost.tsx`; `lib/panes/paneRouteTable.ts` (drop `PaneChromeDescriptor.subtitle` + the ~15 subtitle entries); `lib/workspace/mobileChrome.tsx`; `components/appnav/NavTopBar.tsx`; `components/collections/CollectionView.tsx`; each list pane body in §7.6 (`libraries/LibrariesPaneBody.tsx`, `libraries/[id]/LibraryPaneBody.tsx`, `authors/AuthorsPaneBody.tsx`, `authors/[handle]/AuthorPaneBody.tsx`, `podcasts/PodcastsPaneBody.tsx`, `podcasts/[podcastId]/PodcastDetailPaneBody.tsx`, `notes/NotesPaneBody.tsx`, `conversations/ConversationsPaneBody.tsx`, `search/SearchPaneBody.tsx`, `settings/*PaneBody.tsx`); `media/[id]/MediaPaneBody.tsx` (`meta`→`folio`); `lib/ui/paneSurfaceCutover.guards.test.ts` (allowlist the two new primitives; add furniture gates).

**Deleted (FE):** the `SurfaceHeader` `.titles`/`.title`/`.meta`/`.titleSkeleton` CSS block; `PaneChromeOverrides.meta` + its equality branch + the media pane's `meta: mediaHeaderMeta` publish and its `mediaHeaderMeta` `useMemo` node (no CSS class — `styles.documentEmbedMeta` at `MediaPaneBody.tsx:2720` is unrelated embed-card CSS and stays); `PaneChromeDescriptor.subtitle` + `WorkspaceHost` subtitle plumbing; `MobilePaneChrome.title`.

**No backend, no migration, no proxy route, no API_ROUTE_COUNT change.**

## 16. Risks

- **R1. S2 is atomic and touches shared chrome (`SurfaceHeader`/`PaneShell`/mobile).** *Control:* S0/S1 land the primitives + slot behind tests first; S2 is a mechanical props swap with the DOM-contract test rewritten in the same commit so nothing references the old props mid-flight.
- **R2. The folio count reads as a badge (owner taste).** *Control:* D-4 — tabular figures, no pill/box, dimmed, flush-right; surfaces where a count feels metric use `date`/`title`; screenshot review is the gate.
- **R3. Standing-head drift when #6/#7 land.** *Control:* D-3 exhaustive `satisfies Record<PaneRouteId, …>` — a removed route id is a compile error, forcing the map to shrink; §13 forbids literals.
- **R4. Empty-fragment landmine masks an empty state.** *Control:* the hardened `hasContent` + the dedicated always-on `opener` slot + a direct unit test (AC-5).
- **R5. Bundle creep from two primitives.** *Control:* both are tiny presentational components in the ui kit; pane bodies stay `React.lazy`; `make check-bundle` gates every slice; no new dependency.
- **R6. Overreach into the reader (#8).** *Control:* D-7 — this cutover only gives the reader a chrome running head and removes the media pane's `meta` override; the reader body/sidecars stay #8's, and the one shared file edit is coordinated (§10).
- **R7. Concurrent agent shares this checkout (per repo memory).** *Control:* stage explicitly, never `git add -A`; coordinate `MediaPaneBody.tsx` and `destinations.ts`-adjacent edits with #6/#7/#8.
