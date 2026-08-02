# Nexus Signal System — Hard Cutover

Status: IMPLEMENTED IN SOURCE — focused exact proof complete; broad/release gates not run

Type: hard cutover; one-user prototype; production-grade invariants

Date: 2026-08-02

Open questions: none

## Decision

Cut web feedback to one **Nexus Signal System** built from the existing
`FeedbackProvider`, `FeedbackNotice`, `FieldFeedback`, `PaneLoadingState`,
`PaneSurface`, `PaneShell`, and `Button` capabilities.

Canonical feature/backend state remains authoritative. Feedback owns only
projection, dismissal timing, suppression, announcement, diagnostics rendering,
and visual choreography.

```text
canonical feature state / structured error
  -> feature-owned exhaustive *ErrorMessage mapping
  -> FeedbackContent
  -> near-origin FeedbackNotice OR detached FeedbackProvider
  -> one visual presentation + one announcement
```

Hard cutover: delete the generic API-error copy mapper, severity-derived ARIA,
the single mixed toast lane, old context methods, duplicate announcements,
equivalent bespoke loading treatments, and confirmed dead UI helpers. No flag,
alias, fallback, dual path, or compatibility export remains.

This specification supersedes only feedback/loading presentation clauses in
older cutovers. Existing lifecycle, ordering, identity, persistence, recovery,
and domain-copy contracts remain authoritative. In particular: reader-profile
global save failure becomes the persistent rail; Lectern completion Undo becomes
a HUD; Link success becomes a HUD while Link failure remains inside the open
Link surface. Stale references to a generic toast do not preserve old behavior.

## Goals And Boundary

### Goals

- Make feedback calm, causal, truthful, accessible, and visually native to the
  quiet-press art direction.
- Keep status beside the changing object; detach only harmless completion or a
  global unresolved condition.
- Represent one logical event as one evolving presentation.
- Distinguish operation lifecycle, connection observation, product failure,
  and defect.
- Make every recovery action exact: Retry, Reconnect, Reconcile, Rerun, or Undo.
- Reduce code paths and leave one owner per feedback/loading concern.

### In Scope

- Shared feedback contracts, provider, HUD lane, persistent rail, notices,
  field feedback, announcement policy, motion, and diagnostics presentation.
- All production consumers of `useFeedback`, `toFeedback`, `FeedbackNotice`,
  `FieldFeedback`, and `PaneLoadingState`.
- Same-system defect handling in `useResource`.
- Routed-pane failure accessibility and direct recovery.
- Removal of duplicate generic spinners/skeletons and live announcements when
  an existing canonical primitive owns the same concern.

### Non-Goals

- No backend/BFF route, payload, operation, SSE, job, database, or persistence
  change.
- No notification center, unread count, history, digest, push, email, native
  notification, or cross-device activity model.
- No global query/mutation/stream/job store and no `ActivitySnapshot` registry.
- No Workflow SDK, Temporal, Redis, Kafka, service worker, or new runtime.
- No stale-while-revalidate or `useResource` cache/lifecycle redesign.
- No rewrite of chat, Dossier, media, Lectern, reader-profile, or offline-media
  state machines.
- No generalized progress framework, invented percentage, ETA, sound,
  confetti, sparkle, or AI-generated product copy.
- No replacement of domain-specific skeletons that accurately match unique
  content shape.
- No new telemetry transport or observability backend; preserve existing
  structured logging and request/run/support correlation.

## Rules And Invariants

1. Domain/controller state is canonical; feedback state is disposable
   presentation state.
2. Expected errors stay structured through the feature boundary. The owning
   `*ErrorMessage` helper exhaustively produces product copy.
3. `E_INVALID_RESPONSE`, `E_UNKNOWN`, `E_INTERNAL`, unknown non-modeled errors,
   and impossible states rethrow into the applicable boundary. They never
   become feedback records.
4. Lifecycle and connection observation remain independent. Reconnect never
   retries, replays, or reruns work.
5. Ordinary visible success is silent.
6. HUD content is harmless to miss. Its actions are optional accelerators also
   reachable from durable UI.
7. Required action or unresolved global failure uses the persistent rail; it
   never expires or evicts.
