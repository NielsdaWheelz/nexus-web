# quick reads: lectern action specification

status: implemented and verified · decisions: 2026-10-14
source: `b6768bee2`; scoped spec/tickets imported into an isolated worktree.
review: architecture, interaction/content, adversarial verification.

## goal, scope and decisions

quick reads answers “what can i finish soon?”; membership is independent.

- retain current eligibility/ranking: at most five unfinished documents with
  `0 < remaining_seconds < 600`, including existing lectern members.
- direct add retains the row; opening never enqueues. migrate all user-facing
  adds to ensure-membership, with truthful recovery, exact capacity and reactivation.
- defer suggestions’ [focus](tickets/suggestion-add-can-reclaim-moved-focus.md)
  and [refill](tickets/suggestion-add-refetch-replaces-stable-survivors.md) defects.
  adapt acceptance, recovery and capacity admission; retain current focus/refill
  behavior.
- keep unrelated edits available after an uncertain attempt. preserve existing
  server transaction order across tabs/devices; introduce no revision protocol.
- temporary integration/live tests use a disposable non-production account;
  retain proof, then delete tests. `./scripts/test` remains unchanged and static.

non-goals: ranking/deduplication, new cards, inline removal, bulk/offline writes,
cancellation/outbox, global action/feedback redesign, playback changes, new
infrastructure or seo.

tradeoffs: overlap is intentional; full button text may wrap and narrow actions
take their own line, spending vertical space. additions use the
absolute tail, including hidden rows, matching assistant/podcast additions and
replacing visible-last placement. membership display waits for fresh action facts
after receipt. a delayed first request can commit after another device’s removal;
replay of a committed request cannot. dismissal hides recovery but preserves its
identity; revisiting an add surface offers the same check. reload loses recovery
without cancelling server work. deleted tests sacrifice future regression detection;
local proof does not establish production, handset or screen-reader behavior.

## invariants and composition

1. append absent media once; preserve existing item id, `added_at` and position,
   even with a fresh mutation id. existing membership succeeds at capacity.
2. the server owns authorization, teardown, complete membership, capacity and order.
3. acknowledgement concerns an operation; membership concerns state. neither
   proves the other. retries preserve exact command id/body.
4. the lectern provider owns canonical snapshots/pending commands; sections own
   presentation/query lifetime; resource actions own admission and descriptors.

```text
quick reads / menu / suggestions / transcript → lectern provider → existing bff
→ POST /lectern/commands → replay + viewer transaction → ensure_missing_in_txn
← original receipt + fresh snapshot → Consumption + action reconciliation
```

use `CollectionView.rowControls`. uncertainty is client feedback, not a backend
business outcome. no second endpoint, queue owner or action controller.

## wire and capability contract

extend the existing strict camel-case command and result unions:

```ts
// POST /lectern/commands; browser path is /api/lectern/commands.
type EnsureItemCommand = {
  kind: "EnsureItem"; mediaId: string; clientMutationId: string;
};
type EnsuredOutcome = { kind: "Ensured" };
// existing Data<LecternResult> envelope; existing outcome variants remain.
type LecternSnapshot = { items: LecternItem[]; atCapacity: boolean };
```

both ids are validated uuids; no placement/batch form. inside replay `apply`,
AFTER lookup, authorize and call `ensure_missing_in_txn(..., media_ids=[media_id])`.
later deletion/access loss must not erase an existing receipt. memoize only
`Ensured`; it claims neither insertion nor current membership. `answer` returns
the fresh snapshot. retain existing errors and transport-only bff.

derive required `atCapacity` from ALL loaded rows before visibility filtering;
replace both frontend capacity guesses. server admission remains authoritative.
generate `wire.gen.ts`; no handwritten decoder, compatibility default or migration.

add required `title: string` to `LecternMembershipAbsentOut` from the loaded
summary; other callers already have titles. cost: one descriptive wire field
to distinguish simultaneous recovery notices without another lookup.

provider capability:

```ts
ensureItem(input: { mediaId: MediaId; title: string }):
  Promise<"Acknowledged" | "Unconfirmed">;
type EnsureRequest =
  | { kind: "Sending" | "Checking" }
  | { kind: "Unconfirmed"; check(): void };
readonly ensureRequests: ReadonlyMap<MediaId, EnsureRequest>;
```

