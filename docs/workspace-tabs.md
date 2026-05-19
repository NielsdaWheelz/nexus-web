# Workspace — Pane Tabs

Status: Implemented. Hard cutover: `WorkspacePaneStrip` is
rebuilt outright and the pane-title resolver gains a loading state — no flag, no
fallback, no legacy path, no backward-compat shim.
Scope owner: workspace pane surface (`apps/web`).
Date: 2026-05-19.
Related: `docs/workspace.md` — the spatial canvas + strip system this builds on.

## 1. Problem

`WorkspacePaneStrip` renders the desktop pane tabs — the row above the canvas,
one tab per open pane. It has three defects, with two root causes.

**1.1 A tab is wider than its content.** A tab's title is a
`<Button variant="ghost">`. `WorkspacePaneStrip.module.css` `.primary` sets
`min-width: 96px`, so every tab is floored at 96px + 24px padding regardless of
its label. Because the title routes through `Button`, it inherits
`justify-content: center` from `Button.module.css` `.button` — which `.primary`
never overrides — so a short label floats centred in an oversized box with dead
gutters on both sides. This is the reported "titles overextending their
contents".

**1.2 A long title overflows the tab edge.** `.title` is itself correctly
clamped (`overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
min-width:0`). But `Button` wraps its children in a `.label` span
(`Button.module.css` `.label`) that is `inline-flex` with no `min-width:0` and no
`overflow`. A flex item defaults to `min-width:auto` and refuses to shrink below
its content's intrinsic width; `.primary` has no `overflow:hidden` either. The
ellipsis is computed inside a box that is already too wide, so a long title
reaches the tab's edge before it clips.

**1.3 A title is sometimes a category word, not a title — e.g. an epub tab reads
"Media".** `resolveWorkspacePaneTitle` (`lib/workspace/store.tsx`) is a total
function returning a `string`: it has no value for *"the title is not known
yet."* A pane body must therefore hand the system some string on first paint.
`MediaPaneBody` initialises `media` to `null` and calls
`useSetPaneTitle(buildCompactMediaPaneTitle(media))` every render;
`buildCompactMediaPaneTitle(null)` returns the literal `"Media"`
(`media/[id]/mediaFormatting.ts`). That placeholder is published as the pane's
runtime title and shown in the tab. It self-corrects when the body's data
arrives — but the window is long for the slowest bodies (epub), and permanent if
the fetch fails (`media` stays `null`). The word "Media" is a correct *route
label*; the defect is that a route label is rendered as though it were a
*resolved pane title*. Every dynamic-content pane shares this code path; epub is
merely the most visible because epub bodies load slowest.

**1.4 The strip is visually inert.** Zero `border-radius` — hard rectangles. The
active state is a bare background swap. Hover background is `--surface-2`, the
strip's own background, so hovering an inactive tab is invisible. The in-view
marker is `--accent-muted` (16% opacity) — below the threshold of a usable
signal, and short of what `docs/workspace.md` §2.2 specifies it to be. Dividers
use `--edge-subtle`, the faintest edge token. There are no transitions on any
tab-level state change. The focus ring (`outline: 2px solid currentColor`,
inset) diverges from the `--ring` token every other control uses. Titles render
`--weight-semibold` — inherited from `Button`, not chosen.

**Root causes.** Defects 1.1, 1.2, and 1.4 all follow from one decision: the tab
was assembled from three generic `Button`s, which dictate centring, weight,
radius, and an unshrinkable label wrapper, and which were never meant to compose
into a content-hugging, truncating tab. Defect 1.3 follows from a second: the
pane-title model has no representation of *pending*, so a placeholder must
impersonate a title.

This document specifies a rebuilt tab (**Part A**, §1.1/1.2/1.4) and a
pane-title model with a first-class pending state (**Part B**, §1.3). The two
parts are independently shippable; §12 sequences them.

## 2. Target behaviour

The strip is a horizontal `role="toolbar"` of **pane tabs**, one per open pane,
above the canvas. It is desktop-only and presentational: it renders props and
emits callbacks, exactly as today. Its role as a live overview of the canvas —
the in-view marker, `IntersectionObserver` wiring — is unchanged and remains
owned by `docs/workspace.md`. Mobile is unchanged: no strip.

### 2.1 The tab

A tab is a single self-contained component. Left to right:

- a **route icon** — the lucide glyph that `getPaneRouteIcon(href)` already owns
  per route (the icon owner established by commit `cec098e`);
- the **title** — the resolved pane title, or a skeleton while pending (§2.3);
- the **actions** — minimize/restore and close.

The tab is **not** built from `Button`. It owns all of its own structure and
styling. `Button`'s base class is the source of defects 1.1, 1.2, and 1.4 and is
removed from this surface entirely.

### 2.2 Sizing & truncation

A tab **hugs its content** and truncates cleanly:

