# Pane Header Contributor Links Hard Cutover

Status: IMPLEMENTED AND VERIFIED — 2026-07-26
Type: hard cutover
Date: 2026-07-26

## Decision

Resolved contributor credits in resource pane headers are native author links.
Unresolved credits remain text. The header renders a bounded prefix—two credits
on desktop, one on mobile—and a noninteractive `+N`. `Credits…` remains the one
complete-credit disclosure.

This supersedes every rule and test requiring compact header credits to be
noninteractive.

Open questions: none. No legacy render, feature flag, fallback, compatibility
prop, or dual behavior survives.

Governing rules: `docs/rules/frontend.md`, `boundaries.md`, `cleanliness.md`,
`simplicity.md`, `codebase.md`, `naming.md`, `control-flow.md`, and
`testing.md`.

## Goals

- Make the persistent credit useful without turning the 60px header into a
  toolbar.
- Preserve pane-native navigation, credit truth, author naming, role order,
  mobile density, and drag behavior.
- Reuse the existing credit model, grouping owner, author route, pane link
  handler, intent warmer, focus language, and complete-credit overlay.
- Add one behavior path and remove the obsolete noninteractive contract.

## Scope

In scope:

- ready resource-header credit rendering;
- desktop and mobile header projections;
- workspace Follow/Fork, modified-click, intent-warm, focus, and drag behavior;
- directly affected tests and documentation.

Non-goals:

- no backend, database, BFF, endpoint, wire-schema, contributor-resolution,
  permission, author-page, editor, or Credits-overlay redesign;
- no hover card, preview, tooltip system, container measurement, `ResizeObserver`,
  adaptive credit count, user preference, or new pane action;
- no global link/chip/list abstraction;
- no resource-header rollout to additional routes;
- no change to title, header height, pane sizing, mobile controls, or credit
  ordering.

## Target Behavior

| Case | Result |
|---|---|
| Credit has `href` | Literal credited name is an `<a>` to that canonical author route |
| Credit lacks `href` | Literal credited name is plain text |
| Primary activation | Dispatch workspace `Follow`: reuse an exact pane or navigate the origin |
| Shift + pointer activation | Dispatch workspace `Fork`: create a fresh sibling pane |
| Cmd/Ctrl/Alt, non-primary, `target`, download | Preserve native browser behavior |
| Desktop | Render the first two credit items |
| Mobile | Render the first credit item |
| More credits exist | Append noninteractive `+N`; `N` counts hidden credit items |
| Complete inspection | Existing `Credits…` overlay shows every group and credit |

Every resolved role is navigable, not only `author`. The displayed name remains
the credited literal; the destination remains the canonical contributor page.

## Final State

```text
media ContributorCredit[]
  -> groupContributorCredits                  existing truth/order/href owner
  -> buildMediaResourceHeader                 existing publication adapter
  -> PaneHeaderCreditGroup[]                  unchanged header data contract
  -> resolvePaneHeaderModel                   existing route-key acceptance
  -> PaneHeaderIdentity(projection)
       -> ResourceHead bounded projection
            href present -> native anchor
            href absent  -> text
            hidden tail  -> +N text

desktop anchor
  -> existing PaneRouteBoundary
  -> activateTargetAnchor
  -> workspace Follow / Fork / native browser

mobile anchor
  -> NavTopBar identity click delegate
  -> active MobilePaneChrome activation capability
  -> activateTargetAnchor
  -> the same workspace target semantics
```

There is one credit-data path and one target-link behavior owner. Desktop and
mobile differ only in projection budget and where the existing navigation
handler is reached.

## Data And Capability Contract

Keep the existing model:

```ts
interface PaneHeaderCredit {
  readonly label: string;
  readonly href?: string;
}
```

- `href` present is the navigation capability.
- `href` omitted is a truthful unresolved text fact.
- Do not add `isClickable`, `canNavigate`, a second handle, or a fallback href.
- `ResourceHead` consumes `href` verbatim. It does not resolve identities,
  synthesize routes, validate trusted data again, or infer from role.
- Existing publication validation continues to require nonempty labels and
  nonempty groups. Producers remain responsible for canonical hrefs.
- `PaneHeaderModel`, `PaneHeaderPublication`, publication equality, backend
  `ContributorCreditOut`, and API responses do not change.

The responsive projection is explicit:

```ts
type PaneHeaderProjection = "Desktop" | "Mobile";

PaneHeaderIdentity({
  id,
  model,
  projection,
});
```

`SurfaceHeader` passes `"Desktop"`. `NavTopBar` passes `"Mobile"`.
`PaneHeaderIdentity` maps those to required `ResourceHead` budgets `2` and `1`.
Do not derive the projection from viewport CSS or measure available width.

Mobile chrome gains one ephemeral, required capability:

```ts
interface MobilePaneChrome {
  // existing data...
  activateIdentityAnchor: (
    event: TargetLinkMouseEvent,
    anchor: HTMLAnchorElement,
  ) => void;
}
```

- `PaneShell` publishes the callback for the active pane.
- The callback records pointer/keyboard modality, then calls the existing
  `activateTargetAnchor`.
- Export the existing `TargetLinkMouseEvent` event pick because this real second
  consumer needs the target-link handler contract; `detail === 0` means keyboard
  and every other value means pointer.
- It is runtime-only: never place it in `PaneHeaderModel`, a publication,
  workspace persistence, or wire data.
- Do not recreate the deleted pane-link runtime or bypass workspace target
  activation.

No API route, request, response, capability registry, or persistence change is
permitted.

## Projection Rules

Flatten credit items in current group and item order, take the projection
budget, then reconstruct only the visible group grammar:

- names within a visible group: `, `;
- visible groups: ` · `;
- visible authors: no visual prefix; retain sr-only `Authors: `;
- other visible groups: existing canonical label plus `: `;
- append ` +N` when items remain;
- `+N` has accessible text `N more credits`, is not a link or button, and does
  not open the overlay;
- do not mount hidden credits, hidden links, or hidden role labels.

The budget counts credit items, including unresolved text facts. It does not
count groups. Empty, pending, unavailable, and failed states remain unchanged.

Do not reuse `ContributorCreditList` or `ContributorChip` directly: they own a
different domain shape and wrapping surface. Reuse their established bounded
prefix and editorial-link visual language. Keep the small header projection
local to `ResourceHead`.

## Interaction, Accessibility, And Visual Rules

- Use a real anchor with `href`, not click handlers on spans.
- Each anchor carries `data-pane-label-hint={label}`, `dir="auto"`, and the full
  literal label as its accessible name and `title`.
- Use a quiet underline at rest; strengthen it on hover/focus. Focus-visible has
  a visible, unclipped ring. Color is inherited and never the only link cue.
- The anchor uses a pointer cursor and at least a 24px block target inside the
  existing 60px header.
- Each visible name token owns its ellipsis. No ancestor may visually clip a
  focusable descendant or leave an offscreen focus target.
- The title and credit rows remain single-line. Header height, control sizes,
  typography, and the 2px row gap remain unchanged.
- At 390px mobile and minimum desktop pane width, identity never overlaps
  navigation/actions and the page has no horizontal overflow.
- Header anchors remain excluded from pane drag initiation through the existing
  interactive-target rule.
- Mobile hover/focus intent calls the existing `usePaneWarm`; do not create a
  second prefetch path.

## Ownership And Files

Primary implementation owners:

- `apps/web/src/components/ui/ResourceHead.tsx`
- `apps/web/src/components/ui/ResourceHead.module.css`
- `apps/web/src/components/ui/PaneHeaderIdentity.tsx`
- `apps/web/src/components/ui/SurfaceHeader.tsx`
- `apps/web/src/components/appnav/NavTopBar.tsx`
- `apps/web/src/components/workspace/PaneShell.tsx`
- `apps/web/src/lib/workspace/mobileChrome.tsx`
- `apps/web/src/lib/panes/targetLinkActivation.ts`

Behavior tests:

- `apps/web/src/components/ui/ResourceHead.test.tsx`
- `apps/web/src/components/appnav/NavTopBar.test.tsx`
- `apps/web/src/lib/workspace/mobileChrome.test.tsx`
- `apps/web/src/components/workspace/usePaneCanvas.test.tsx`
- `e2e/tests/authors.spec.ts`
- `e2e/tests/pane-chrome.spec.ts` only if it is the existing owner of the
  required geometry assertion

Documentation cutover:

- `docs/cutovers/pane-header-identity-hard-cutover.md`
- `docs/cutovers/lightweight-author-deduplication-hard-cutover.md`
- `docs/modules/reader-implementation.md`

Do not modify contributor services, schemas, routes, formatting, the author
page, or `ResourceCreditsOverlay` unless implementation evidence disproves the
contracts above.

## Implementation Order

1. Replace obsolete zero-link assertions with failing behavior tests.
2. Add the required Desktop/Mobile projection through the two composition
   roots.
3. Render the bounded native-anchor/text projection and its styles.
4. Publish and consume the active mobile identity-anchor capability; reuse the
   pane link handler and intent warmer.
5. Replace the desktop/mobile real-stack author journey assertions.
6. Delete obsolete tests, comments, styles, and documentation. Do not retain a
   noninteractive mode.

## Acceptance Criteria

- A resolved visible credit is the only link with its literal name and canonical
  href; an unresolved visible credit is text.
- Desktop exposes at most two credit links/text facts; mobile exposes at most
  one; the hidden count is exact.
- Hidden credits are absent from DOM and tab order. `+N` is noninteractive.
- Plain, Shift, modified, keyboard, and mobile activations obey the target
  behavior table.
- Mobile activation changes the active pane without a document navigation.
- Hover/focus intent warms the author pane through the existing warmer.
- Clicking, pressing, or dragging from a credit never initiates pane drag.
- Focus is visible and unclipped; full labels remain available; 390px mobile and
  minimum desktop geometry do not overlap or overflow.
- Role labels, credit order, credited literals, pending states, and
  `Credits…` behavior are unchanged.
- There is no new backend/API/schema/capability flag, alternate credit
  formatter, generic link component, measurement loop, or compatibility prop.
- All old noninteractive requirements and zero-anchor assertions are deleted or
  rewritten.

## Verification

Run the exact affected gates:

```bash
cd apps/web && bun run test:browser -- \
  src/components/ui/ResourceHead.test.tsx \
  src/components/appnav/NavTopBar.test.tsx \
  src/lib/workspace/mobileChrome.test.tsx \
  src/components/workspace/usePaneCanvas.test.tsx

cd apps/web && bun run test:browser -- \
  src/lib/panes/targetLinkActivation.test.tsx

cd apps/web && bun run typecheck
cd apps/web && bunx eslint <touched-files> --max-warnings 0

cd e2e && bunx playwright test tests/authors.spec.ts
```

Add `tests/pane-chrome.spec.ts` only when its existing geometry fixture is used.
Do not add backend tests for an unchanged backend.

Residue review must find no owned assertion or rule that compact credits:

- contain zero anchors;
- are noninteractive/non-focusable;
- may ellipsize a focusable descendant as one unbounded line;
- render all credit items in persistent mobile chrome.
