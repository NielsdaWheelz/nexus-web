# Workspace Target Activation — Hard Cutover

**Status:** Implemented and locally verified · 2026-07-27 · adversarially reviewed

**Type:** Frontend hard cutover

**Questions:** None. The decisions below are closed for this slice.

**Governing standards:** `docs/rules/{boundaries,cleanliness,codebase,frontend,
simplicity,testing,control-flow}.md`.

This document supersedes the target-activation vocabulary, APIs, and pane-choice
rules in earlier cutover documents. Those references remain historical decision
context, not supported implementation instructions.

## Decision

All supported internal target activation uses one workspace capability:

| Intent | Target already open | Target not open |
|---|---|---|
| Plain click / `Enter` — `Follow` | Activate and restore that pane | Navigate the origin pane |
| `Shift`+click — `Fork` | Create and activate another pane | Create and activate a pane |
| Named workflow — `Adopt` | Activate and restore that pane | Create and activate a pane |

`Follow` is the default. `Fork` is literal. `Adopt` is available only to named
workflows whose product contract requires preserving the origin.

The cutover removes feature-facing `openPane`, `openInNewPane`, boolean
`newPane` options, and bespoke link-modifier logic. There is no compatibility
shim or fallback path.

## Goals

1. Make every target activation predictable across pane links, App Nav,
   Launcher, global controls, citations, and resource surfaces.
2. Give route matching, pane choice, creation, history, and activation one owner.
3. Preserve real-anchor browser behavior and accessible keyboard navigation.
4. Reuse the route registry, route identity, pane history, mementos, secondary
   activation, workspace layout, and notice primitives.
5. Reduce navigation concepts and delete superseded paths.

## Non-goals

- Redesign pane routes, resource identity, workspace persistence, or URLs.
- Change backend, BFF, database, or wire schemas.
- Redesign pane chrome, sidecars, citations, reader pulses, or prefetching.
- Add drag/drop, new keyboard shortcuts, mobile gestures, or a generic command bus.
- Change external-link, download, `_blank`, or browser-tab behavior.
- Preserve old functions, events, message shapes, or call signatures.

## Scope and rules

- Frontend only; authenticated workspace only.
- A **target** is a cross-pane/product-navigation href accepted by the existing
  pane route registry.
- Exact pane identity remains the existing `hasSamePaneRoute`/route-key rule:
  route plus normalized query, ignoring hash.
- Query differences are distinct targets. Hash differences are the same target
  with a different in-pane location.
- Real anchors retain their canonical `href`.
- `Meta`/`Ctrl`+click, middle-click, downloads, `_blank`, external URLs, and
  already-prevented events remain browser- or caller-owned.
- `Shift`+click is the only pointer modifier claimed as workspace `Fork`.
- Touch and unmodified keyboard activation are `Follow`. An existing explicit
  “Open in new pane” action is `Fork`; do not invent `Shift`+`Enter`.
- Invalid routes and invalid origin pane IDs in the validated in-process
  capability are programmer errors, not fallback cases.
- Route-local controls that mutate the current view rather than follow a target
  (for example reader location, sort/filter state, or pagination) remain
  route-owned. They retain their existing `push`/`replace`/no-write policy and
  do not acquire pane disposition policy.

## Capability contract

```ts
interface WorkspaceTarget {
  href: string;
  labelHint?: string;
  secondaryActivation?: WorkspaceSecondaryActivation;
}

type WorkspaceTargetDisposition =
  | { kind: "Follow" }
  | { kind: "Fork" }
  | { kind: "Adopt" };

interface WorkspaceTargetActivationRequest {
  originPaneId: string;
  target: WorkspaceTarget;
  disposition: WorkspaceTargetDisposition;
  modality: PaneNavigationModality;
}

type WorkspaceTargetActivationResult =
  | {
      kind:
        | "Unchanged"
        | "NavigatedOrigin"
        | "ActivatedExisting"
        | "NavigatedExisting"
        | "CreatedPane";
      paneId: string;
    }
  | { kind: "Rejected"; reason: "PaneLimitReached" };
```

Expose one `activateWorkspaceTarget(request)` command from the workspace store.
Pane runtime binds `originPaneId` and exposes the same semantic operation.
Feature code supplies intent and payload; it never chooses a pane.

`secondaryActivation` is payload, not disposition. Deliver it once, after the
destination pane is selected. It must never force pane reuse or creation.

## Planning and execution

Add a pure, exhaustive planner owned by the workspace layer:

```ts
type WorkspaceTargetActivationPlan =
  | { kind: "Unchanged"; paneId: string }
  | { kind: "NavigateOrigin"; paneId: string; href: string }
  | { kind: "ActivateExisting"; paneId: string }
  | { kind: "NavigateExisting"; paneId: string; href: string }
  | { kind: "CreateAfterOrigin"; originPaneId: string; target: WorkspaceTarget }
  | { kind: "Reject"; reason: "PaneLimitReached" };
```

