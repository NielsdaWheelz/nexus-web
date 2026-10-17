# compact feedback cutover

status: implemented; browser acceptance verified; native runtime limits remain recorded in verification.
origin: 2026-10-16 owner direction and three-specialist source review; baseline `69c00182c832`.

## goal and settled scope

make the state of the work obvious: a short fact, the useful action, then optional explanation. ordinary work should leave the content alone. delight comes from precision, quiet typography, stable controls and immediate response.

one shared visual language; two scopes: local to the affected field/control/row/pane, or workspace-wide. evolve `components/feedback`, not a new notification framework. cover hosted web, public/auth surfaces, standalone shelf and extension popup; preserve native operating-system feedback.

approved: compact collapsed presentation; primary action immediately available; secondary choices in disclosure; reader `return` direct and `read from here` inside disclosure. unconfirmed source-refresh and metadata-research admissions survive reload and full app restart. ONLY those two admissions gain persistence here. other domains keep their existing command owners and persistence contracts.

non-goals: notification inbox/history, push/email, preferences, new backend service/schema, general command journal, universal retry/cancel/undo, replacement import polling, new design system, unrelated chat/library/notes/ordering semantics. no compatibility aliases, feature flags, dual rendering paths or legacy storage migration.

## behavior contract

| surface | use | collapsed behavior | lifetime |
| --- | --- | --- | --- |
| status | normal capability or activity | quiet fact beside the relevant command; no severity label | authoritative state |
| notice | action needed; content remains usable | self-contained fact + primary action + optional disclosure | owner state |
| surface state | first load, empty result, expected load failure, contained defect | shared typography/actions inside the existing pane layout | owner state |
| field feedback | invalid input | reason adjacent to and described by the field | field validity |
| receipt | redundant acknowledgement of an observed result | summary only; no controls or details | five visible seconds |
| offer | optional, still-valid action such as exact finish undo | fact + action; explicitly dismissible | used, dismissed or invalidated by owner |
| workspace condition | shared problem or unresolved work surviving its view | highest-priority fact + action + remaining count | owner settlement; never dismissal |

rules:

- local is the default. use workspace scope for session/workspace health or a continuing command whose origin may disappear. no pane notification queue. opening another pane never retargets an earlier command or its recovery.
- loading, refreshing, empty, failed, unavailable, accepted, completed and unconfirmed are different states. an empty view requires a successful read. retained data stays usable during refresh failure and is labelled stale only when that is known.
- recovery belongs to the operation owner. render only a supported action with an exact target and replay policy. retrying a read, reconnecting an existing run and starting new work are different verbs. a refresh read alone does not settle an uncertain write.
- hiding details never resolves work. no timer or count limit discards required recovery or a sole valid inverse. pressing an action does not remove its notice before its owner reports the result.
- primary action takes one activation. disclosure is a separate control; the whole row is not a disguised button. secondary action/diagnostics take one additional activation. stop/cancel and explicit conflict choices remain feature controls when the task requires them directly.
- busy changes retain the same action element, label and dimensions. use `aria-busy`, `aria-disabled` and an activation guard; do not remount on label changes or remove a focused retry while its request runs.
- existing modeled-error, auth and defect classification remains authoritative. no catch-all conversion to retry, raw stack trace as copy, error-string parsing or broadening of admitted transport codes.

## anatomy, expansion and accessibility

use existing font, room/theme, spacing, border, motion and semantic-color tokens. starting geometry: 13px status text, optional 16px glyph, 8px gaps, 32px desktop controls, at least 44px with any coarse pointer. critical text wraps at narrow widths/zoom; these are minimum controls, not fixed row heights. no 3rem tone column, literal “warning/info/error” label, ornamental colored slab, routine success card or perpetual spinner.

summary, primary action and disclosure anchor keep their positions during expansion. ordinary inline details expand below; reader chrome and workspace details use the existing `FloatingActionSurface`/overlay positioning so expanding them does not shift the reading text. reuse `Button`, native anchors, `PaneSurface`, `PaneLoadingState`, overlay focus/Escape rules and mobile viewport measurement. no new overlay manager, modal or bottom sheet for feedback. standalone renderers require no authenticated workspace provider.