- No `min-width` floor. A tab is as wide as `icon + title + actions` needs, up to
  a `max-width` of 240px, then the title truncates with an ellipsis.
- The tab is `flex: 0 1 auto` — it may shrink, never grows to fill.
- The title is left-aligned. There are no centring gutters.
- The truncation chain is unbroken: every element from the tab down to the title
  span carries `min-width: 0`; the tab and the title carry `overflow: hidden`;
  the title carries `text-overflow: ellipsis; white-space: nowrap`. The title is
  the only flexible child of the activator — the icon and actions are
  `flex: 0 0 auto` and yield no width — so the title absorbs all shrinkage and
  the ellipsis is computed against the true available width.
- The activator carries a native `title={fullTitle}` attribute, so a truncated
  tab reveals its full name on hover with no custom tooltip component.

### 2.3 The title lifecycle

A pane title has two states, and the strip renders each distinctly:

- **resolved** — a real, final title. Rendered as text.
- **pending** — a dynamic-content pane whose body has not yet resolved its
  title. Rendered as a **skeleton** block, never as placeholder text. The route
  icon still shows, so the tab keeps a stable identity while loading.

A route declares which model it uses (`titleMode`, §5.3). An *index* or
*settings* route (`Libraries`, `Search`, `Settings`, …) is `static`: its name is
its title, shown immediately and permanently. A *resource* route (`media`,
`library`, `conversation`, …) is `dynamic`: its title belongs to the loaded
resource and is `pending` until the body publishes it.

The defect in §1.3 is fixed at the model, not with copy: "Media" remains a
correct label for the `media` route; it simply stops being rendered as a tab
title. A `pending` media tab shows a skeleton; a `resolved` one shows the book,
PDF, podcast, or video title the body publishes.

### 2.4 States & interaction

| State | Treatment |
|---|---|
| Idle (inactive) | Transparent tab on the `--surface-2` strip; `--ink-muted` title; `--ink-faint` icon; actions hidden. |
| Hover (inactive) | Tab fills with `--surface-1` — a visible, distinct lift toward the active surface; title brightens to `--ink`; actions revealed. |
| Active | Tab fills with `--surface-canvas` (it is contiguous with its pane below) **and** a 2px `--accent` bar across its top edge; `--ink` title; actions revealed. |
| In view | A 2px bar across the tab's bottom edge in `color-mix(in srgb, var(--accent) 55%, transparent)` — legible, and subordinate to the active fill. Composes with every other state. |
| Minimized | `--surface-1` tab; `--ink-faint`, italic title; the minimize action becomes restore. |
| Focus-visible | `outline: 2px solid var(--ring)` inset — the design-system focus token. |

Active and in-view are independent dimensions (`docs/workspace.md` §2.2) and
compose on one tab: accent top (active) + accent bottom (in view). Every
transition between these states is animated with the standard
`--duration-fast` / `--ease-glide` pair; instant under `prefers-reduced-motion`.

Click, minimize, restore, and close behave exactly as today (activate or restore
the pane; the active pane centres in the canvas per `docs/workspace.md` §2.4).
The strip's callback surface is unchanged.

### 2.5 Keyboard & accessibility

- The strip is a `role="toolbar"`; roving `tabindex` moves between tabs with
  `ArrowLeft`/`ArrowRight`/`Home`/`End` and lands on the tab's activator —
  unchanged from today.
- `Delete` or `Backspace` on a focused tab closes its pane.
- The minimize/close action buttons are `tabindex={-1}` — pointer affordances,
  not toolbar stops. This corrects today's strip, where the action `Button`s are
  silently in the tab sequence and break the one-stop-per-tab toolbar contract.
- Every tab has an accessible name. A `resolved` tab is named by its title text
  plus the sr-only active/minimized announcements; a `pending` tab — whose
  visible title is a skeleton — carries `aria-label` (the route stand-in label)
  and `aria-busy`. A skeleton is never a nameless control.
- The active tab carries `aria-current`. Minimized state keeps an `sr-only`
  announcement.

## 3. Architecture

Two seams, one per part.

**Part A — the tab.** `WorkspacePaneStrip` keeps the toolbar: the item list,
roving focus, the keyboard handler, and the focus-restore effects. One tab is
factored into an internal `PaneTab` function component in the same file —
colocated, not a new module (`simplicity.md`: a single-consumer subcomponent
earns no public surface). `PaneTab` is pure presentation.

```
WorkspacePaneStrip          toolbar — item list, roving tabindex, keydown,
  │                         focus restore. Unchanged responsibilities.
  └── PaneTab × N            one tab — internal component, same file.
        route icon · title-or-skeleton · minimize/restore · close
```

**Part B — the title model.** The pending state threads through the existing
title path; no new owner, no new store state.

