# librarian controls

status: approved for implementation; d1 selects the originating pane.
source reviewed: `5fb00d203ba16875eb10c42a71088005bd078fb2`; reconcile local
changes before implementation.

## outcome and scope

remove persistent brief editing from the conversation. expose it through the
existing pane overflow and land on the reading brief in librarian settings. preserve
the source visit and unfinished question.

- canonical destination: `Librarian`, projected from the destination registry.
- one overflow command: `Edit reading brief…`, `icon: null`.
- once the librarian body mounts, available in empty, populated, searched,
  data-loading and generating states; menu availability never waits for catalog,
  transcript or profile reads. no route-level chrome is added before code loads.
- remove the composer link, its row and any now-unreferenced import/style.
  do not replace it with a header button, badge or hint.
- retain one account-wide brief, one editor, explicit save and existing
  unsaved-work protection. save stays in settings; it never sends a question.

non-goals: a modal editor, new shortcuts, automatic brief
writing, autosave, model/recommendation changes, global copy cleanup, new
dependencies, backend changes, durable draft recovery or performance campaigns.

## decision and capability contract

**d1 — destination placement, accepted.** edit in the originating pane so
back returns to the exact librarian visit, even when another settings pane is
open. cost: two panes may display the same settings editor.

origin-pane behavior:

| input | result |
| --- | --- |
| normal click / enter | push `/settings/librarian` in the originating pane with `FocusReadingBrief`; preserve the previous visit |
| existing explicit new-pane gesture | fork through the workspace planner with the same destination and entry |
| save | existing versioned save; remain in settings |
| back | ordinary history restores the source visit, draft, reference, model, caret and transcript/search position |
| ordinary settings entry / back / forward / reload | no new brief-focus intent |

the fork leaves the source pane intact; its own back stack is not a return
shortcut. retained state follows existing pane/account lifetimes; full browser
restart recovery is not added. canceled navigation performs no save or send.

## composition and schemas

one client-only union arm in `lib/workspace/targetActivation.ts`:

```ts
| { readonly kind: "FocusReadingBrief" }
```

the href remains `/settings/librarian`. use existing delivery
`activationId/paneId/visitId`; carry no brief text, selector string or return url.
the intent is transient, never persisted into workspace storage or history.

1. `Librarian.tsx` publishes a pane-local command through
   `usePaneChrome.menuActions`. the shared command presenter retires the menu
   before `onSelect`; use `restoreFocusOnClose: false`. normal intent calls
   `runtime.router.push(href, { entry })`; `new_pane` calls
   `runtime.activateTarget({ target: { href }, disposition: { kind: "Fork" }, entry })`.
   reuse gesture classification; do not change the global planner or misuse
   `activateTargetLink.onDefault`.
2. scoped navigation publishes the existing `pendingPaneFocus` request together
   with this entry, including same-href entry delivery. `activateTarget` already
   publishes a focus request. `WorkspaceHost` yields without consuming it for
   chrome focus; existing input and overlay-generation cancellation still run
   throughout lazy module/profile loading.
3. `store.tsx` couples their lifetimes. `claimPaneFocus` retires the matching
   focus-only entry. departure, deactivation or replacement retires it too,
   including generic same-visit activation through either navigation path.
   matching pane/visit alone cannot revive a canceled intent. successful
   `claimPaneEntryDelivery` for this variant requires the current focus request
   and active destination, and atomically consumes both. other entry kinds retain
   their contracts. add no public method, token registry or local focus lease.
4. `ReadingBrief.tsx` owns the existing textarea ref. once enabled, claim the
   exact delivery; act only on success. use a stable pane-local anchor and
   `usePaneRevealAnchor(..., false)` for shell-owned placement, then synchronously
   focus the textarea with `preventScroll`. do not defer focus through the
   scroll restoration's later frames. existing scroll cancellation protects newer
   input; old settings mementos must not overwrite arrival. never select all or
   replace text. normal navigation does not manufacture the intent.
5. keep chat draft/model/reference/caret in `lib/chat/drafts.ts`, transcript
   position in `LibrarianTranscript.tsx` and search/history in their existing
   owners. introduce no second cache, draft, return stack or focus state machine.

server contract stays unchanged: existing `GET /api/me` and `PATCH /api/me`
with `reading_brief` and `expected_reading_brief_version`. blank clears; existing
bounds, conflicts, exact uncertain retry and draft retention remain authoritative.
no migration, generated-wire change or wire revision bump.

## content and design ownership

one content designer owns both capabilities: pane identity/action and field
arrival/editing. review content before wiring, at first working interaction and
at final qualification; a separate reviewer challenges the decisions.

- exact new copy: `Librarian` and `Edit reading brief…`. change the canonical
  destination label; do not capitalize ordinary prose or authored messages.