`title` is recovery copy, never replay identity. no map entry means no pending
ensure. retain one immutable command per media; use the existing secure
`createRandomId`. the command map already owns identity; an extra intent wrapper
would duplicate that ownership without hiding complexity.
concurrent activation shares its promise; uncertain retries reuse body/id.

each serial attempt gets `AbortSignal.timeout(30_000)` when execution begins,
covering response body acquisition. this matches the bff budget, not server
cancellation. omit ensure's unbounded failure GET; release its chain slot.
no automatic retry schedule.

body acquisition failures remain transport errors regardless of response status.
repair that classification in the shared browser fetch client; classify fully
acquired malformed responses as defects before considering a concurrent deadline.

| result | provider behavior |
|---|---|
| valid `Ensured` response | record acknowledgement before fallible local work; install snapshot, invalidate action facts, clear exact intent, resolve notice, publish `Consumption`; return `Acknowledged` |
| initial `E_NOT_FOUND`, `E_MEDIA_DELETING`, `E_LIMIT` | clear intent; reject through existing error handling; next deliberate add gets a new id |
| network loss, browser deadline, `E_NETWORK`, `E_UPSTREAM`, `E_UPSTREAM_TIMEOUT` | retain intent as `Unconfirmed`; publish recovery; return `Unconfirmed` |
| any failed retry after ambiguity | keep that original intent, even for a later 4xx; failed retries cannot prove the delayed original never committed |
| other error | retain sent identity; use existing auth/error handling. malformed response, unexpected outcome, invalid command and replay mismatch are defects, not ordinary refusals |

retire acknowledged identity even if local installation/observers fail; report
the defect, never POST again. reads cannot acknowledge an unresolved command.
inline/rail checks use the captured callback, including at capacity/present
membership. provider handles its promise/errors; stale callbacks no-op.

emit `{kind: "ensureAcknowledged", mediaId: MediaId}` through existing canonical
listeners before clearing request state, including no-op/replay. runtime starts
targeted reconciliation and reports defects; listener returns void so reads stay
outside the command chain. queued reconciliation immediately invalidates the old
generation/marks refreshing; only its subsequent read restores freshness.
expose cache `Reconciling` as model `Refreshing`, not `Ready`.

authenticated-owner teardown clears notices/requests and invalidates callbacks;
late completion cannot publish into another account. pane navigation preserves them.

`SuggestionAccept` becomes `Promise<"Accepted" | "Retained">`. lectern accepts
only after receipt plus current visible membership; library accepts after its
existing mutation. retained clears adding without local removal/refill; ordinary
queries may later remove ineligible rows. deferred defects remain deferred.

## interaction and authored content

the designer signs off every changed state. good copy states known facts and
the next action; preserve external titles. never invent success, offline causes,
automatic retries or technical transport prose.

| condition | visible content / action | rule |
|---|---|---|
| absent, admissible | `add to lectern` | accessible name `add {title} to lectern` |
| sending | same control; `adding…` | keep node/width/focus; guard duplicate activation |
| present, no unresolved request | `on lectern` | quiet static status; remove remains in overflow |
| unconfirmed | `couldn’t confirm adding {title}`; `it may already be on lectern.`; `check add` | keyed persistent recovery and inline check; exact frozen command |
| checking | same `check add` control; `checking the add…` status | preserve identity/focus; guard activation |
| acknowledged | `add confirmed.` | one polite announcement; current membership comes from fresh action facts |
| definitive refusal | `couldn’t add to lectern` + existing actionable reason | no false unconfirmed state; allow a new intent when admissible |
| absent, full | `lectern is full`; `remove an item to add another.` | one section notice; disable fresh add only |
| action facts loading/refreshing | `checking lectern…` | neutral; no fresh add or per-row announcement |
| action facts failed | `couldn’t check lectern`; `retry` | refresh facts only; never infer absence from error |
| first quick-read load failure | `couldn’t load quick reads`; `retry` | existing section failure surface |
| retained-data refresh failure | `couldn’t refresh quick reads`; `showing the last loaded items.`; `retry` | keep rows and scroll position |