disclosure uses `aria-expanded`/`aria-controls` and a unique target id. inline details keep natural tab order. an explicitly opened portaled disclosure focuses its first control, else its labelled region; shift-tab from the first returns to the trigger, tab after the last closes and continues after the trigger, and escape closes/returns to the trigger. outside press does not steal focus back. extend the existing floating surface with the required opt-in focus/id options and reuse overlay focus helpers; its current portal alone does not provide this behavior. no focus trap for nonmodal details.

workspace uses ONE in-flow bottom slot, registered with existing mobile clearance above player/keyboard/safe-area surfaces. no permanent empty strip. conditions rank `Write` (unconfirmed/unsynced write), `Action` (blocked task/access), then `Status` (degraded service); offers follow. same-rank order is first occurrence. show the leading row and `+n` disclosure; expanded rows show all current items, not past receipts. clamp expansion to available viewport and allow internal scrolling without covering the leading action.

freeze leading selection and row order while expanded, focused or hovered; append new items and update the count. promote after interaction ends. never replace a command under a pointer/focus. if it becomes invalid, disable it with a reason. withdrawing a focused item returns focus to the remaining summary, else its live origin/active-pane fallback; never reclaim focus the user already moved.

while a modal is active, retain unrelated workspace conditions/offers but defer their presentation and announcements; modal-owned errors remain inside that modal. close workspace disclosure without returning focus into the covered page. when the modal closes, show the current summary; announce once only if a meaningful transition was deferred. never replay receipts. observe the existing overlay stack, not a second modal counter. existing auth/build handling remains authoritative.