The planner is the sole owner of:

- supported-route validation;
- exact-target lookup;
- deterministic duplicate selection;
- disposition semantics;
- pane-limit decisions.

The store is the sole executor. It serializes pane creation/navigation,
activation, restoration, per-pane history, mementos, labeling, session state,
and secondary activation. Pane creation remains a private store primitive, not
a feature-facing navigation API.

## Selection and history rules

When multiple exact panes exist, choose deterministically:

1. the origin pane, if it matches;
2. the first non-minimized match in workspace order;
3. the first minimized match in workspace order.

Then:

- Same full href: activate/restore only; history is unchanged.
- Same route key but different href for a generic product target: push the href
  in the selected pane, then activate it. Route-local location controls are
  outside this capability and retain their feature-owned history policy.
- `Follow` with no match: push into the origin pane.
- `Fork`: create immediately after the origin and activate it, even when an
  exact pane exists. The new pane starts with empty back/forward history.
- `Adopt` with no match: create immediately after the origin and activate it.
- At `MAX_PANES`, a required creation returns `PaneLimitReached`; state and
  history remain unchanged. Show the existing non-modal notice. Never evict a
  pane silently.

## Interaction ownership

Consolidate pane and App Nav click interpretation into one shared link adapter.
It may handle an event only when all are true:

- primary-button click;
- supported internal href;
- no browser-owned modifier except `Shift`;
- no download, external target, `_blank`, or prior `preventDefault`;
- an activation origin is available.

The adapter records the existing navigation modality, prevents default only
when it owns the event, and dispatches exactly one `Follow` or `Fork`.

Rich links such as citations may attach `secondaryActivation`, but they still
dispatch through this adapter/capability. Capture and component handlers must
not both activate the same target.

## Composition

```text
anchor / row / App Nav / Launcher / global control / named workflow
  -> shared gesture or command adapter
  -> activateWorkspaceTarget
  -> pure target planner
  -> workspace store executor
  -> pane history + memento + layout + focus + secondary activation
```

Cross-frame and pre-workspace requests use one thin ingress into the same
capability. Its exact request schema is:

```ts
interface WorkspaceTargetActivationIngressRequest {
  target: WorkspaceTarget;
  disposition: WorkspaceTargetDisposition;
  modality: PaneNavigationModality;
}
```

The ingress validates unknown data, normalizes supported hrefs, and binds the
active pane as origin at receipt time. Malformed or unsupported input is
rejected/dropped at ingress and must not throw through the workspace. Queue only
until the workspace receiver is ready. Replace the old event/message name and
payload outright; do not accept both.

## Caller policy

| Caller | Disposition |
|---|---|
| Pane anchor, citation, resource row/card | `Follow`; `Shift` => `Fork` |
| App Nav, Launcher, global player/footer | `Follow`; supported `Shift` => `Fork` |
| Explicit “Open in new pane” action | `Fork` |
| Reader-to-chat and Docent walk steps that must preserve their source | `Adopt` |
| Secondary/Dossier activation | Inherits caller disposition; payload only |

Launcher resource-chat selection is the named source-preserving exception: an
ordinary `Follow` selection dispatches `Adopt`, while an explicit pointer
`Shift` selection remains literal `Fork`. Keyboard `Shift` is still ordinary
`Follow`, so it retains `Adopt`.

No other caller may choose `Adopt` without a product-level invariant documented
beside the call.

## Spatial, visual, and accessibility behavior

- `Follow` without a match changes content in place; it does not reflow panes.
- Reusing a pane restores it, makes it active, and brings it into view.
- `Fork`/new `Adopt` inserts after the origin and activates the new pane.
- Reuse existing workspace focus and reduced-motion policies; add no focus
  choreography.
- Pane-limit feedback uses the existing notice treatment; no modal or new visual
  language.
- Visible labels, hover treatment, and anchor semantics remain unchanged.

## Hard cuts

Delete or replace:

- feature-facing `openPane` and pane-runtime `openInNewPane`;
- `requestOpenInAppPane` and its old event/message/queue contract;
- `handleAppNavLinkActivation` and duplicated modifier interpreters;
- `newPane: boolean` and callback pairs such as
  `navigate` + `openInNewPane`;
- click handlers that call `router.push` for resource-like targets;
- tests and docs that encode the superseded semantics;
- silent pane eviction on user-requested creation.

Do not retain deprecated exports, aliases, adapters, dual dispatch, or fallback
branches.

## File plan

### Add

