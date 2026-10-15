# libraries creation

status: implemented; current-main qualification in progress; physical keyboard check deferred by owner. 2026-10-15.
baseline reviewed: `367da80e0c1beb1c426f6d2d72201b0733809b50`.
integration target: current main `7bc7c8a13`; current library owners below supersede the baseline paths.

## outcome and scope

replace the libraries index's permanent creation row with one quiet header command and a compact dialog. creation belongs to the pane; browsing keeps its space. acknowledged foreground success opens the new library in that pane. pane back restores the previous filter, sort and collection position.

include desktop/mobile header projection, dialog behavior, request recovery, libraries filter retention, and the touched pane's duplicate accessibility ids. this is a hard replacement: remove the inline form, its state/styles/imports and positional empty-state copy. reuse the existing server command, overlay, feedback, routing, list and visit-memory owners.

excluded: nexus launcher changes, destination picker, batch creation, fab, inline expansion, new shortcut, global creation lock, durable recovery storage, backend/schema changes, dependencies, generic mutation framework, unrelated count/sort cleanup. the launcher [completion](tickets/nexus-library-create-completion-outlives-page.md) and [retry identity](tickets/nexus-library-retry-whitespace-changes-identity.md) defects remain ticketed.

## settled decisions and costs

| decision | consequence |
|---|---|
| header command → dialog | one extra activation before naming; no permanent form row or custom popover machinery |
| create and open in the same pane | favors using the new library over creating several consecutively; requires truthful return continuity |
| close remains available while sending | closing relinquishes navigation ownership; it does not cancel the server write |
| resolve uncertainty before another name | the same task stays locked until acknowledged; a different name cannot silently create a second library |
| retain unresolved identity in visit memory | pane switching/back are recoverable; reload, sign-out and permanently discarded visits require list inspection/live repair before another creation |
| no global lock | separate panes and existing launcher/picker creation remain independent |
| icon-only at narrow widths | saves title space; the full accessible name remains available |
| disposable live tests | proves this implementation, then removes maintenance cost; later regressions have no retained automated journey coverage |

## interaction and content

header order: history, identity, `+ new`, more, existing inspector. desktop uses the existing 32px ghost button; at pane widths ≤479px it becomes a 32px square plus. mobile uses the existing 48px bar target. preserve header height, title semantics and existing controls. accessible name: `new library`; icon decorative. no duplicate create item in more. the opener stays available during loading, list failure, invalid view, pending creation and uncertainty; it opens or resumes the pane's task.

use `Dialog` and a native one-field form. add only an optional composed `className` to `Dialog` for this caller's 400px maximum width; retain its viewport padding, scrolling and overlay behavior. no new surface implementation.

| state | content | actions |
|---|---|---|
| draft | title `new library`; label `name`; empty input, no placeholder instructions | `cancel`, `create library` |
| invalid | `enter a library name.` / `use 100 characters or fewer.` / existing `RESERVED_NAME` | retain editable text; focus name; submit nothing |
| sending | `creating library…`; `you can close this dialog. creation will continue.` | read-only name; unavailable `creating…` submit; `close` |
| unconfirmed | `creation not confirmed`; `this library may already exist. retry before creating another library.` | read-only submitted name; `retry creation`, `close` |
| success without automatic navigation | `library created`; `“{name}” is ready.` | `open library`; also `close` when still in the dialog |
| empty collection | `no libraries yet.`; `use new library to create one.` | use the header command |

keep draft submission available; show the specified inline errors, not native validation bubbles, then revalidate while editing. trim once before freezing the command. validate 1–100 unicode code points using `Array.from(name).length`; do not use utf-16 `maxLength={100}`. reuse `isReservedName` and its message. server validation remains authoritative; names need not be unique.

closing a draft discards it without confirmation; closing `Sending` or `Unconfirmed` retains the attempt. while closed, uncertainty has one pane-owned `FeedbackNotice` with `review creation`; opening the dialog removes the duplicate notice. a definite initial refusal after close shows mapped pane feedback without reviving the dialog. non-navigating success keeps an already-open dialog open with its receipt, otherwise uses pane feedback. a fresh header invocation after settlement starts an empty draft. no toast plus inline duplicate.