```
PaneRouteDefinition.titleMode   route registry declares static | dynamic
        │
resolveWorkspacePaneTitle()     emits { title, titleState } — store.tsx
        │
WorkspaceHost                   threads titleState into shell panes + strip items
        ├── WorkspacePaneStrip / PaneTab     pending → skeleton
        └── PaneShell / SurfaceHeader        pending → skeleton heading
CommandPalette                  consumes title text; ignores titleState
```

`runtimeTitleByPaneId` and its prune-on-href-change (`store.tsx`) are unchanged.
After an href change a dynamic pane re-enters `pending` and shows a skeleton
until the new body publishes — the same prune that today briefly exposed the
"Media" route label.

## 4. Capability contract — the pane title

`resolveWorkspacePaneTitle` is the single owner of "what is this pane called."

- **Inputs:** a pane (`id`, `href`); the runtime-title map.
- **Output:** `{ chrome, route, title, titleState }`.
  - `title: string` is **always** populated — the resolved title, or, while
    `pending`, the route label as a stand-in for `aria-label`, the command
    palette, telemetry, and the native tooltip. It is never the empty string.
  - `titleState: "resolved" | "pending"`.
- **Invariants:**
  - `pending` ⇔ the route is `titleMode: "dynamic"` **and** no runtime title is
    published for the pane. Every other case is `resolved`.
  - A `static` route is always `resolved` — its name is a real title.
  - A surface that can render a skeleton (the strip, the pane header) renders
    `pending` as a skeleton. A text-only surface (the command palette) renders
    `title`.
  - The function is total and pure; it performs no I/O and never throws.

**The dynamic-pane-body contract.** A `titleMode: "dynamic"` route's body MUST
call `useSetPaneTitle` and MUST:

- publish `null` (or nothing) while its title is genuinely unknown — the loading
  window. This yields `pending` → a skeleton.
- publish a non-empty string at **every terminal state**: the resolved resource
  title on success, and a deterministic fallback on error or not-found (the
  route label is an acceptable fallback — a failed pane is a real terminal
  state, not a perpetual skeleton).
- never publish a category placeholder as if it were a title. A body computing a
  title from not-yet-loaded data returns `null`, not a stand-in word.

A `static` route's body MAY still publish a runtime title (it wins over the
route label) — `titleMode` governs only the *loading fallback*, not whether a
body may override.

## 5. API design

### 5.1 `PaneTab` — internal component in `WorkspacePaneStrip.tsx`

```tsx
function PaneTab(props: {
  item: WorkspacePaneStripItem;          // includes href + titleState (§5.2)
  isFocusable: boolean;                  // roving tabindex source of truth
  activatorRef: (el: HTMLButtonElement | null) => void;
  onActivate: () => void;
  onMinimize: () => void;
  onRestore: () => void;
  onClose: () => void;
  onActivatorKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
  onActivatorFocus: () => void;
}): JSX.Element
```

Markup:

```tsx
<div className={[styles.tab, isActive && styles.active, isInView && styles.inView,
                  isMinimized && styles.minimized].filter(Boolean).join(" ")}>
  <button
    type="button"
    ref={activatorRef}
    className={styles.activator}
    tabIndex={isFocusable ? 0 : -1}
    aria-current={isActive ? "page" : undefined}
    aria-label={titleState === "pending" ? title : undefined}
    aria-busy={titleState === "pending" || undefined}
    title={titleState === "resolved" ? title : undefined}
    onClick={onActivate}
    onFocus={onActivatorFocus}
    onKeyDown={onActivatorKeyDown}
  >
    <RouteIcon aria-hidden size={14} strokeWidth={2} className={styles.icon} />
    {titleState === "pending"
      ? <span className={styles.titleSkeleton} aria-hidden />
      : <span className={styles.title}>{title}</span>}
    {isActive && <span className="sr-only"> Active pane.</span>}
  </button>
  <div className={styles.actions}>
    <button type="button" tabIndex={-1} className={styles.action}
            aria-label={`${isMinimized ? "Restore" : "Minimize"} ${title}`}
            disabled={!isMinimized && !canMinimize}
            onClick={isMinimized ? onRestore : onMinimize}>
      {isMinimized ? <Maximize2 .../> : <Minus .../>}
    </button>
    <button type="button" tabIndex={-1} className={styles.action}
            aria-label={`Close ${title}`} onClick={onClose}>
      <X .../>
    </button>
  </div>
</div>
```

`RouteIcon` is `getPaneRouteIcon(item.href)` from `paneRouteRegistry` — the
strip resolves no icons of its own. Icons are lucide, 14px, `strokeWidth={2}`.

### 5.2 `WorkspacePaneStrip` — item shape & toolbar

`WorkspacePaneStripItem` gains two fields:

```ts
interface WorkspacePaneStripItem {
  paneId: string;
  href: string;                          // NEW — route icon source
  title: string;
  titleState: "resolved" | "pending";    // NEW — skeleton vs text
  isActive: boolean;
  isInView: boolean;
  visibility: "visible" | "minimized";
  canMinimize: boolean;
}
```

`WorkspacePaneStrip` keeps every responsibility it has today: building the
roving-focus index, the `ArrowLeft/Right/Home/End` handler, `Delete`/`Backspace`
→ close, and the pending-focus restore effect after minimize/restore/close. The
only change is that each item renders through `PaneTab` instead of an inline
triple-`Button` block. The action buttons leave the roving sequence
(`tabIndex={-1}`); `Delete`/`Backspace` on the activator remains the keyboard
close path.

### 5.3 Route registry — `titleMode`

`paneRouteRegistry.tsx`. `PaneRouteDefinition` gains a **required** field; every
one of the 25 route definitions declares it explicitly (no implicit default —
`conventions.md`).

```ts
interface PaneRouteDefinition {
  // …
  titleMode: "static" | "dynamic";
}
```

`dynamic` (8): `media`, `library`, `conversation`, `podcastDetail`, `author`,
`page`, `note`, `dailyDate` — the routes whose title is a loaded resource's.
`static` (the rest): `libraries`, `conversations`, `conversationNew`, `browse`,
`podcasts`, `search`, `notes`, `daily`, and every `settings*` route — their name
is their title.

`ResolvedPaneRoute` carries `titleMode` through (alongside `staticTitle`). The
synthetic `unsupported` route is `static`.

`resourceRef !== null` correlates exactly with the `dynamic` set today, but the
two concepts are kept separate: `resourceRef` is identity for pane de-duplication
(`open_pane`), `titleMode` is loading behaviour. An explicit field will not
silently break when a future route's two concerns diverge.

### 5.4 `resolveWorkspacePaneTitle` — `lib/workspace/store.tsx`

`WorkspacePaneTitleDescriptor` replaces `titleSource` with `titleState`:

```ts
export interface WorkspacePaneTitleDescriptor {
  chrome: PaneChromeDescriptor | undefined;
  route: ResolvedPaneRoute;
  title: string;                          // always populated, never ""
  titleState: "resolved" | "pending";     // replaces titleSource
}
```

Resolution:

1. A runtime title exists ⇒ `{ title: runtimeTitle, titleState: "resolved" }`.
2. Else compute the route label
   `normalizePaneTitle(chrome?.title) ?? normalizePaneTitle(route.staticTitle) ?? "Pane"`:
   - `route.titleMode === "dynamic"` ⇒ `{ title: routeLabel, titleState: "pending" }`.
   - `route.titleMode === "static"` ⇒ `{ title: routeLabel, titleState: "resolved" }`.

`titleSource` is removed, not kept beside `titleState` — hard cutover. The
telemetry that read `descriptor.titleSource` reads `descriptor.titleState`.

### 5.5 `WorkspaceHost` — wiring

- `WorkspaceShellPane` gains `titleState: "resolved" | "pending"`; `buildShellPane`
  copies it from the descriptor.
- `stripItems` gains `href` (already on the pane) and `titleState`.
- The title-telemetry effect keys on `descriptor.titleState` instead of
  `descriptor.titleSource`; `emitWorkspaceTelemetry({ type: "title", … })` sends
  `titleState`. A pane stuck `pending` is now observable in telemetry.

### 5.6 `PaneShell` & `SurfaceHeader` — the pane header skeleton

The descriptor feeds the pane header as well as the strip, so the header gets the
same fix. `PaneShell` gains `titlePending?: boolean`, forwarded from
`WorkspaceShellPane.titleState`. `SurfaceHeader` gains `titlePending?: boolean`;
when set it renders the `<HeadingTag>` containing a skeleton block plus an
`sr-only` span holding the stand-in `title` string — the heading keeps an
accessible name. The skeleton is a local `.titleSkeleton` CSS class (§5.9).

### 5.7 `CommandPalette` — composition, no skeleton

`CommandPalette` consumes the new descriptor. Its "Open tabs" rows render
`descriptor.title` as text regardless of `titleState`: the palette is a
transient, keyboard-filtered text list, and a shimmer in a command row is noise.
A `pending` pane shows its route label there — correct for that surface.

### 5.8 Dynamic pane bodies — contract conformance

The 8 `dynamic` routes' bodies must satisfy §4. Audit each; the two known
non-conformers:

- `media/[id]/mediaFormatting.ts` — `buildCompactMediaPaneTitle` returns `null`
  for nullish/untitled `media` instead of `"Media"`. `MediaPaneBody` then
  publishes `null` while loading, the resolved compact title on success, and a
  fallback string on `error` (it must not leave the title `null` once `loading`
  is `false`).