dedicated add controls prioritize pending requests. otherwise require `Ready`
action facts: present shows status; absent binds the inspected add descriptor.
ready without a membership capability renders no inline control.
filtered queue absence proves nothing; a resolved reconciliation may mean error.
no local `added` flag. menu remove/other edits remain available during uncertainty.
an absent-menu action with pending ensure becomes `check add`, bypassing fresh-add
capacity admission. never relabel a remove handler as add/check.

reuse `LecternAddControl` in quick reads/transcript; retain row links/metadata/menu.
scope normal whitespace and auto height with existing minimum height: full labels
wrap without clipping. pending keeps its node, guarded `aria-busy`/`aria-disabled`.
the shared control owns focused-node removal: leaf action updates do not rerender
`CollectionView`, so its existing recovery cannot observe this transition.
quick reads returns to its row title; transcript uses play, then media landmark.
use a stable ref cleanup; recover only when removing the CURRENT focused control,
never on ordinary rerender or from focus captured before awaiting.

recovery survives row/pane removal until acknowledgement/dismissal. add only
`FeedbackAction.busy?: boolean` and persistent
`returnFocus?: () => HTMLElement | null`. keep `check add` keyed consistently.
on notice removal, feedback checks its root against current focus, then resolves
the callback and focuses a connected, non-inert target. provider callback uses
the current active pane: matching row title, else chrome, else landmark. reuse
workspace/pane helpers.

quick-read query key is non-null only while `isActive`; retain the last success.
existing null→key activation restarts `useResource`. retain active
Consumption/Entries/media invalidation; only eligibility changes remove rows.

## exclusive work ownership and files

paths below are relative to `apps/web/src/` unless prefixed `python/` or `docs/`.
one owner edits each row’s files; agree contracts before parallel implementation.

| owner | files | deliverable |
|---|---|---|
| a: backend/wire | `python/nexus/schemas/{consumption,resource_action_snapshots}.py`; `python/nexus/services/consumption/{service,lectern,projection}.py`; `python/nexus/services/resource_items/action_snapshots.py`; generated `lib/api/wire.gen.ts` | singular ensure, complete capacity, descriptive title, existing replay; remove unused last placement; generate wire |
| b: client command | `lib/lectern/{contract.ts,LecternProvider.tsx,useCompletionUndo.ts}`; `lib/api/client.ts` | request/receipt state, deadline, recovery signals, immutable retry; classify body acquisition at the shared fetch boundary; preserve capacity during optimistic reorder; narrow undo’s `before` to `Pick<LecternSnapshot,"items">` |
| c: interaction/content | `components/collections/{LecternAddControl.tsx,QuickReadsSection.tsx,SuggestionsSection.tsx}`; scoped control css; `lib/actions/{resourceActionMenu.tsx,resourceActionRuntime.tsx,resourceActionSnapshotCache.ts,resourceActionEnvironment.ts,resourceActions.ts}`; `components/feedback/Feedback.tsx`; `lib/workspace/paneDom.ts` if helper extraction is needed; lectern/library `*PaneBody.tsx`; `app/(authenticated)/media/[id]/Transcript.tsx` | shared control/admission, freshness, exact copy/focus, accept adapter, all add migrations, active query lifetime; no deferred slate redesign |
| d: independent verifier | owned temporary directory outside checkout | real end-to-end assertions/faults; challenge each preceding contract; no application edits |
| integrator | this plan; `docs/{architecture.md,modules/player.md,modules/connections.md,outstanding-issues.md}` and scoped tickets | reconcile reviews, cutover, proof record and cleanup |

## hard cutover and implementation sequence

1. **spec gate:** independent contract/content/verifier review; resolve identity,
   replay, failure, focus and scope objections here before code.
2. **red:** verifier establishes isolated fixtures and independent failing cases
   below against the recorded baseline. setup failure is never a product red.
3. **green:** a publishes wire while c publishes feedback contract changes;
   b implements the command owner, then c integrates consumers.
   designer reviews every state; another reviewer challenges every diff.
   rerun the same acceptance cases.
4. **refactor:** remove duplicate add logic and dead branches; reviewer checks
   ownership, explicit states, focused-node transitions and unknown responses.
   rerun affected cases and `./scripts/test` until the final code passes.