focus name on draft open; focus the dialog panel on pending reopen, retry on uncertain reopen. validation associates generated ids through `aria-invalid`/`aria-describedby`. native enter submits outside composition; ime enter/escape must not submit/dismiss. keep tab containment, escape, scrim, mobile back and inertness in the existing overlay owner. close returns to the actual trigger, or its pane landmark if gone; successful navigation suppresses return focus and lets the destination own it. these choices follow the [modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).

preserve focused controls across pending/receipt transitions. use `aria-disabled` plus the delivery guard on pending submit; `Button loading` natively disables it. announce progress politely outside an `aria-busy` subtree. status changes never move focus.

each feature's assigned designer owns its copy and rendered states. good content states only what is known, identifies the next action, uses the library name when useful, and omits redundant instruction and implementation vocabulary. never call hiding an active write `cancel`, or an unknown outcome `not created`.

## state and ownership

`LibrariesPaneBody` owns the task outside dialog content. render dialog and creation feedback outside list-state and invalid-view branches. use an explicit local union:

```ts
type Attempt = Readonly<{ libraryId: string; name: string }>;
type DraftFeedback = FeedbackContent & { nameInvalid: boolean };
type Creation =
  | { kind: "Draft"; text: string; feedback: DraftFeedback | null }
  | { kind: "Sending"; attempt: Attempt; wasUnconfirmed: boolean }
  | { kind: "Unconfirmed"; attempt: Attempt; feedback: FeedbackContent }
  | { kind: "Created"; library: Library };
```

visibility, trigger element and permission to navigate are local presentation state. visit memory contains only `Attempt | null` under `Libraries.Creation`; no promise, timer, callback, error, dom node or visibility. a restored attempt always starts hidden and unconfirmed. no automatic resend.

1. valid draft submit creates one uuid and freezes the trimmed name. synchronously acquire the local delivery slot and record the attempt before calling the client. repeated submit cannot start a second delivery.
2. sending freezes edits. close revokes automatic opening for that attempt. reopening to inspect does not re-arm it; explicit retry may. pane deactivation, visit departure and unmount also revoke it.
3. retry sends exactly the retained id/name. keep a distinct `wasUnconfirmed` fact: a later refusal cannot prove an earlier ambiguous write failed.
4. acknowledged success clears retained uncertainty before navigation. navigate only if this mounted owner still owns the delivery, its originating visit is active, its dialog is open and automatic opening remains armed. otherwise show the receipt without reopening or focusing.
5. after unmount, callbacks may not change local state, visit memory, navigation or feedback. `createLibrary` still publishes acknowledged changes. the retained attempt is resolved by explicit same-id replay after return, even if the old delivery already committed.
6. each observer checks its exact in-flight object and mounted ownership before committing; only that observer releases its local delivery slot. cleanup revokes ownership, without clearing the retained attempt or pretending the write was canceled.

`usePaneVisitData` currently records only on react commits. state update followed by navigation can unmount before the cleared snapshot is recorded. add one explicit owner-level capability in `paneReturnMemento.tsx`:

```ts
usePaneVisitDataWriter<T>(key: PaneVisitDataKey<T>): (snapshot: T | null) => void
```

it synchronously writes to the existing memory; no second store. its stable function resolves the mounted visit's latest committed route key at invocation: sorting can change that key without unmounting. an old captured key would overwrite newer visit data. retain the existing read/capture hook for current callers.

the feature's single transition function updates its authoritative ref, writes the immutable attempt snapshot, then updates react state. its capture callback reads that same ref. record before post; clear before navigation. do not mutate snapshots by reference, use `flushSync`, or send from an effect. an unmounted observer never calls the writer.

retain filter text separately under `Libraries.Filter` with the existing capture hook. replace only libraries' `usePaneFilterRows` call with feature-owned restored state; reuse `truncatePaneSearchQuery`, `matchesPaneFilterQuery` and `listRowStatus`. sort remains in the existing url view owner; list snapshots and scroll remain in their current owners. a new visit starts empty; back returns to its own filter.

## command and failure contracts

the shell accepts exactly one optional primary command; absence means unsupported:

```ts
type PanePrimaryAction = Pick<
  Extract<ActionDescriptor, { readonly kind: "command" }>,
  "id" | "label" | "onSelect"
> & { readonly icon: ReactElement; readonly shortLabel: string };
// PaneChrome, SurfaceHeader and MobilePaneChrome:
readonly primaryAction?: PanePrimaryAction;
```