- `notes/[blockId]/NotePaneBody.tsx` — does not call `useSetPaneTitle` today;
  it must, publishing `null` while loading and the note's title once loaded.

The remaining 6 (`LibraryPaneBody`, `ConversationPaneBody`,
`PodcastDetailPaneBody`, `AuthorPaneBody`, `PagePaneBody`, `DailyNotePaneBody`)
already publish; each is audited to confirm it publishes `null` — not a
placeholder — during its loading window.

### 5.9 CSS & the visual system — `WorkspacePaneStrip.module.css`

The module is rewritten. No rule routes through `Button`. Load-bearing CSS:

```css
.switcher {                 /* the toolbar */
  display: flex;
  align-items: stretch;
  gap: var(--space-1);
  min-width: 0;
  flex: 1;
  overflow-x: auto;
  padding-inline: var(--space-1);
}

.tab {                      /* hugs content; never grows; truncates */
  position: relative;
  display: flex;
  align-items: center;
  height: 100%;
  min-width: 0;
  max-width: 240px;         /* the only width cap; no min-width floor */
  flex: 0 1 auto;
  background: transparent;
  border-radius: var(--radius-md) var(--radius-md) 0 0;
  transition:
    background-color var(--duration-fast) var(--ease-glide),
    box-shadow var(--duration-fast) var(--ease-glide);
}

.activator {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;             /* unbroken truncation chain */
  height: 100%;
  padding-inline: var(--space-2);
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  overflow: hidden;
}

.icon  { flex: 0 0 auto; color: var(--ink-faint); }

.title {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  line-height: var(--leading-snug);
  color: var(--ink-muted);
}

/* --- states --- */
.tab:hover:not(.active)        { background: var(--surface-1); }
.tab:hover:not(.active) .title { color: var(--ink); }

.active        { background: var(--surface-canvas);
                 box-shadow: inset 0 2px 0 0 var(--accent); }
.active .title { color: var(--ink); }
.active .icon  { color: var(--ink-muted); }

.tab::after {                 /* the in-view marker — own layer, no collision */
  content: "";
  position: absolute;
  left: 0; right: 0; bottom: 0;
  height: 2px;
  background: color-mix(in srgb, var(--accent) 55%, transparent);
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-glide);
}
.inView::after { opacity: 1; }

.minimized        { background: var(--surface-1); }
.minimized .title { color: var(--ink-faint); font-style: italic; }

.activator:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: -2px;       /* inset — the strip is overflow:auto */
}

/* --- actions: revealed on hover / focus-within / active; space reserved --- */
.actions { flex: 0 0 auto; display: flex; align-items: center; padding-right: 2px; }
.action  { /* 24px square, var(--radius-sm), transparent, --ink-faint icon */ }
.actions { opacity: 0; transition: opacity var(--duration-fast) var(--ease-glide); }
.tab:hover .actions,
.tab:focus-within .actions,
.active .actions          { opacity: 1; }
.action:hover             { background: color-mix(in srgb, var(--ink) 10%, transparent);
                            color: var(--ink); }
.action:disabled          { opacity: 0.4; cursor: not-allowed; }

/* --- pending skeleton --- */
.titleSkeleton {
  flex: 0 0 auto;
  width: 84px; height: 0.7em;
  border-radius: var(--radius-xs);
  background: var(--surface-3);
}
```

`.actions` reserves its width whether visible or not, so revealing actions on
hover causes **no layout shift**. The pending skeleton is a local `.titleSkeleton`
CSS class — a static `--surface-3` block with a pulse keyframe gated by
`@media (prefers-reduced-motion: reduce)` — defined in both
`WorkspacePaneStrip.module.css` and `SurfaceHeader.module.css`. There is no
shared `Skeleton` component: two short rule-blocks sit below the bar an
abstraction must clear.

## 6. Composition with other systems

| System | Touchpoint |
|---|---|
| `docs/workspace.md` | Owns the strip's *role* (live overview), the in-view *concept*, and the `IntersectionObserver`. This doc owns the tab's *anatomy and visuals*, including the in-view marker's appearance. workspace.md §5.4's marker CSS sentence is trimmed to a cross-reference (`docs/rules/index.md`: each rule in exactly one document). |
| Workspace store | `resolveWorkspacePaneTitle` returns `titleState`; `runtimeTitleByPaneId`, the prune, and `publishPaneTitle` are unchanged. No store state added. |
| `paneRouteRegistry` | Gains the required `titleMode` field; remains the owner of route icons via `getPaneRouteIcon`, which the tab consumes. |
| Pane runtime (`useSetPaneTitle`) | Unchanged API. Dynamic bodies conform to §4 — publish `null` while loading. |
| `WorkspaceHost` | Threads `titleState`; title telemetry switches from `titleSource` to `titleState`. |
| `PaneShell` / `SurfaceHeader` | Gain `titlePending`; the pane header shows the same skeleton as the tab — the §1.3 fix is not strip-only. |
| `CommandPalette` | Consumes the new descriptor; renders `title` text, ignores `titleState`. |
| Keybindings | Unchanged. `Delete`/`Backspace` close stays on the tab; `pane-next`/`pane-previous` (workspace.md) unaffected. |
| `Button` | No longer used by the strip. The strip stops being a `Button` consumer entirely. |
| Telemetry (`emitWorkspaceTelemetry`) | The `title` event reports `titleState`; panes stuck `pending` become observable. |