receipts appear only when no condition/offer occupies the slot. one latest receipt, no queue or stack. a condition/offer immediately preempts it; suppressed receipts are silent and never replay later. receipts have no dismiss button, disclosure, link or undo, so preemption cannot remove a focused control. pause their clock while hidden or hovered. a result eligible for a receipt must already be discoverable in product state; otherwise use an untimed surface. this avoids timed-only functionality ([timing guidance](https://www.w3.org/WAI/WCAG22/Understanding/timing-adjustable.html)).

announce meaningful transitions once, politely by default; assertive only for immediate blocked input or risk to current work. workspace owns its live announcement, without nested live regions. when one condition also appears locally, only one owner announces it; inactive panes are silent. no announcement on every progress frame, render or disclosure toggle. fields use unique ids, `aria-invalid` and `aria-describedby`. no automatic focus stealing for ordinary notices ([status guidance](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)). preserve existing keyboard, announcement, forced-color and reduced-motion behavior. verify 320px width and 200% zoom; the owner waived accessibility-specific verification on 2026-10-16. motion may fade color/opacity with existing tokens; no bounce or geometry animation.

## shared api and ownership

keep existing `FeedbackTone`, `FeedbackAnnouncement`, `FeedbackContent` names and meanings. `title` is the complete short fact; `message` adds useful detail; `requestId` lives in diagnostics with copy support. content is plain text. do not add a message taxonomy or arbitrary html slots.

```ts
interface FeedbackContent {
  tone: FeedbackTone;
  title: string;
  message?: string;
  requestId?: string;
}
type FeedbackAction =
  | { label: string; onClick: () => void; commandKey?: string; busy?: boolean;
      disabledReason?: string; href?: never }
  | { label: string; href: string; onClick?: never; busy?: never };
type FeedbackActions =
  readonly [FeedbackAction] | readonly [FeedbackAction, FeedbackAction];
interface FeedbackProps {
  content: FeedbackContent;
  announcement: FeedbackAnnouncement;
  actions?: FeedbackActions;
  disclosure?: "Anchored"; // omission expands in flow
  returnFocus?: () => HTMLElement | null;
}
type WorkspaceNotice = FeedbackProps;
interface WorkspaceCondition extends WorkspaceNotice {
  priority: "Write" | "Action" | "Status";
}
type OfferNotice = WorkspaceNotice;
interface FeedbackOffer {
  update(notice: OfferNotice): void;
  withdraw(): void;
}
interface FeedbackContextValue {
  receipt(content: Pick<FeedbackContent, "tone" | "title">): void;
  offer(input: OfferNotice & { key: string }): FeedbackOffer;
}
function useWorkspaceCondition(
  key: string, notice: WorkspaceCondition | null,
): void;
```

`FeedbackStatus`, `FeedbackNotice` and `FeedbackState` are provider-free renderers of `FeedbackProps`; inline disclosure is the default, with `disclosure: "Anchored"` using the existing floating surface. `FeedbackScope` lets the existing pane supply only its announcement permission and focus destination, with no feedback state; `FieldFeedback({id, content})` remains adjacent field output. share anatomy/actions/inline disclosure internally; `FeedbackState` supplies state content inside the caller’s existing pane layout; `PaneSurface` and the feature retain layout/loading ownership. keep `FeedbackProvider` and `useFeedback`; replace `publish`/`resolve` and `DetachedFeedback` outright. remove `usePersistentFeedbackElement`: the feedback host registers its own bottom element with viewport geometry.

action slots have stable primary/secondary identity independent of label. `commandKey` names an exact command when its label can hide a changed payload (finish undo uses its media and finish revision); it survives retry/presentation handoff, while a new inverse has a different key. other actions keep ordinary label/link/publication identity. the first is direct; the second is in disclosure. a different command is a different owner transition, never a silent substitution during interaction. `disabledReason` keeps an ineligible command mounted, inert and visibly explained; it is not a busy state. navigation uses real links with native modified-click behavior. specialized comparison/task bodies remain feature-owned compositions, not `FeedbackNotice` children. migrate its two existing children in `PodcastsPaneBody.tsx` to action slots.

conditions are projections of owner state; `null` withdraws. register a continuing command from its surviving owner, not its initiating pane. keys identify one logical concern; same-key updates preserve element/order. update a stable registration in place, not effect cleanup/re-registration on each render. guarded registration tokens stay private: stale cleanup cannot withdraw a newer publication. `offer` returns an exact-publication handle: update busy/error state without republishing; updates after dismissal/replacement are no-ops. publish on the owning event, not every render. preserve exact undo payload until acknowledgement or authoritative invalidation; a failed allowed retry retains it. no presentation callback manufactures settlement.

create offers for a still-useful optional action or an optional known-failure advisory without a supported remedy; do not invent retry. ordinary success is a receipt. dismiss is unavailable while any offer action is busy. once an action creates an unresolved write, its owner projects a condition; hand off the same key without an empty frame, duplicate count or remounted action. do not update a dismissed offer as the only route for required recovery. for finish undo, consumption owns the frozen inverse and in-memory continuation, mounted from the existing `ResourceActionsProvider`; pane callers use that existing action owner. no new provider or undo persistence.

the provider owns presentation, receipt clocks, disclosure, order and announcements. its optional `returnFocus` callback supplies the shell destination when the last workspace item disappears and no connected origin remains; pane-aware lookup stays in the shell. modal-local removal returns inside its existing overlay context. it owns no network requests, command retries, persistence or history. move it from `app/layout.tsx` into `AuthenticatedShell`, below `AuthenticatedAccountProvider` and `MobileViewportProvider`, above `ReaderProvider`, workspace and continuing command owners. key this subtree by account id; remove the old nested viewport mount. move bottom-element registration out of the viewport provider into the feedback host, eliminating the inverted dependency. disposed queues ignore late publications. account departure therefore retires all offers, conditions and timers structurally; no reset api or session framework.

preserve root viewport sizing in passive layout when removing its feedback wrapper. public/auth failures use provider-free inline renderers. `app/s/page.tsx` and `shelf/main.tsx` mount the existing geometry provider for reader disclosures; the popup needs only inline disclosure. the geometry provider needs no account/feedback context. this makes the existing floating surface usable without introducing another geometry path.

## two restart-safe admissions

new narrow owner: `lib/media/admissionRecovery.ts`, with a small authenticated host in the same feature. reuse generated wire types and existing transports/observers. imports remains the authority for admitted jobs and history.

```ts
type AdmissionIntent =
  | { kind: "SourceRefresh"; mediaId: string;
      request: Schema<"RefreshSourceRequest"> }
  | { kind: "MetadataResearch"; mediaId: string;
      request: Schema<"MetadataEnrichmentRequest"> };
interface StoredAdmission {
  version: 1;
  dispatchId: string; // fresh uuid persisted before every post
  intent: AdmissionIntent;
}
type AdmissionResult =
  | { kind: "Accepted" }
  | { kind: "Pending"; key: string }
  | { kind: "LocalFailure"; content: FeedbackContent }
  | { kind: "OwnerGone" };
```

one local-storage record per exact `(accountId, kind, mediaId, expectation)`, namespace `nx_media_admission.v1`, encoded unambiguously. source expectation is `expected_attempt_id`; metadata `expected_job_id: null` is a real first-request expectation. store no endpoint, callback, arbitrary payload, access token, job lifecycle or notification history. validate this owned shape once at storage ingress; malformed records are reported and retained for repair, never silently deleted/migrated. ordinary same-profile browser restart is covered; cleared storage, private-session expiry, device loss and cross-device recovery are not ([storage semantics](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage)).

public owner operations: `admit(intent): Promise<AdmissionResult>` freezes/persists/sends; `confirm(key): Promise<void>` resends the stored intent; `retryCleanup(key): Promise<void>` removes a settled local record without sending. `LocalFailure` carries a proven fresh refusal or pre-send storage/lock failure to its originating surface; `OwnerGone` suppresses departed-caller effects, not server work. confirm/cleanup outcomes render from owner snapshots. defects reject to existing defect handling. expose subscription/snapshot and read-only `(kind, mediaId)` eligibility lookup; no public mutation setters. runtime variants are `Sending`, `Unconfirmed`, `Blocked` and `Cleanup`; no entry means no pending recovery. `Blocked` includes typed reason/content; `Cleanup` retains the proven `Accepted | Refused` settlement and its dispatch id. no settlement is persisted, so every restored record starts `Unconfirmed`.

| event | required transition |
| --- | --- |
| new action | capture the viewed expectation; acquire operation lock; re-read pending records; persist before the first post; then `Sending` |
| matching action already sending in this tab | join its promise; no second send |
| earlier unresolved intent for this operation/resource | expose its confirmation; do not replace it with a fresh expectation |
| response lost, timeout or interrupted process | retain exact record; `Unconfirmed`; wake existing observation |
| reload/restart/login | restore current account's records; no automatic post or spending |
| explicit confirmation | re-read original record under lock and resend it; explain that this can start the request if the first never arrived |
| accepted receipt | apply existing observation/stamp effects; remove only exact record; withdraw condition; job progress stays in imports |
| definite first-attempt refusal | clear only an owner-proven non-admission from a newly created record under lock; show existing typed refusal locally |
| refusal after any earlier uncertainty | keep record; show confirmation or blocked explanation; generic `4xx`, access loss and newer displayed state do not settle it |
| local deletion fails after proven acceptance/refusal | `Cleanup` for that dispatch; retry storage cleanup only, no automatic resend; retain what is already known |
| account leaves/changes | cancel unsent work, detach old ui/subscriptions; retain old account records; no new-account execution or publication |

use one native exclusive Web Lock per `(accountId, kind, mediaId)` across re-read, persist, post and settle. same-tab promise joining is only an optimization. acquire no nested lock; never steal; after waiting, recheck account and record. if confirmation finds its record already removed, observe current state without another post. storage events refresh presentation; they are not command permission. a terminated tab releases the lock; its retained record forces subsequent refusal handling to remain conservative. local storage is not compare-and-swap ([lock semantics](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)).

before EVERY post, persist a fresh `dispatchId` with the unchanged intent. if that write fails, send nothing and retain the prior record. settlement/cleanup captures that id and compares it under the same lock before deletion. a different id means another dispatch occurred: discard stale settlement evidence, re-read and project the surviving intent; never delete or send from the old cleanup. this also fences reuse of the same storage key after an earlier record was removed. no additional generation/lease mechanism.

storage/lock unavailability blocks only these admissions with an actionable local explanation; no in-memory fallback. cancel queued lock requests on account change; recheck the account immediately before dispatch. later responses may settle only their captured account/intent. old-account callbacks cannot publish, invalidate imports, navigate or invoke the global unauthenticated redirect in the next account.

bound each of these two attempted sends to 30 seconds through response-body consumption, using the existing `apiFetch` signal input. start the timeout at dispatch; abort/release transport on account teardown; clear the timer on settlement. timeout/abort after dispatch retains uncertainty and releases the lock, without claiming server cancellation. this is a local admission requirement, not the separate [ordinary-read deadline project](tickets/browser-read-deadline-does-not-cover-response-body.md). keep the original record until accepted or an endpoint-specific authoritative settlement proves no pending admission; no “forget” command, expiry or automatic resend.

first-refusal deletion is an explicit status/code gate: source accepts `(404, E_MEDIA_NOT_FOUND)`, `(403, E_OWNER_REQUIRED)`, `(409, E_RESOURCE_CONFLICT | E_RETRY_NOT_ALLOWED | E_REPAIR_NOT_ALLOWED)`; metadata accepts `(404, E_MEDIA_NOT_FOUND)`, `(403, E_FORBIDDEN)`, `(409, E_RESOURCE_CONFLICT | E_RETRY_NOT_ALLOWED)`. only a record created by this locked attempt with no earlier possible dispatch qualifies. the same replies for an existing/restored record retain uncertainty. auth, stale-build and defect handling never silently delete it; blocked recovery has no generic retry until its owner can offer a meaningful check.

source intents MUST originate from the existing refresh capability for an observed SETTLED source attempt (`python/nexus/services/source_attempts.py:227-235`). preserve its deterministic successor replay (`python/nexus/services/media_source_ingest.py:679-716`). the endpoint also joins active expected attempts; that branch alone is not a durable replay guarantee and is not an admissible starting intent here. metadata returns the latest same-purpose job newer than the stored expectation, which may not be the job caused by the first click (`python/nexus/services/metadata_operations.py:338-411`). neither replay substitutes the latest observed expectation. say “request confirmed,” not “original job recovered.” no backend/schema change is required for these restricted contracts.

move admission orchestration out of `lib/imports/api.ts` and `mediaMetadataOperations.ts`; remove their hud closures rather than wrapping them. preserve metadata's acceptance stamp and `follow` behavior through a narrow existing-owner function. both admissions wake imports after every attempted send, including unknown outcomes. mount recovery under the authenticated account above its consumers; it must not depend on `ImportsContext` or a departed pane's closure. resource actions read pending intent before offering a new admission; metadata navigation uses the existing resource activation contract.

## feature content and correctness

each implementation package has a named content designer and an independent domain reviewer. before coding its adapters, the designer supplies the short summary, optional explanation, exact action label and the state predicate that makes each sentence true. use the existing `FeedbackContent` schema; keep copy near its feature owner. no global dictionary or new editorial subsystem.

good content states the consequence in familiar words; the detail adds a cause, retained-work fact or next step. workspace copy names the affected task/resource when needed to distinguish items, using existing summaries rather than displaying raw ids as ordinary prose. no raw server prose as the default, reassurance without evidence, fake percentage, anthropomorphic “thinking,” or diagnosis stronger than the observed state. acceptance/processing/completion and unconfirmed/refused are never synonyms.

| family / designer brief | required content and behavior |
| --- | --- |
| workspace/session | “workspace changes not confirmed” + actual retry; say “still in this tab” only if true. stale build offers reload without promising unsaved work survives. pane cap explains the needed close, not a retry. |
| reads/panes/collections | “couldn't load …” + supported retry; refresh preserves content and focused retry; continuation error stays at list end. empty results offer clear filters only when relevant. internal defect says the pane stopped unexpectedly, logs the original and offers diagnostics—not generic remount retry. no false claim about other panes. |
| reader capability | reading-ready is independent of indexed search/ai-ready. show neutral preparation beside affected search/ai controls; local document find still works. open existing processing observation once on media entry and let the server terminal frame end it; remove the client assumption that `ready_for_reading` means all processing is settled. |
| reader position | “place held · location” + `return`; `read from here` in details. this is an excursion/navigation state, not a save acknowledgement. collapse/close never adopts the detour. render position-load failure visibly; add typed `RetryPosition` versus `ReloadDocument` recovery to the owner's `LoadFailed` state. use `revalidate()` versus `retryLoad()` accordingly; no error-string test. saves remain fenced until authoritative recovery. newer position requires explicit review/choice. |
| imports/admissions | use observed stage and capability; `request unconfirmed` + `confirm request`, with “may have started; confirming can start it if it did not.” action comes from recovery capability, including choose-original-file when required. preserve imports/history; attention and in-progress counts are exclusive row counts, never `unfinished_work_count` job counts. keep existing polling/wake cadence. |
| notes/chat | saving is quiet; unsaved/conflict remains beside the editor. “text remains in this tab” is not “saved locally.” do not attach retry to a no-op `flushText`. chat retry preserves frozen send; reconnect observes the old run. stop requested is not stopped. errors, writes, undo and stop remain visible outside collapsed run detail. their existing plans own command changes. |
| forms/auth/sharing | adjacent field reason; auth preserves nonenumeration. read retry and uncertain sharing change are distinct; “refresh access” is a read, not proof that an old write cannot land. dialogs keep their own feedback within the dialog. |
| actions/undo/copy | exact finish undo becomes an untimed offer, with original receipt and revision fence; later authoritative changes invalidate it. do not equate mark-unread with undo. routine copy acknowledges in its stable control. aggregate only a known batch; no text-based deduplication. |
| playback/offline/extension | buffering stays at player; playback failure and listening-sync failure differ. download reports real units; “saved on device” requires durable storage. extension distinguishes reading/uploading/saving/accepted and retries only when its owner permits it. public/shelf/popup share renderers and their existing token entrypoints. |

fix initial-load retry disappearance in the shared read/presentation owner (`lib/api/serverState.tsx` and its callers), not with per-page timers. preserve the failed state/action while retry is pending; successful removal follows the focus contract. expected data-read recovery stays with its read owner; `PaneRouteErrorBoundary` contains/logs defects and handles typed stale-build reload separately. its fallback must render without the failed pane registry/provider.

`paneRenderRegistry.load` wraps import rejection in `PaneModuleLoadError` preserving the original cause and identifying only the failed stage. import rejection cannot distinguish delivery from module evaluation; do not guess from bundled error names. this state says “this pane couldn't open” with explicit `reload app`; log the cause, retain existing caches and remove obsolete retry comments. ordinary render/invariant defects get no generic remount retry. test real chunk delivery loss followed by restored delivery and document reload.

## disjoint work packages

paths below are relative to `apps/web/src/`. these reserve ownership, not permission for unrelated rewrites. each package records its exact touched files before parallel work. one writer per file; integrations are requested from that writer.

| package | exclusive files / responsibility |
| --- | --- |
| a: visual primitives + content designer | `components/feedback/**`; feedback-only token edits in `app/globals.css`. anatomy, workspace slot, clocks, actions, disclosure, announcement/focus. |
| b: workspace/reads + content designer | `app/layout.tsx`, `app/error.tsx`, authenticated shell/entry/error boundary and layout styles; `components/EntryFailure.*`; workspace pane shell/boundaries/loading/filter status/refresh and host styles; `lib/panes/{paneChrome,paneRuntime,paneRenderRegistry}.tsx`, `lib/mobileShell/{viewport,chrome}.tsx`, `lib/workspace/{store,useWorkspaceSession}.*`; `lib/api/{serverState.tsx,pagePrefix.ts,useServerList.ts}`; `components/collections/{CollectionView,CollectionExhaustionNotice,MediaSummaryNotice}.*`; `components/ui/{PaneSurface,LoadMoreFooter,FloatingActionSurface}.*`, `lib/ui/overlay.ts`. b owns existing-overlay focus/modal observation additions and mounts c's owner. |
| c: imports/admissions + content designer | `lib/imports/**`, new `lib/media/admissionRecovery.ts` and its host; `lib/media/{mediaMetadataOperations,mediaMetadataCopy}.ts`; `components/imports/**`, `components/media/MetadataResearchActions.tsx`, authenticated `imports/**`. owns both durable intents and imports content. |
| d: reader/capability + content designer | `lib/documentReader/**`, `lib/reader/ReaderContext.tsx`, `lib/media/{mediaErrorMessage,useMediaProcessingStatus}.ts`, authenticated `media/[id]/**`, `components/media/MediaInfoOverlay.*`. excludes c's files. |
| e: remaining feature designers/adapters | every remaining feedback consumer/producer, excluding a–d: auth/public routes; artifacts/atlas/authors/browse/conversations/lectern/libraries/notes/oracle/pages/podcasts/search/settings/stats; feature components including suggestions, chat, find, sharing/player; `lib/actions/**`, consumption/lectern/libraries/nexus/notes/resource-graph adapters; `shelf/**`, extension popup/styles. assign a designer for each family; do not give one undifferentiated rewrite to a worker. |
| integrator + independent verifier | this plan, verification receipt, module docs, tickets/register; temporary proof harness. owns cutover inventory and acceptance, not concurrent edits to feature code. |

e alone writes `ResourceActionsProvider`, action catalog/projection, finish undo and the standalone geometry mounts in `app/s/page.tsx`/`shelf/main.tsx`. d alone writes `MediaPaneBody`; b alone writes authenticated host mounts and viewport clearance; a alone writes shared api/tokens. c/d supply contracts to those owners. existing chat, library chooser/creation, inspector, find and pane plans retain semantic ownership; sequence shared-file adoption after them or have their owner incorporate the adapter. do not redesign their journals/navigation as part of feedback.

dependency order: freeze a's interface and content predicates → b/c owner integration → c/d reference journeys → e's adoption → integration/hard-cut review. b/c/d may run in parallel after interfaces settle. every package gets adversarial review of ownership before code, behavior after green and unnecessary machinery after refactor; findings must be fixed or recorded as a blocking ticket, never silently waived.

## red → green → refactor → green → delete

the owner explicitly requests temporary live integration/e2e tests for this cutover. this is a finite exception to the repository's static-only default, not a permanent test system. leave `./scripts/test` unchanged as the sole permanent automated gate; follow [local verification rules](local-rules/testing-standards.md) otherwise. the specification phase made no application changes; the implementation follows the finite campaign below.

1. inventory shared callers and bespoke status/loading/error/css paths, including reader, imports, player, shelf and popup. assign each to a package and target surface. grep only finds candidates; the designer reviews rendered states. freeze the oracle before implementation.
2. put the temporary runner/dependencies, browser profile and fault controls outside the repository, e.g. `/tmp/nexus-feedback-<nonce>/`. use real isolated auth/web/bff/api/db/storage/workers and providers needed by the scenario. seed through product interfaces; fault the real transport (drop an accepted response, delay a read, disconnect), not react state or fabricated success bodies. own and clean only that run's processes/data.
3. prove relevant assertions fail on baseline for the intended behavior. missing selectors, unavailable services or harness failures are not red. record currently passing invariants too. do not reconstruct a general fixture platform; provider/device blockers get precise tickets and remain unverified.
4. implement by packages; run the same oracle to green and `./scripts/test`. adversarially review exact identities, false copy, disappearing actions, focus, timing and scope before accepting green.
5. refactor at the responsible owner, remove duplication/dead paths, rerun affected oracle and static gate. reject a visually correct result backed by wrong operation semantics.
6. delete temporary tests, harness, fixtures, dependencies and fault controls after verified green; run the unchanged static gate once after cleanup. retain only a concise `docs/feedback-verification.md` with baseline/candidate identity, actual observations, sanitized captures/evidence, cleanup and explicit limits. no test-only product seam, new ci gate or dependency survives. distinguish real browser/storage-policy faults from any temporary component integration checks; the latter are not live end-to-end proof.

| oracle group | acceptance |
| --- | --- |
| compact/reference | normal reading has no warning card; return/retry is direct; read-from-here needs one disclosure; expansion preserves text position and trigger. initial read, refresh and continuation failures render distinctly. |
| capability | reopen readable media while indexing is active; local find works; search/ai status follows real completion without reload or another import. |
| saved position | fail initial cursor load and source binding separately; visible retry/reload is correct; no save crosses the fence. text/pdf excursion, return, adoption and newer-place choice preserve intended position. |
| admission persistence | for EACH admission, drop a committed response; exceed old hud lifetime and publish a burst; close origin, reload, then restart the same browser profile. confirm sends the original body, does not create fresh successor work, and wakes imports. startup sends nothing. metadata proof uses its actual latest-same-purpose contract. |
| admission races | two tabs, repeated activation, account switch, prior-unknown then refusal, stalled response body, storage write/delete failure and unavailable lock. no lost intent, cross-account effects, new-expectation resend or false settlement. cleanup after a newer dispatch cannot delete its record; cleanup failure sends no automatic post. |
| workspace lifecycle | several conditions/offers; highest priority + accurate remaining count; interaction freezes order; old cleanup cannot clear replacement; no timed recovery/action or duplicate announcement. pane close preserves continuing work; account departure removes old offers too. modal suppression and disclosure tab/escape behavior work. |
| retry/undo | keyboard-focused retry stays mounted through pending and gets an intentional post-success focus destination; exact finish inverse survives delay/burst, origin closure and retryable failure, and respects supersession. busy undo cannot be dismissed; an unconfirmed inverse remains a condition. |
| breadth/containment | imports counts/history and observed recovery stay correct; dialogs/public/auth/shelf/popup use primitives; pane defect stays contained; native playback/download feedback remains native. verify every inventoried producer's classification. |
| visual/usability | all rooms/themes, 320px and zoom; readable, compact controls and usable disclosure; mobile player clearance; representative firefox/webkit checks. no clipped action or hidden required text. accessibility-specific verification was explicitly waived by the owner on 2026-10-16. |

hard-cut acceptance: no `Hud`/`Persistent` feedback variants, `publish`/`resolve` compatibility wrappers, timed actions, old tone columns, standalone reader warning cards or duplicate feedback css. retain legitimate domain layouts/skeletons; share their message/action primitives. update `docs/modules/{visual-system,overlays,imports}.md` and touched domain docs to describe the landed result. delete issue tickets only when their acceptance is proven, then remove their register entries. grep/source review proves removal; live evidence proves behavior. static green alone proves neither.

## explicit costs and limits

- secondary choices and nonleading workspace issues cost one extra activation. unrelated workspace notices wait while a modal owns interaction. this buys a quiet default without hiding a primary remedy in its own task.
- optional actionless advisories remain until dismissed; this preserves a known failure without fabricating a remedy. optional undo can remain until used/dismissed/invalidated. it survives pane closure, but does not gain restart persistence. only the two approved admissions do.
- receipts have no history and may be suppressed by consequential work. resulting product state carries the evidence.
- restart recovery adds a narrow account-scoped browser record, native operation lock and 30-second send timeout. a slow request can become unconfirmed even if the server later accepts it. unsupported storage/locks block those two commands; no dependency or general outbox is added. irreconcilable access loss retains a blocked record for live repair.
- import observation keeps its existing latency/cadence. reader entry adds the existing stream's short authoritative check even when reading is already available.
- an ambiguous module-load failure offers full app reload, which can discard tab-only edits. no claim that a rejected dynamic import proves a retryable network fault.
- nexus recent-selection retry keeps its existing at-least-once semantics: a lost response and retry can count the selection twice. this cutover does not add history idempotency or another durable journal.
- deleting the temporary tests deliberately gives up future automated regression detection. static checks, retained evidence and normal-use/live repair remain; do not describe that as equivalent protection.

resolved starting defects: compact feedback, expiring admission recovery, missing source-refresh wake, missed index observation, invisible saved-position failure, exact undo expiry, disappearing retry, generic pane-defect retry, false pane reassurance and unsupported link retry. their evidence and the remaining runtime limits are recorded in [verification](feedback-verification.md); resolved issue tickets were removed.