8. One stable key identifies one detached logical presentation. Republishing
   updates it in place.
9. One transition has one primary visual projection and one assistive
   announcement. Secondary visual projections use `None` announcement.
10. Tone never selects urgency. Announcement policy is explicit.
11. Determinate progress uses real units. Known phases use feature copy.
    Unknown work uses indeterminate activity without percentage or ETA.
12. Loading preserves committed content unless the canonical owner has no
    committed content.
13. Motion explains causality, uses transforms/opacity, stops at terminal
    state, and preserves meaning under reduced motion.
14. Request/support/run IDs remain available as secondary copyable diagnostics;
    raw codes and internal messages are not primary copy.
15. Detached records are browser-memory only. Reload reconstructs truth from
    feature owners; the provider promises no durability.

## Capability Contract

| Situation | Sole projection |
| --- | --- |
| Fast visible success | Resulting object/control; no feedback record |
| Local mutation | `Button.loading` or resource-row state |
| Initial generic pane load | `PaneLoadingState` in `PaneSurface.state` |
| Pane refresh | Existing `PaneShell` refresh indicator/announcement |
| Domain long-running work | Existing feature controller and surface |
| Harmless detached completion | HUD |
| Global unresolved/action-required state | Persistent rail |
| Field validation | `FieldFeedback` associated to its control |
| Surface/pane modeled failure | `FeedbackNotice` near recovery action |
| Connection loss | Feature-owned neutral reconnect presentation |
| Routed-pane defect | Pane error boundary with focus-safe Retry |
| Workspace/bootstrap defect | Existing authenticated workspace boundary |

`PaneSurface` places state; it does not own state semantics. `PaneShell` keeps
refresh ownership. Chat failure/reconnect/suspension, Dossier progress, Lectern
FIFO outcomes, reader-profile persistence, and offline-media announcements
remain their feature owners and adapt only at presentation boundaries.

## Browser Contract

```ts
export type FeedbackTone =
  | "Neutral"
  | "Info"
  | "Success"
  | "Warning"
  | "Danger";

export type FeedbackAnnouncement = "None" | "Polite" | "Assertive";

export interface FeedbackContent {
  tone: FeedbackTone;
  title: string;
  message?: string;
  requestId?: string;
}

export interface FeedbackAction {
  label: string;
  onClick: () => void;
}

export type FeedbackActions =
  | readonly [FeedbackAction]
  | readonly [FeedbackAction, FeedbackAction];

export type DetachedFeedback =
  | {
      kind: "Hud";
      key?: string;
      content: FeedbackContent;
      actions?: FeedbackActions;
    }
  | {
      kind: "Persistent";
      key: string;
      content: FeedbackContent;
      announcement: "Polite" | "Assertive";
      actions?: FeedbackActions;
    };

export interface FeedbackContextValue {
  publish(signal: DetachedFeedback): void;
  resolve(key: string): void;
  suppress(key: string): () => void;
}
```

Contract rules:

- `Hud` is always polite. It lasts five seconds without actions and ten seconds
  with actions. These are provider-owned named constants; callers cannot set
  arbitrary durations.
- At most three HUDs render. Eviction is admissible because HUDs are harmless to
  miss. Persistent records use a separate uncapped, non-evicting lane.
- A persistent owner republishes while unresolved and calls `resolve` when its
  canonical state leaves failure. It does not mirror lifecycle in the provider.
- Same-key content updates in place. Identical republishes do not restart motion
  or announcement.
- `suppress(key)` hides and silences a detached record while a scoped owner
  presents it locally. Releasing the lease restores the visual record without
  reannouncement unless content changed.
- Actions are browser callbacks because records are not persisted. A persisted
  semantic-action schema is out of scope.
- `show`, `dismissByDedupeKey`, `suppressDedupeKey`, caller `duration`, generic
  action arrays, `severity`, and severity-to-role helpers are deleted.

Shared component contracts:

```ts
FeedbackNotice({
  content: FeedbackContent,
  announcement: FeedbackAnnouncement,
  actions?: FeedbackActions,
  children?: ReactNode,
}): JSX.Element;

FieldFeedback({
  id: string,
  content: FeedbackContent | null,
}): JSX.Element | null;

PaneLoadingState({
  label: string,
  announcement: "None" | "Polite",
}): JSX.Element;
```