## 7. Rules & invariants

- **Hard cutover.** The triple-`Button` tab, the `min-width: 96px` floor, the
  `currentColor` focus outline, and the `titleSource` field are deleted — not
  flagged, not commented, not kept beside the new code. One tab implementation,
  one title model.
- **No `Button` on this surface.** The tab owns its structure and CSS. `Button`'s
  base class never touches a tab again.
- **One title owner.** `resolveWorkspacePaneTitle` is the sole resolver; `pending`
  is a first-class value, never a placeholder string.
- **Total truncation chain.** Every element from `.tab` to `.title` carries
  `min-width: 0`; the ellipsis is computed against the real available width.
- **No layout shift.** Action width is reserved in every state; hover reveals via
  `opacity` only.
- **Tokens only.** Every colour, space, radius, duration, and easing is a design
  token from `globals.css`. No literal colours; the sole literal length is the
  240px `max-width`, commented.
- **Accessibility.** The strip stays a `role="toolbar"` with roving focus; every
  tab — including a `pending` one — has an accessible name; the focus ring is the
  `--ring` token; motion respects `prefers-reduced-motion`.
- **Desktop only.** No mobile surface changes; the strip remains desktop-only.
- **Imports** rise at most two levels, else the `@/` alias (`codebase.md`).
- **No dead code or dead CSS** in the final state.

## 8. Final state

- `WorkspacePaneStrip` renders `PaneTab` × N. No `Button` import. The toolbar,
  roving focus, and keyboard handlers are unchanged.
- A tab hugs its content, left-aligns its title, truncates with a real ellipsis,
  and never overextends. No tab is wider than `icon + title + actions`.
- A tab has a route icon, a rounded top, a visible hover, an unmistakable active
  state (canvas fill + accent top), a legible in-view marker, animated state
  transitions, and an on-token focus ring.
- `PaneRouteDefinition.titleMode` exists on all 25 routes;
  `resolveWorkspacePaneTitle` returns `{ title, titleState }`; `titleSource` is
  gone.
- A dynamic pane shows a skeleton — in both the tab and the pane header — until
  its body publishes a title; it never shows a category word as a title. An epub
  tab shows the book title; a failed pane shows a deterministic fallback.
- The 8 dynamic pane bodies conform to the §4 contract.
- `docs/workspace.md` §5.4 cross-references this document for the marker's looks.

## 9. Key decisions

1. **The tab is not a `Button`.** `Button` imposes centring, semibold weight,
   `--radius-lg`, and an unshrinkable `.label` wrapper — the direct causes of
   defects 1.1, 1.2, and 1.4. A purpose-built tab is the fix; reusing `Button`
   and overriding it is how the strip reached this state.
2. **Hug content; no `min-width` floor.** A tab is as wide as its label needs,
   capped at 240px. This is what a pane tab — closest in kind to a browser tab —
   should do, and it eliminates the dead gutters directly.
3. **Pending is a first-class title state.** The §1.3 bug exists because the
   model had no value for "not known yet," forcing a placeholder. Adding
   `titleState: "pending"` removes the need for any placeholder and fixes the bug
   at the root, for every dynamic pane, not just media.
4. **"Media" is not rewritten.** It is a correct *route label* and stays as one
   (for `aria-label`, the palette, the tooltip). The fix is to stop *rendering a
   route label as a tab title*, not to invent new copy.
5. **A skeleton, not "Loading…".** A skeleton reads as structure-arriving and
   needs no translation or layout estimate; placeholder text is one more string
   to be mistaken for a title — the exact failure mode being fixed.
6. **`titleMode` is explicit and required on every route.** It correlates with
   `resourceRef` today, but the two concepts (title behaviour vs. de-dup
   identity) are distinct; an explicit field will not silently rot.
7. **The route icon is shown.** It uses the existing centralised icon owner
   (`getPaneRouteIcon`), sharply raises scannability across a 12-tab strip, and
   gives a `pending` tab a stable identity while its title is a skeleton.
8. **Actions reveal on hover/focus/active; their width is always reserved.**
   Revealing on `opacity` alone keeps idle strips calm without any layout shift;
   reserving width means a hover never resizes a tab.