libraries publishes `Libraries.Create`, label `new library`, short label `new`, and `Plus`. the shell forwards `onSelect({ triggerEl })` with the actual button. `data-action-id` is not a document id. no arbitrary jsx action slot, priorities, overflow registry, permission fetch or library-specific shell branch. existing consumers without this field retain their controls.

composition: header → pane-owned task → `createLibrary({ id, name }, signal)` in `lib/libraries/api.ts` → `POST /api/libraries` → api `POST /libraries` → `python/nexus/services/libraries.py:create_library`. wire body is `{ id, name }`; consume the exported generated-wire `Library` type. the current service atomically creates the library and owner-admin membership. same-id replay for the same owner returns the current row, including a name changed since creation; a different owner conflicts. overlapping insertions converge on that row. keep the submitted id/name frozen; use the acknowledged row for receipt/navigation. never mint another id to escape conflict. this feature adds no endpoint, database or generated-type change.

inside `createLibrary`, require `response.data.id === input.id` before `publishChange("Libraries")` and return; mismatch throws to the existing defect boundary without clearing the attempt. the current typed-wire owner replaces the baseline shape decoder; do not restore it. the client owns acknowledgement identity and forwards the optional signal. other callers retain the same create contract.

each delivery uses a named 30,000ms `AbortSignal.timeout` through the existing signal parameter, covering fetch and body consumption. classify deadline-caused abort/transport rejection before ordinary copy mapping; a concurrent timeout must not disguise a malformed response or other defect. timeout stops observation, not the server transaction. use the [platform timeout](https://dom.spec.whatwg.org/#dom-abortsignal-timeout), with manual same-id replay; no automatic post retry or get-only `requestWithRetry` reuse.

| outcome | transition |
|---|---|
| initial `E_NAME_INVALID`, `E_INVALID_REQUEST` or `E_FORBIDDEN` | definite refusal: clear attempt, restore editable draft and existing mapped feedback |
| timeout, `E_NETWORK`, `E_UPSTREAM`, `E_UPSTREAM_TIMEOUT`, `E_RATE_LIMITED` | unconfirmed; retain exact attempt; manual retry only |
| recognized validation/permission refusal after uncertainty | retain attempt and uncertainty copy; do not unlock a different name or instruct editing a locked field |
| unauthenticated | existing auth handling; do not manufacture success or erase uncertainty before handoff |
| resource conflict, malformed success or unexpected defect | preserve attempt, use the existing defect boundary; live repair, no permissive fallback |

reuse `libraryErrorFeedback` for known copy; classification uses structured codes, never message text. keep expected transport uncertainty separate from defects. an unrelated list/invitation failure cannot consume creation state.

## implementation boundaries

paths below are relative to `apps/web/src/` unless prefixed `docs/`. owners may work in parallel only after freezing the contracts above; one writer per file. each handoff receives adversarial review by someone other than its implementer.

| owner | exclusive files | deliverable and designer |
|---|---|---|
| a: shared presentation and visit capability | `lib/panes/paneChrome.tsx`; `components/workspace/PaneShell.tsx`; `components/ui/SurfaceHeader.tsx` and css; `lib/mobileShell/chrome.tsx`; `components/appnav/MobilePaneBar.tsx`, `AppNav.module.css`; `components/ui/Dialog.tsx` and css if required; `lib/workspace/paneReturnMemento.tsx` | one command projection, composed dialog class, synchronous visit writer. header designer owns density, labels, narrow projection and focus affordances |
| b: libraries feature | `app/(authenticated)/libraries/LibrariesPaneBody.tsx`, `page.module.css`; `lib/libraries/api.ts`; `components/libraries/LibraryInvitations.tsx`; feature-local dialog file only if it hides substantial markup complexity | task, form, recovery, filter restoration, acknowledgement check and hard removal. interaction/content designer owns every state in the content table, errors, receipts and return journey |
| c: qualification and docs | disposable campaign outside checkout; this plan/receipt; `docs/modules/workspace.md`; relevant tickets/register | independently authored live oracles and adversarial checks. accessibility/content reviewer approves actual rendered states and rejects unsupported outcome claims |

remove `.createForm`, `.inputField`, `.createHint` and their obsolete responsive rules after checking usages. replace the extracted invitation component's repeated literal heading id with `useId`; the deleted reserved-name id gets generated replacements in the dialog. retain existing query/header generated ids. do not refactor invitations or other filter consumers.

update the workspace header contract that currently calls inspector the sole promoted action, plus the matching mobile comment. keep historical completed plans intact. the client already accepts `signal`, and shared response-body transport classification already exists; do not implement either again.

## verification and cutover

this task explicitly authorizes temporary live/integration tests; it does not change the permanent [verification contract](local-rules/testing-standards.md). no tests or application code are added during this specification step.

1. pin source and create isolated verification data with real auth, web, bff, api and database. keep runner/dependencies/proxy outside checkout. the designer and independent reviewer freeze the observable assertions first.
2. record behavioral reds: permanent creation row; lost filter on back; replacing an uncertain attempt with another name; lost attempt after mobile unmount. missing future selectors is not evidence. flows impossible in the old surface receive green proof, not invented baseline failures.
3. implement a/b against those assertions. run unchanged `./scripts/test`; run the live cases below. use real writes and public reads to prove identity/cardinality. an external network boundary may delay/drop/corrupt a real response, never fabricate a successful commit or add production failpoints.
4. independently challenge ownership, stale completion, error classification, content and deletions. refactor; repeat affected cases and the static gate after changes. no ritual expansion into unrelated journeys.
5. retain a terse receipt here: tested source, red/green observations, device/viewport, actual limits and cleanup. after final green, delete temporary tests, fixtures/data, proxies, processes, profiles, credentials and dependencies. keep no permanent suite, ci job or alternate test command.

| case | acceptance |
|---|---|
| entry and dismissal | no idle form; one direct header command, also during loading/error/invalid view; mouse/touch/keyboard opens the named dialog; name focus, tab loop, cancel/escape/back and return focus work; ime enter/escape preserves composition |
| validation and write | blank/reserved/overlong names rejected locally; unicode boundary matches server; correction retains text; rapid submits issue one delivery; actual read confirms the created id and foreground success opens it in the originating pane; mismatched acknowledgement defects without releasing the attempt |
| relinquished ownership | delay response; close/reopen and release success/failure: immutable name, no regained automatic navigation, no focus theft or resurrected dialog; explicit retry may re-arm navigation |
| lost acknowledgement | commit for real, drop response; unconfirmed copy, locked name and identical retry; failed retry preserves lock; eventual replay returns exactly the original library |
| stalled body | deliver headers, stall body; browser deadline reaches unconfirmed and permits same-id retry; close remains available throughout |
| remount and stale completion | switch mobile panes or leave/back while pending; old completion cannot affect the new owner; remount offers recovery, never a stranded spinner; overlapping same-id deliveries still yield one library; success followed immediately by back does not restore a stale unresolved attempt |
| return and isolation | filter, sort and collection position survive create/open/back; close → change sort → delayed completion preserves current visit data; a second index visit stays independent; every new/repaired aria reference resolves to exactly one intended feature-instance element, including portaled content |
| presentation | ordinary and 320px desktop panes, mobile portrait, 200% zoom, and a physical handset with keyboard: usable title/actions, no horizontal overflow, reachable field/error/submit/close |

mobile keyboard clearance is [unverified](tickets/libraries-dialog-physical-keyboard-unverified.md). after confirming device unavailability, the owner instructed `pr, merge, clean everything up` on 2026-10-15. merge and disposal proceed with this check explicitly deferred; it is not passed. if the new form is obstructed, repair the demonstrated geometry at the existing dialog/viewport owner using its existing keyboard mechanism, then check affected dialog consumers. no overlay rewrite or global style sweep. report an unavailable physical check as unverified, never passed; unrelated pre-existing tickets do not silently expand this feature.

completion requires all applicable acceptance evidence, resolved review findings, deletion of the replaced path and disposable tests, and accurate docs. only then remove the resolved [creation row](tickets/libraries-creation-reserves-a-permanent-row.md), [filter retention](tickets/libraries-filter-is-not-retained-for-pane-return.md), [duplicate ids](tickets/libraries-pane-repeats-accessibility-ids.md) and [acknowledgement identity](tickets/library-create-response-identity-is-unchecked.md) tickets/register entries. keep launcher defects and unrelated work open. new unresolved findings receive their own ticket immediately.

current evidence and remaining physical acceptance are recorded in the
[verification receipt](libraries-creation-verification.md). application source
is frozen at its twelve recorded hashes; no permanent tests were added.