`FeedbackNotice` maps `None` to visual-only markup, `Polite` to a status region,
and `Assertive` to an alert. `FieldFeedback` has no implicit alert role; the form
owner associates it through `aria-describedby` or `aria-errormessage` and owns
submit-summary focus/announcement.

## Composition And Ownership

| Concern | Owner |
| --- | --- |
| Structured feature state/errors | Existing feature controller/domain model |
| Error-to-product-copy mapping | Feature-local exhaustive `*ErrorMessage` |
| Same-system defect classification | `lib/api/client.ts` |
| Initial query state | Existing `useResource` |
| Pane layout/state placement | `PaneSurface` |
| Pane refresh progress | `PaneShell` |
| Local mutation busy state | `Button` or feature row |
| Detached records/suppression/timers | `FeedbackProvider` |
| Detached announcement | One pre-mounted provider live region |
| Scoped announcement | Explicit `FeedbackNotice`/`PaneLoadingState` caller |
| Feedback visual grammar | `Feedback.module.css` and existing global tokens |
| Routed-pane defect recovery | `PaneRouteErrorBoundary` |

The provider renders these children:

1. application children;
2. `PersistentFeedbackRail`, visual only;
3. `FeedbackHudViewport`, visual only;
4. one pre-mounted screen-reader announcer for detached transitions.

Neither visual lane owns a live role. The announcer owns detached speech.
Visual lanes never auto-focus. Existing modal/inert ownership governs keyboard
reachability while a modal is active. Hidden-tab and hover/focus timer pausing
remain.

## Error And Recovery Cutover

- Delete `apiErrorTitle` and `toFeedback` from `Feedback.tsx`.
- Every former `toFeedback` caller consumes its original error channel,
  rethrows same-system defects, and delegates modeled copy to one nearby
  `*ErrorMessage` helper. Shared domain mappers such as media error projection
  remain canonical and are adapted, not copied.
- The endpoint adapter decodes open `ApiError.code: string` into its owned finite
  expected-error union and defects on unknown codes. Its `*ErrorMessage` mapper
  consumes that union exhaustively. No fallback copy exists.
- `useResource` captures non-`ApiError` and `isSameSystemApiDefect` async failures
  internally and throws them during render into the applicable boundary;
  `AsyncResource<T>` gains no defect variant. Other `ApiError` values remain
  structured for endpoint/feature decoding.
- Retry stays with the owner that can safely repeat frozen intent. Reconnect,
  reconcile, rerun, replay, and Undo retain distinct labels and commands.
- A near-origin failure remains near origin. Do not publish a detached duplicate.
- Routed-pane Retry clears only that boundary's error latch and remounts the
  same route/visit. It never closes the pane or starts/retries domain work. The
  failure region receives programmatic focus once; sibling panes remain mounted.

## Loading And Art Direction

- Keep `PaneLoadingState` as the one generic pane placeholder. Its bars become
  quiet content-shaped ink with token-owned motion and an explicit static
  reduced-motion state.
- Keep `Button.loading` as the one generic control busy state. Preserve label
  width and `aria-busy`; reduced motion uses a static activity glyph rather
  than a frozen partial spinner.
- Keep accurate domain skeletons and staged progress where content shape or
  durable phases differ. Delete only equivalent generic implementations.
- Feedback uses the quiet press: paper/ink surfaces, typographic hierarchy,
  hairlines and a marginal tone rail before card fill/shadow. Danger is reserved
  for failure/destruction. Tone is redundant with icon, label, and edge shape.
- Working-to-terminal transitions update in place. Frequent actions receive no
  ceremony. Reduced motion replaces travel/pulse with immediate emphasis/fade.
- Diagnostics collapse beneath primary copy with one `Copy diagnostics` action.
- Feature wrappers may remain when they own real semantics. When their anatomy
  is icon/title/body/diagnostics/actions, they delegate visual and announcement
  behavior to the shared feedback primitive. Unique operation documents may
  keep domain markup but follow the explicit announcement and token rules.

## Files

Primary modifications:

- `apps/web/src/components/feedback/Feedback.tsx`
- `apps/web/src/components/feedback/Feedback.module.css`
- `apps/web/src/__tests__/components/Feedback.test.tsx`
- `apps/web/src/components/workspace/PaneLoadingState.tsx`
- `apps/web/src/components/workspace/PaneLoadingState.module.css`
- `apps/web/src/components/ui/Button.tsx`
- `apps/web/src/components/ui/Button.module.css`
- `apps/web/src/__tests__/components/ui/Button.test.tsx`
- `apps/web/src/lib/api/useResource.ts`
- `apps/web/src/lib/api/useResource.test.tsx`
- `apps/web/src/components/workspace/WorkspaceHost.tsx`
- `apps/web/src/components/workspace/WorkspaceHost.module.css`
- `apps/web/src/components/workspace/WorkspaceHost.test.tsx`

Required consumer migration:

- All production imports/calls of the removed feedback API.
- `lib/reader/ReaderProfileSaveFeedback.tsx` and its Settings suppression owner.
- `lib/lectern/useCompletionUndo.ts`.
- `lib/reader/useLinkComposer.ts`.
- Other consumers migrate mechanically according to the capability table;
  product-specific state machines are not rewritten.

Deletion targets:

- `apps/web/src/lib/ui/useOptimisticAction.ts` after final reference search
  confirms it remains unused.
- Generic error-title mapper and fallback branches.
- Old mixed-toast record/types/methods and arbitrary-duration behavior.
- Duplicate live roles/regions presenting the same transition.
- Orphaned spinner/skeleton CSS and tests that preserve removed APIs.

Do not create a barrel, compatibility re-export, alias, adapter preserving the
old API, or second feedback stylesheet.

## Implementation Order

1. Add the final contracts and provider lanes in one owner; update provider
   behavior tests.
2. Cut canonical primitives to explicit announcement/tone contracts and finish
   reduced-motion/art-direction CSS.
3. Migrate every consumer; move modeled error copy to feature-owned mappers and
   reclassify defects.
4. Harden `useResource` and routed-pane failure recovery.
5. Delete old APIs, duplicate paths, dead helper/styles/tests, then run static
   absence gates.
6. Verify focused owner lanes, then full frontend checks. No old/new path may
   coexist in the finished tree.

## Acceptance Criteria

- Ordinary visible success produces no detached feedback.
- A HUD cannot contain required or exclusively available action/content.
- Persistent records do not time out, cap, evict, or disappear until owner
  resolution; same-key updates preserve identity.
- Reader-profile inline suppression produces one visual presentation and one
  announcement.
- Completion Undo remains exactly ten seconds; equivalent durable recovery
  remains available through resource controls after expiry.
- Link failure stays in the Link surface with exact Retry; success HUD actions
  are optional shortcuts available elsewhere.
- Reconnection never invokes retry/rerun; suspension never offers user replay.
- Same-system defects and feature-unknown error codes reach the applicable error
  boundary and never render mapped product feedback.
- Routed-pane failure preserves sibling panes, receives semantic announcement,
  and offers direct focus-safe Retry.
- Initial pane, button, refresh, and domain-operation loading each use their sole
  documented owner; no equivalent generic spinner/skeleton remains.
- Tone and announcement are independently testable. Exactly one detached live
  region is mounted before updates.
- HUD timers pause while hidden and while hovered/focused. Identical same-key
  publication neither reanimates nor reannounces.
- Light, night, high-contrast, 200% text, narrow mobile, keyboard-only,
  screen-reader, and reduced-motion states preserve copy, action, focus, and
  hierarchy without obstructing app chrome.
- Product copy never exposes raw internal error text as the primary message;
  correlation IDs remain copyable.
- Final searches find no production `toFeedback`, `apiErrorTitle`, `.show(` on
  feedback context, removed context methods, caller `duration`, severity-role
  inference, or `useOptimisticAction`.
- `make test-front-unit`, `make test-front-browser`, and `make check-front` pass.

## Final State

Nexus has one feedback capability with two detached presentation classes,
explicit announcement policy, feature-owned product copy, boundary-owned
defects, canonical loading owners, and one quiet-press visual grammar. Nothing
persists presentation state, duplicates feature truth, or grows an engagement
inbox. Every surviving abstraction has a live owner and one primary form.