9. **Action buttons leave the roving sequence (`tabIndex={-1}`).** Today they are
   silently tabbable, violating the one-stop-per-tab toolbar contract. Keyboard
   close stays `Delete`/`Backspace`; keyboard minimize is dropped from the strip
   (a low-frequency action; the pane chrome remains its home) — a deliberate,
   documented cut, consistent with "no backward compatibility".
10. **The pane header gets the same fix.** The descriptor feeds both the tab and
    `SurfaceHeader`; fixing only the strip would leave the header flashing
    "Media". `titlePending` threads to both.
11. **The command palette does not skeleton.** Surface-appropriate: a transient
    text list shows the route label; persistent chrome (tab, header) shows a
    skeleton.

## 10. Acceptance criteria

Sizing & truncation:

- [ ] A short-titled tab ("Search") is only as wide as its icon, label, and
      actions — no centred gutters, no 96px floor.
- [ ] A long title truncates with an ellipsis inside the tab; no text crosses the
      tab's edge.
- [ ] Hovering a truncated tab shows the full title via the native tooltip.
- [ ] A tab never grows to fill spare strip width; the strip scrolls when tabs
      overflow.

Visual system:

- [ ] Hovering an inactive tab produces a clearly visible background change.
- [ ] The active tab is unmistakable: canvas fill + a 2px accent top bar.
- [ ] The in-view marker is legible and composes with the active state on one
      tab.
- [ ] All state changes animate with `--duration-fast`/`--ease-glide`; instant
      under `prefers-reduced-motion`.
- [ ] Focus-visible shows the `--ring` outline; no `currentColor` outline
      remains.

Title lifecycle:

- [ ] An opening epub tab shows a skeleton, then the book's title — never
      "Media".
- [ ] Every dynamic pane type (PDF, epub, podcast, video, library, conversation,
      author, page, note) shows a skeleton while loading and a real title after.
- [ ] A static pane (Libraries, Search, Settings) shows its name immediately,
      with no skeleton.
- [ ] A pane whose load fails shows a deterministic fallback title, not a
      perpetual skeleton.
- [ ] The pane header shows the same skeleton-then-title as its tab.

Keyboard & accessibility:

- [ ] `ArrowLeft`/`Right`/`Home`/`End` rove between tabs; `Delete`/`Backspace`
      closes the focused pane.
- [ ] The action buttons are not in the tab sequence.
- [ ] A `pending` tab has an accessible name and `aria-busy`.

Cutover:

- [ ] `WorkspacePaneStrip` imports no `Button`; `titleSource` exists nowhere;
      no `min-width: 96px` and no `currentColor` outline remain.

## 11. Test plan

- `WorkspacePaneStrip.test.tsx` (updated, `apps/web/src/__tests__/components/`) —
  item fixtures gain the required `href` and `titleState`. Adds: a `pending`
  item renders a skeleton and no title text; a `resolved` item renders text; the
  activator has an `aria-label` and `aria-busy` while pending; action buttons are
  `tabindex="-1"`; roving focus, minimize/restore/close, and `Delete` close are
  unchanged.
- `store.test.ts` (updated/added) — `resolveWorkspacePaneTitle`: a runtime title
  ⇒ `resolved`; a `dynamic` route with no runtime title ⇒ `pending`; a `static`
  route ⇒ `resolved`; `title` is always non-empty.
- `mediaFormatting.test.ts` (new) — `buildCompactMediaPaneTitle` returns `null`
  for nullish/untitled media and the compact `"Title · Author"` form otherwise.
  The §4 body contract is otherwise enforced by `titleState` typing and the e2e
  spec; the bodies' one-line `useSetPaneTitle` calls are not separately
  unit-tested.
- `e2e/tests/workspace-tabs.spec.ts` (new) — desktop: panes appear as strip
  tabs; a dynamic pane's tab shows the resolved resource title, never a category
  word; the active tab carries `aria-current="page"`; close and `Delete` remove
  a pane; `ArrowRight` roves between tab activators.
- `typecheck` + `lint` (`--max-warnings 0`) + `test:unit` green; a final
  dead-code / dead-CSS sweep.

## 12. Implementation phases

Each phase compiles and leaves the suite green; all land on
`workspace-pane-tabs`.

1. **Part A — the tab.** Add `PaneTab`; rewrite `WorkspacePaneStrip.tsx` to
   render it and `WorkspacePaneStrip.module.css` to the §5.9 system; remove the
   `Button` dependency and the `min-width` floor. The strip still receives a
   plain `title` string and `href`; no `titleState` yet. Fixes defects 1.1, 1.2,
   1.4. Independently shippable.
2. **Part B — the title model.** Add `titleMode` to the registry;
   `resolveWorkspacePaneTitle` returns `titleState`; thread it through
   `WorkspaceHost`, the strip item, `PaneTab` (skeleton branch),
   `PaneShell`/`SurfaceHeader`, and the telemetry. Fixes defect 1.3.