- the section title `reading brief` labels its field; verbs are `save` and
  `revert`. retain the refusal copy and help:
  `what you want to learn, pursue, or avoid. the librarian uses this when answering and choosing reading.`
- good content names the action and object, names both uses and
  promises neither instant reranking nor effects only on newly submitted turns.
  chat reads the brief at execution; queued questions can see a later saved edit.
- use existing controls, spacing, focus treatment and touch targets. escape from
  the menu restores its trigger. field arrival must stay visible with the phone
  keyboard. an accepted explicit save settles the saved text from accent to ink
  over `--duration-deliberate`, as specified by account settings.

## exclusive work packages

source paths below are relative to `apps/web/src/`; `docs/` and lab paths
are relative to the repository root.
one accountable writer per package; one implementer may own several packages.
shared files have one writer.

| owner | files and responsibility | dependency |
| --- | --- | --- |
| a: workspace integration | `lib/workspace/targetActivation.ts`, `lib/workspace/store.tsx`, `components/workspace/WorkspaceHost.tsx`: entry, atomic focus lifetime, cancellation and host handoff | d1, contract review |
| b: librarian editor | `app/(authenticated)/settings/librarian/ReadingBrief.tsx`; `app/(authenticated)/settings/librarian/SettingsLibrarianPaneBody.tsx` only if anchor/readiness wiring requires it: field arrival; preserve existing save/draft owner | a |
| c: librarian/content | `components/chat/Librarian.tsx`, `components/chat/ChatSurface.module.css`, `lib/navigation/destinations.ts`, `lib/panes/paneRouteModel.ts`: menu, removal and canonical label shared by navigation and route title; `docs/modules/chat.md`, `docs/modules/workspace.md`, `docs/librarian-spec.md`: replace superseded composer-link contract | a; designer approval |
| d: qualification | ignored `apps/web/.nexus-lab/cases/` only: temporary journeys, private observations and cleanup | red before a–c; green after |

b and c may proceed independently after a. a owns any necessary changes to shared
navigation/focus primitives; b/c propose them rather than editing those files.
read `AGENTS.md`, local/shared rules and the current verification contract first.

## acceptance and execution

use the existing disposable runtime, real browser, bff, api and database.
write a small set of end-to-end journeys; observe failures at the missing
behavior before implementation. setup failure is not red.

| id | observable proof |
| --- | --- |
| a1 | desktop and phone show `Librarian` in canonical projections; no composer link/empty row; after body mount, overflow has one correctly named command even during search/pending data reads; escape returns focus |
| a2 | from an old-message visit and separately the active search-results view, retain a dirty question, reference, model and nonterminal caret; edit/save/back restores the visit, draft and reading position, including search query/result position, without sending; repeat with another settings pane open according to d1 |
| a3 | focused field contains the existing brief; save changed text and reload to prove persistence; clear/save/reload proves null; failed save preserves the draft; existing unsaved-work protection remains intact |
| a4 | delay real module/profile responses; newer typing, scrolling, overlay activation or pane departure prevents late focus/reveal. ordinary same-visit reactivation cannot revive canceled intent; repeat edit supersedes old delivery; explicit fork targets only the new pane; generic settings/back/forward creates no focus request |
| a5 | visible field, usable controls and retained source state at phone width; qualify actual keyboard visibility once with existing quiet android tooling. emulation alone does not establish native keyboard behavior |

run cases through `./scripts/lab` and its existing browser helpers; no duplicated
harness, internal mocks, lab-only product seams or permanent scenario suite.
provider fakes may prepare real chat history through the existing lab composition;
these tests qualify navigation/persistence, not model quality. keep application
source fixed during each lab invocation.

separate reviewer challenges every stage: contract/content → red cases →
implementation → green behavior → refactor → cleanup. resolve findings before
advancing. repair failures at their responsible owner; record unrelated findings
in individual `docs/issues/` files instead of expanding this change.

after green, remove demonstrated duplication and unreachable code; search all
callers before deleting `.lanes` or shared helpers. rerun affected journeys and
`./scripts/test`. after final qualification, delete only this feature's cases,
fixtures and temporary outputs; retain shared lab infrastructure. record commands,
results, platform limits, net authored lines and removals in the implementation
pr. no application changes or tests are executed by this specification task.

## accepted tradeoffs

overflow adds a click and reduces discovery; the conversation gains space and
quiet. settings retains surrounding account controls; exact field arrival avoids
the search. explicit focus may open the phone keyboard. narrow canonical naming
leaves existing prose unchanged. disposable tests provide qualification evidence
without adding a permanent regression suite. d1 accepts duplicate settings panes
in exchange for reliable source return.