5. **cut/clean:** all add callers use ensure. `PlaceItems` remains for play-next
   (`First`/`After`); delete unused `LastPlacement`, the ts `Last` arm and its
   writer branch. delete the client capacity constant once unreferenced. no
   aliases, dual routes, old-add fallback, flags or legacy compatibility.
   later release deploys web/api together and reloads old tabs. remove resolved
   tickets only after proof; deferred suggestions tickets remain. no deployment now.

## temporary red/green/refactor proof

the owner explicitly authorizes this temporary live campaign as an exception to
the [static-only policy](local-rules/testing-standards.md). never modify
`./scripts/test`, permanent dependencies, ci or product code for test access.

use one external pinned playwright runner and fixture helper in
`/tmp/nexus-lectern-<nonce>/`. allocate task-owned account, browser profile, local
auth/services, ports and data. assert the allowlisted non-production destinations;
do not inherit ambient `.env`/`.dev-ports` through `make`. run real web→bff→api→db.
create short/long, queued/unqueued and finished articles through ordinary capture
and publication; run the normal background worker until ready. no provider model
credentials are needed for the lectern assertions; unrelated enrichment is not
qualified. capacity/hidden/teardown preconditions may use labelled isolated-db
fixtures; never lower production limits or mock the mutation owner.

| case | required observation |
|---|---|
| direct action | absent/present controls; title-open sends no mutation; successful add preserves quick-read row/order and one membership |
| no-move | add x, add y, repeat x with same and fresh ids; ids, added times and existing order unchanged; play-next still intentionally moves |
| admission | full including hidden rows rejects new membership; existing membership ensure succeeds; permission, teardown and changed-body replay retain typed refusals |
| lost receipt | forward real POST once, observe commit, drop only delivery; show unconfirmed even if a GET observes membership; check resends identical body/id |
| transaction order | commit x, lose receipt, remove x elsewhere, check original; acknowledge while remaining absent; stale check sends nothing. separately hold the first request before delivery, remove x, release it: first commit may append x; replay after another removal cannot restore x |
| finite uncertainty | stall body/read paths; attempt releases after deadline, retains id and recovery; unrelated edits remain available subject to normal server validation; failed retries preserve id |
| cross-surface/lifetime | all four surfaces use ensure; pending recovery survives navigation/eligibility removal and dismissal preserves id; sign-out removes owned notices and late completions cannot leak across accounts |
| action freshness | hidden membership never becomes an absence claim; a pre-receipt resolve cannot restore fresh facts after the receipt; failed reconciliation offers fact retry, never unconfirmed-command retry |
| focus/layout/content | keyboard add→status in quick reads and transcript, moved focus, persistent retry/dismissal, 320px pane with enlarged text, full queue, loading/error; no accidental navigation |
| reactivation | keep observed pane mounted/inactive; change eligibility through an independent context/api with no observed-tab invalidation; reactivate, retain then reconcile; failed refresh keeps rows with retry |
| clean build | remove fault routes; ordinary add/open/remove passes on final app; unchanged `./scripts/test` passes |

red separately exposes missing affordance, stale-add movement and missing
reactivation; one absent selector must not hide later checks. movement red uses
the baseline's actual add path/request, not the unsupported new discriminator.
lost-response faults use external [route fetch/abort](https://playwright.dev/docs/api/class-route),
never fabricated success payloads or production seams. a tiny disposable streaming
relay forwards real headers then withholds remaining bytes for the body-deadline
case; buffered route interception cannot prove that case. record pre-header and
mid-body stalls separately. intercept both lectern GET and action-snapshot
resolve when testing unavailable reads. inspect canonical
rows through read-only sql; distinguish service readiness from assertions.

after final green/refactor, retain a short sanitized verification receipt beside
this plan: baseline/final commit and dirty-input identity, fixture ids, cases,
observed network/db results, screenshots, limits and cleanup. delete only
manifest-owned tests, dependencies, profiles and disposable resources; no receipt
may contain credentials. rerun `./scripts/test` after cleanup. test deletion is
not permission to omit proof or remove unresolved tickets.

## tracked work

direct action, safe add, exact capacity and reactivation are implemented at
`e1af653b2`; their tickets are resolved. Q7 keeps queued quick reads.
the [verification receipt](quick-reads-lectern-verification.md) records independent
red, final green/refactor, built-app proof, accepted limits and cleanup.