3. **Body conformance + docs + sweep.** Conform the 8 dynamic pane bodies to §4;
   trim `docs/workspace.md` §5.4; tests per §11; reduced-motion pass; dead-code /
   dead-CSS sweep.

## 13. Scope & non-goals

**In scope:** the rebuilt `PaneTab`; the content-hugging width + truncation
model; the full visual system (icon, radius, hover, active, in-view, transitions,
focus); the `titleMode`/`titleState` pending model and its skeleton in the tab
and the pane header; conforming the 8 dynamic pane bodies; the `Button`
decoupling.

**Non-goals:** drag-to-reorder tabs; pinned tabs; a tab context menu; a tab
overflow / "all tabs" dropdown (the strip scrolls — workspace.md owns that); a
custom tooltip component (the native `title` attribute is used); the canvas,
scroll, drag, edge-fade, or `IntersectionObserver` mechanics (owned by
workspace.md); the workspace store schema; the command palette internals beyond
the descriptor-shape update; mobile (no strip); a keyboard path for minimize on
the strip (§9.9).

## 14. Files

New:

- `docs/workspace-tabs.md` — this document.
- `e2e/tests/workspace-tabs.spec.ts`.
- `apps/web/src/app/(authenticated)/media/[id]/mediaFormatting.test.ts`.

Modified:

- `apps/web/src/components/workspace/WorkspacePaneStrip.tsx` + `.module.css` —
  rebuilt: internal `PaneTab`, no `Button`, `WorkspacePaneStripItem` gains
  `href` + `titleState`, the §5.9 visual system.
- `apps/web/src/lib/panes/paneRouteRegistry.tsx` — required `titleMode` on
  `PaneRouteDefinition` / `ResolvedPaneRoute` and every route.
- `apps/web/src/lib/workspace/store.tsx` — `resolveWorkspacePaneTitle` /
  `WorkspacePaneTitleDescriptor`: `titleState` replaces `titleSource`.
- `apps/web/src/components/workspace/WorkspaceHost.tsx` +
  `apps/web/src/lib/workspace/telemetry.ts` — thread `titleState`; the `title`
  telemetry event reports `titleState`.
- `apps/web/src/components/workspace/PaneShell.tsx` — `titlePending` passthrough.
- `apps/web/src/components/ui/SurfaceHeader.tsx` + `.module.css` — `titlePending`
  → skeleton heading with an `sr-only` name.
- `apps/web/src/app/(authenticated)/media/[id]/mediaFormatting.ts` —
  `buildCompactMediaPaneTitle` returns `null` for nullish/untitled media.
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`,
  `notes/[blockId]/NotePaneBody.tsx`, `libraries/[id]/LibraryPaneBody.tsx`,
  `conversations/[id]/ConversationPaneBody.tsx`,
  `podcasts/[podcastId]/PodcastDetailPaneBody.tsx`,
  `authors/[handle]/AuthorPaneBody.tsx`, `pages/[pageId]/PagePaneBody.tsx`,
  `daily/DailyNotePaneBody.tsx` — conformed to the §4 publishing contract.
- `docs/workspace.md` — §5.4 marker CSS trimmed to a cross-reference.
- `apps/web/src/__tests__/components/WorkspacePaneStrip.test.tsx`,
  `apps/web/src/lib/workspace/store.test.ts` — fixtures and resolver coverage.

`CommandPalette` consumes `resolveWorkspacePaneTitle` but reads only
`descriptor.title`, so the `titleSource` → `titleState` rename needed no edit
there.

## 15. Risks

| Risk | Mitigation |
|---|---|
| A fast-loading pane shows a brief skeleton blink. | Accepted: the skeleton is the honest state of a pending title; a short flash is correct, and far better than rendering a wrong word. No artificial delay — that is complexity hiding a non-problem. |
| A dynamic body never publishes ⇒ a permanent skeleton. | §4 mandates publishing at every terminal state, including errors; §11 tests assert it per body; the `titleState` telemetry surfaces any pane stuck `pending`. |
| Reserving action width makes short tabs a little wider. | This is real tab chrome, not a dead gutter; reserving it is the price of a zero-layout-shift hover, and tabs still hug — no `min-width` floor remains. |
| Dropping the strip's keyboard minimize is a regression. | Deliberate (§9.9): minimize is low-frequency and the action was only ever reachable via a roving-tabindex bug; it stays available from the pane chrome. Documented, not silent. |
| `docs/workspace.md` and this doc both touch the in-view marker. | Ownership is split explicitly (§6): workspace.md keeps the concept and mechanics, this doc owns the marker's appearance, and workspace.md §5.4 is trimmed to a link — satisfying `docs/rules/index.md`. |
| `color-mix` support. | Already used in the codebase (`PaneShell.module.css`, `Pill.module.css`); no new platform assumption. |