- `apps/web/src/lib/workspace/targetActivation.ts` — types and pure planner.
- `apps/web/src/lib/workspace/targetActivation.test.ts` — decision matrix.
- `apps/web/src/lib/workspace/workspaceTargetActivationIngress.ts` — sole
  external ingress.
- `apps/web/src/lib/panes/targetLinkActivation.ts` — sole browser gesture adapter.

### Change

- `apps/web/src/lib/workspace/store.tsx` — public command and sole executor.
- `apps/web/src/lib/panes/paneRuntime.tsx` — origin-bound capability.
- `apps/web/src/components/workspace/WorkspaceHost.tsx` — runtime composition.
- `apps/web/src/components/workspace/PaneRouteBoundary.tsx` — shared adapter.
- `apps/web/src/components/appnav/AppNav.tsx`
- `apps/web/src/lib/launcher/dispatch.ts`
- `apps/web/src/components/launcher/useLauncherController.ts`
- `apps/web/src/components/GlobalPlayerFooter.tsx`
- `apps/web/src/lib/resources/activation.ts`
- `apps/web/src/lib/resources/resourceActionExecution.ts`
- Resource/citation callers found by the residue gate, principally Chat,
  Connections, Reader document map, Resource Surface, Notes, Collections,
  Dossier, Stats, Oracle, and source-disclosure surfaces.
- Focused owner/component/E2E tests for the files above.
- `docs/architecture.md`, `docs/modules/workspace.md`, and
  `docs/modules/app-navigation.md`.

### Delete

- `apps/web/src/lib/panes/openInAppPane.ts`
- `apps/web/src/lib/panes/paneLinkNavigation.ts`
- `apps/web/src/components/appnav/navActivation.ts`
- Their superseded tests after equivalent coverage exists at the new owners.

### Unchanged

- Persisted `WorkspaceState` schema and migrations.
- Pane route registry/model and resource locator.
- Backend/BFF/database contracts.
- Secondary activation and reader/note pulse models.
- Workspace session, prefetch, and sidecar ownership.

## Implementation order

1. Write failing planner and gesture-adapter tests.
2. Add the planner/types; make the store the only executor.
3. Bind the capability through pane runtime and workspace host.
4. Cut Pane Route Boundary and App Nav to the shared gesture adapter.
5. Cut Launcher, ingress, global controls, resource activation, and rich links.
6. Remove old APIs/files and run residue searches.
7. Update focused component/E2E coverage and current architecture docs.

Migrate each caller and remove its old path atomically. Never leave dual
dispatch.

## Acceptance criteria

1. Plain activation with no exact pane changes the origin pane; pane count is
   unchanged.
2. Plain activation of a visible exact pane activates it without mutating the
   origin or duplicating the target.
3. Plain activation restores and activates an exact minimized pane.
4. A hash-only generic target pushes in the selected exact pane; route-owned
   reader/location controls retain their existing replace/no-write contract. A
   query-distinct product target follows normal distinct-target rules.
5. `Shift`+click always creates a fresh pane after the origin, including when
   exact duplicates exist.
6. `Meta`/`Ctrl`+click, middle-click, external links, downloads, and `_blank`
   retain native behavior; anchors remain usable with `Enter`.
7. App Nav, Launcher, global controls, resource surfaces, and citations obey
   the same contract. One gesture causes one activation.
8. Named `Adopt` workflows preserve their origin and reuse an exact destination.
9. Pane-cap rejection is atomic, visible, and never evicts another pane.
10. Activation preserves existing history, memento, labeling, focus,
    reduced-motion, session, and secondary-activation contracts.
11. No backend or persisted-workspace schema changes are present.
12. Production source contains no superseded API/event symbols or boolean pane
    disposition.

## Focused verification

- Unit: planner matrix for every disposition, match state, hash/query case,
  duplicate selection, minimized pane, and pane cap.
- Browser/component: plain, `Shift`, native modifiers, keyboard, rich-link
  single dispatch, App Nav, Launcher, global player, and notice behavior.
- Store: observable pane order, active pane, minimized state, per-pane history,
  memento, and secondary activation.
- Real-stack E2E:
  - plain link replaces its source pane;
  - plain link activates visible and minimized existing targets;
  - `Shift` creates a duplicate target pane;
  - back/forward stays pane-local after follow/reuse;
  - App Nav and one citation exercise the same contract.

Run only the focused owner tests and the relevant workspace/app-navigation E2E
files. Do not substitute broad mocks for the real workspace route/history path.

Residue gate:

```sh
rg -n \
  '\bopenPane\b|openInNewPane|requestOpenInAppPane|NEXUS_OPEN_PANE|handlePaneInternal|handleAppNavLinkActivation|\bnewPane\b' \
  apps/web/src
```

Expected production matches: zero. Review any test fixture match; do not waive
production residue.
