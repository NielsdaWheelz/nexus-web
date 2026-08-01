# Daily Pages and Quick Capture Hard Cutover

Status: Implemented in source — focused local proof complete; build, physical
iOS, thin real-stack, legacy-draft disposition, CI, deployment, and production
proof pending
Type: Hard cutover
Date: 2026-07-30

**Partial supersession (2026-07-31):**
[`nexus-intent-router-hard-cutover.md`](nexus-intent-router-hard-cutover.md)
removes desktop rail Quick Note/Today, the exactly-four desktop zero state,
Today-not-a-quick-action, Library exclusion, preservation of the old mobile
Root inventory, and AC-15. The daily Page, provisional draft, persistence,
handoff, replay, and editor-ownership contracts remain authoritative.

## Decision

Every account-local date has a latent daily Page address. A database Page exists
only after that date receives its first meaningful Note.

Daily is a role and locator over an ordinary Page. It is not a resource type,
content model, editor, or second notes system. Quick Note is an append entry
into the ordinary Page pane.

The final product is:

- desktop: one click to Quick Note or Today;
- mobile: Nexus, then Quick Note or Today;
- Quick Note: an immediately writable last Note with the keyboard open;
- Today: the same editable Page pane, with no draft or automatic focus side
  effect;
- opening or abandoning a latent date: zero database writes.

No feature flag, dual path, fallback, compatibility alias, or legacy runtime
survives.

## Authority and Landing Order

Land these overlapping cuts serially:

1. `mobile-reader-unified-scroll-chrome-hard-cutover.md`;
2. `mobile-nexus-control-hard-cutover.md`;
3. `mobile-nexus-full-screen-task-hard-cutover.md`;
4. this cutover.

This staged delivery contains the final source for those prerequisite cuts in
the order above, then applies this cut to their final `SwitchboardTask`,
`MobileFullScreenTask`, `useMobileModalLifecycle`, Nexus-control, and
scroll-chrome contracts. Reader-owned reconciliation remains governed by the
reader prerequisite; co-delivery does not collapse its device, real-stack, CI,
deployment, or production proof gates into this cut's focused local proof.

On implementation, update the predecessor documents:

- supersede the read/open/capture and `/daily` deletion clauses in
  `daily-surface-consolidation-hard-cutover.md`;
- supersede preservation of `TodayCapture`, its workflow/recovery variants, and
  `SwitchboardSheet` references in the mobile Switchboard document;
- supersede “New Note reuses Today Capture” in the desktop Nexus document;
- preserve the desktop Nexus zero state at exactly four actions;
- record `SwitchboardTask`, not `SwitchboardSheet`, as the mobile owner.

## Current State

Implementation starts from the landed daily-surface consolidation:

- `(authenticated)/daily/*` are redirects to `/notes`;
- `/daily` and `/daily/{date}` resolve as unsupported pane routes;
- `paneRouteTable.test.ts` asserts that negative contract;
- no daily pane loader, render-registry entry, or frontend daily resource
  locator exists;
- backend daily GETs resolve-or-create Pages;
- Quick Capture creates/resolves the Page in a separate transaction before
  inserting its Note;
- Today Capture is a Nexus workflow/modal with a global recovery key.

Therefore `/daily/{date}` is a net-new non-mutating locator route in this cut. The
old negative route proof and superseded source guards must be removed or
replaced by demonstrated-sensitive positive behavior proof.

## Philosophy

Separate address, role, session, persistence identity, content, and action:

- `YYYY-MM-DD` is the daily address;
- `daily_page_bindings` assigns that role to one ordinary Page;
- a pane visit is the stable editor-session identity;
- `page:{id}` becomes the persistence identity after materialization;
- Page title, Note body, and ordered edges remain content truth;
- Today locates; Quick Note appends.

Input is local-first. Persistence is server-atomic. Reads never write. The
editor must not remount merely because latent content becomes durable.

## Scope / 80-20 Boundary

Build:

- latent-or-materialized daily reads;
- one atomic, replayable first/append capture;
- one net-new `/daily/{date}` pane route using `PagePaneBody`;
- explicit daily hydration inside the existing resource-surface session;
- one provisional last Note, append focus, autosave, and local draft recovery;
- one activation-scoped, pane-directed entry-delivery seam;
- one mobile gesture-time input/keyboard handoff;
- desktop Quick Note and Today rail controls;
- mobile Nexus Quick Note and Today entries;
- one account calendar timezone in authenticated bootstrap and Account Settings;
- hard deletion of Today Capture, old Quick Capture, and mutating locators.

Do not build:

- CRDTs, collaboration, service workers, sync engines, or an IndexedDB outbox;
- background offline delivery;
- widgets, share extensions, lock-screen capture, voice, or PWA shortcuts;
- a calendar, streaks, templates, prompts, reminders, or daily settings;
- a second Page body, editor, pane body, persistence loop, or content table;
- arbitrary-resource attachment to an unmaterialized date;
- renaming an unmaterialized Page;
- Dawn Write redesign or widened sweep eligibility.

## Product Contract

| Entry | Desktop | Mobile | Result |
|---|---:|---:|---|
| Quick Note | rail click | Nexus → Quick Note | today’s Page pane; provisional last Note focused; keyboard open |
| Today | rail click | Nexus → Today | today’s editable Page pane; no draft or automatic focus |
| Date link | `/daily/YYYY-MM-DD` | same | that date in `PagePaneBody` |

Rules:

1. Quick Note accepts input before a daily read or capture response completes.
2. A latent View shows date locator chrome, the ordinary Page masthead, and an
   empty surface without inserting rows.
3. One Quick Note invocation owns one stable Note ID and mutation ID.
4. The first meaningful body creates Page, binding, Note, occurrence, versions,
   and replay receipt in one transaction.
5. Empty or whitespace-only drafts remain local and materialize nothing.
6. Every Quick Note appends at the end of the canonical Page surface.
7. Reinvoking Quick Note while its empty provisional Note exists refocuses it.
8. Acknowledgement never removes newer local keystrokes. Later edits use the
   ordinary resource-surface session.
9. The editable Page title never determines daily identity.
10. Once materialized, the ordinary Page remains durable until explicit Page
    deletion, even if emptied.
11. `/daily/{date}` remains the pane URL for that visit. Do not replace it with
    `/pages/{page_id}` during editing.
12. Save success is quiet. Local-only, saving, failed, retry, reload, and copy
    recovery use the existing pane-local feedback language.

Labels are exactly `Quick Note` and `Today`. A latent masthead uses the
server-returned default title only after the descriptor proves the date latent.
While hydration is unknown, show date locator chrome plus a title skeleton;
never paint a guessed editable title over a renamed materialized Page.

## Final Architecture

```text
desktop rail / mobile Nexus / keybinding
                    |
      OpenDailyPage(date, View | AppendNote)
                    |
        workspace activation + pane visit
         alias match: daily date or page ref
                    |
       pane-directed entry delivery
                    |
       PagePaneBody(DailyDate | PageRef)
                    |
         ResourceSurfaceEditor
      stable session key / mutable page ref
           /                       \
  descriptor hydration       provisional tail Note
           \                       /
       one resource-surface session
                    |
        first meaningful body only
                    |
 POST /notes/daily/{date}/captures
                    |
 Page + binding + Note + edge + versions + replay
          one serializable transaction
```

## Capability Contract

Expose four domain capabilities:

```text
readDailyPage(localDate) -> DailyPageDescriptor
captureDailyPageNote(localDate, mutationId, noteId, body) -> DailyCaptureResult
openDailyPage(localDate | Today, View | AppendNote) -> activation result
updateCalendarTimeZone(IANA zone) -> UserProfile
```

`readDailyPage` is an **unreplayable database read**, not a pure read.
`captureDailyPageNote` is a replayable single mutation.

There is no public `ensureDailyPage`, `resolveDailyPageRef`, daily resource
locator, create-empty-page capability, or title-derived lookup.

## Entry Activation and Pane Identity

Use one target:

```text
OpenDailyPage = {
  kind: "OpenDailyPage",
  localDate: "Today" | "YYYY-MM-DD",
  entry:
    | { kind: "View" }
    | {
        kind: "AppendNote",
        noteId: UUID,
        clientMutationId: string
      }
}
```

The authenticated shell resolves `Today` synchronously from its bootstrapped
account timezone, freezes the explicit date, then dispatches. Retry never
recomputes the date.

Entry delivery is not global state keyed by Page source. Extend the existing
workspace activation-delivery pattern:

```text
PaneEntryDelivery = {
  activationId,
  paneId,
  visitId,
  entry
}
```

- workspace activation chooses or creates the pane first;
- an accepted activation directs the entry to that exact pane visit;
- lazy mounts queue the delivery until that visit subscribes;
- an already-open pane receives it immediately;
- each activation ID is consumed exactly once for the workspace-provider
  lifetime;
- one visit holds at most one unclaimed delivery: a newer accepted entry
  supersedes it and View cancels it;
- acknowledgement carries the exact claimed delivery; a stale acknowledgement
  cannot clear its replacement;
- rejected, superseded, closed, or `ActivationBlocked` activation cancels it;
- View carries no entry delivery.

`PagePaneBody` publishes a daily alias when it knows a Page has
`dailyPage.localDate`. The planner derives `daily:{date}` and `page:{id}` from
their routes and unions them with published aliases, so matching is symmetric.
A Quick Note therefore reaches an already open `/pages/{id}` pane instead of
opening a duplicate `/daily/{date}` pane, and an ordinary Page open reaches a
materialized dated pane.
After a latent pane materializes, it publishes the returned Page ref without
changing its mount key or URL.

Do not add `PageEntryIntent.FocusTitle`. It has no producer.

## Mobile Gesture-Time Input Handoff

Programmatic focus after async dispatch cannot open the iOS keyboard. The final
`SwitchboardTask` must own a small `MobileQuickNoteHandoff` using the final
`useMobileModalLifecycle` focus contract.

On the actual Quick Note tap:

1. synchronously focus a real, task-owned text input before any promise;
2. create the activation, Note, and mutation identities;
3. buffer input, paste, deletion, and IME composition while the pane loads;
4. checkpoint that buffer through the same date-scoped draft store used by the
   resource-surface session;
5. keep the handoff mounted after the task becomes inactive;
6. when the target `NoteBodyEditor` is ready, transfer buffered content,
   selection, composition-safe focus, and keyboard ownership exactly once;
7. clear the bridge only after the destination acknowledges the claim.

On activation rejection, cancellation, or close, release keyboard/focus
ownership and retain any meaningful buffer as the same recoverable daily draft.
No stale append delivery may survive into a later Today activation.

The bridge owns no network request, autosave loop, or second draft schema. It is
only the gesture-to-editor ingress for the existing daily session. Real iOS
Safari proof is a release gate; Chromium focus tests are insufficient.

## Page and Editor Composition

```text
PagePaneSource =
  | { kind: "PageRef", pageId }
  | { kind: "DailyDate", accountId, localDate }
```

`PagePaneBody` remains the sole pane body. `ResourceSurfaceEditor` remains the
sole masthead/body compositor. Generalize, do not fork,
`useResourceSurfaceSession`:

```text
Daily hydration =
  Hydrating
  | Latent
  | Materialized(pageRef, acknowledgedSurface)

Optional append =
  None
  | Provisional(noteId, mutationId, latestBody)
  | FirstCaptureInFlight(...)
```

Required invariants:

- the pane visit/session key is stable across all states;
- persistence `sourceRef` is nullable, then replaceable without remount;
- the editor may render and edit the provisional tail while Hydrating;
- a late materialized read inserts persisted rows **before** the provisional
  final Note;
- the focused Note DOM/editor instance, caret, composition, and scroll anchor
  survive that merge;
- prepend/hydration measures the focused Note before and after and compensates
  scroll by the row-height delta, including with the mobile keyboard open;
- capture acknowledgement adopts the returned Page ref and surface in place;
- body changes typed after capture send remain overlaid on the acknowledged
  body and are saved afterward; the response cannot overwrite them;
- generation fencing rejects stale descriptor, capture, reload, and retry
  completions;
- ordinary title/body/structural mutation behavior is unchanged after adoption.

Recovery keys are versioned and account/date scoped:

```text
nexus.dailyDraft:{accountId}:{localDate}
```

The payload owns Note ID, mutation ID, body JSON/text, and handoff state.
Local recovery is not an outbox: reconnect does not submit automatically.
The user explicitly retries, reloads, copies, clears, or resumes editing.

## Data Model

Use the next Alembic revision:

```text
users.calendar_time_zone TEXT NOT NULL DEFAULT 'UTC'

daily_page_bindings
  id          UUID PK
  user_id     UUID FK users.id
  local_date  DATE NOT NULL
  page_id     UUID FK pages.id
  created_at  TIMESTAMPTZ NOT NULL
  CONSTRAINT uq_daily_page_bindings_user_date UNIQUE (user_id, local_date)
  CONSTRAINT uq_daily_page_bindings_user_page UNIQUE (user_id, page_id)
```

Migration:

1. add `users.calendar_time_zone`;
2. for each user, select the first non-deleted binding ordered by
   `updated_at DESC, created_at DESC, id DESC` whose timezone is accepted by
   `ZoneInfo`; otherwise use `UTC`;
3. delete soft-deleted binding rows; do not delete their ordinary Pages;
4. rename `daily_note_pages` to `daily_page_bindings`;
5. explicitly rename both uniqueness constraints to the names above;
6. drop binding `time_zone`, `updated_at`, `deleted_at`, and the timezone check;
7. make the user column non-null and retain `UTC` as the creation default.

Update the ORM owner to `DailyPageBinding`. Add both binding uniqueness
constraints to `RETRYABLE_UNIQUE_CONSTRAINTS`; include `python/nexus/db/retries.py`
in the implementation and proof scope.

Keep Page content in `pages`, Note content in `note_blocks`, placement in
`resource_edges`, versions in `resource_versions`, and replay in
`resource_mutations`.

Alembic downgrade is intentionally unsupported. “Rollback” proof below means
database transaction rollback under injected failure, not schema downgrade.

## API Contract

Do not perform a format-wide casing cutover. Preserve each existing API owner’s
wire convention and exact-decode it once at the BFF/client boundary.

This cut explicitly changes the Page role field:

```text
NotePageOut.dailyNote  ->  NotePageOut.dailyPage
wire dailyNote        ->  wire dailyPage
```

All `/notes/pages*`, surface, BFF, Page pane, date-navigation, Dawn Write, and
test consumers change atomically. There is no `dailyNote` alias.
`NotePageOut` otherwise retains its existing camelCase serialization.

### Read

```text
GET /notes/daily/{local_date}

DailyPageDescriptor =
  | {
      kind: "Latent",
      localDate: "YYYY-MM-DD",
      defaultTitle: string
    }
  | {
      kind: "Materialized",
      localDate: "YYYY-MM-DD",
      page: NotePageOut,
      surface: ResourceSurface
    }
```

The route validates the date and ownership, then reads only. The server owns
`defaultTitle(localDate)` and reuses that function in the capture transaction;
the client never independently constructs the latent title.

`/daily` is a server-only account-zone redirect to `/daily/{localDate}`. It is
not a pane route. Only `/daily/{localDate}` is registered as the net-new
`dailyDate` pane route. It uses no mutating `PaneResourceLocator`.

### Capture

```text
POST /notes/daily/{local_date}/captures

{
  clientMutationId: string,
  noteId: UUID,
  bodyPmJson: ProseMirrorDocument
}

-> {
  clientMutationId: string,
  localDate: "YYYY-MM-DD",
  pageId: UUID,
  surface: ResourceSurface
}
```

`text_from_pm_json(bodyPmJson).strip()` must be non-empty. Otherwise return the
named product error `E_EMPTY_NOTE_BODY` and insert no replay receipt.

Replay scope is the justified non-resource scope `daily:capture`: a latent date
has no Page ref. The canonical request hash includes the explicit date. Reusing
one mutation ID at another date therefore returns an idempotency mismatch
instead of creating a second Note. After acknowledgement, ordinary
resource-scoped surface/body mutations resume.

The replayable serializable transaction:

1. returns an exact replay, or rejects a hash mismatch;
2. reads the binding;
3. if absent, creates Page, initial versions, and binding;
4. calls the canonical surface insert helper for the client Note ID at `end`;
5. records the replay response and commits once.

Generate any server Page ID once outside the bounded retry loop and reuse it
across attempts. On a binding uniqueness race, roll back the whole attempt,
retry through `retry_serializable`, re-read the winning binding, and append to
that Page. No losing Page or versions may commit.

### Account

Add `calendar_time_zone` to `GET /me` and to the existing `PATCH /me` profile
mutation. Validate it through `ZoneInfo`; it is non-null when supplied. Account
Settings edits the same field. Do not add a second profile endpoint.

`loadWorkspaceBootstrap` fetches `/me` in the existing concurrent required
bootstrap wave and exposes the account ID and calendar timezone to the
authenticated shell. Quick Note/Today controls are interactive only after this
required bootstrap succeeds; the hot path performs no profile read.

Changing the setting affects later Today resolution only. Existing bindings do
not move.

## Entry UI

- Desktop `NavRail` adds one compact action group immediately below the command
  bar and above the scrollable Places list: `Quick Note`, then `Today`.
- Expanded rail shows labels; collapsed rail shows the existing tooltip/focus
  treatment. These are actions, not navigation-list rows.
- `Nexus.Quick.Note` is relabeled `Quick Note` and maps to AppendNote.
- Desktop Nexus zero state remains exactly Quick Note, New Chat, New Page, and
  Import.
- Today is a Place/navigation result, not a quick-action category and not
  `Nexus.Quick.Today`.
- Mobile `SwitchboardTask` Root exposes the same Quick Note action and Today
  Place. Add no second FAB, dock, or mobile-only launcher.
- Both controls use at least the final mobile Nexus contract’s 48px interactive
  target, visible focus, and reduced-motion behavior.
- Bindable shortcuts dispatch the same `OpenDailyPage` target.

## Other Callers

### Share Capture

`ShareCapture` lives outside authenticated bootstrap. Before its first plain-text
capture attempt, read `/me`, exact-decode `calendar_time_zone`, compute and store
one explicit account-local date with its existing Note/mutation IDs, then call
the dated capture endpoint.

Once stored, retries reuse that date and do not refetch or cross midnight.
Profile-read failure is an explicit capture failure with Retry; no capture
request is sent.

### Agent `jot_note`

The authenticated tool handler resolves and freezes the account-local date once
per tool operation, then calls the same capture service. Existing tool replay
and undo ownership remain authoritative. Do not retain `quick_capture`.

### Dawn Write

Keep the existing active eligible population: users with at least one
non-deleted binding before this cut. Soft-deleted-only binding rows are
tombstones, not eligibility; the legacy sweep's accidental inclusion of them
ends with their required deletion. Join `users.calendar_time_zone` onto the
surviving binding population instead of reading binding timezones. Do not sweep
all users. Dawn Write remains a contextual projection: it neither materializes
the Page nor enters its `ResourceSurface`.

## Hard-Cut Replacement

Delete:

- `TodayCapturePanel.{tsx,module.css,test.tsx}`;
- `useTodayCaptureSession.ts`;
- frontend and backend `/notes/quick-capture`;
- `QuickCaptureRequest`, `quickCaptureDailyNote`, and `quick_capture`;
- `TodayCapture`, `OpenTodayCapture`, and `OpenToday` workflow/recovery variants;
- `DailyNoteTodayLocatorIn`, `DailyNoteDateLocatorIn`, resolver branches/tests;
- browser timezone query parameters and binding timezone reads;
- old `DailyNotePage`, `daily_note_pages`, `dailyNote`, and `daily_note` names;
- the global `quick-note:daily` recovery path;
- `/daily` unsupported assertions and superseded anti-daily route guards;
- `apps/web/src/app/(authenticated)/daily/__screenshots__/`.

Adapt/reuse:

- `PagePaneBody`, `ResourceSurfaceEditor`, `NoteBodyEditor`;
- `useResourceSurfaceSession` and its autosave/recovery/conflict feedback;
- `resource_items/surfaces.py` insertion and surface projection;
- resource versions, replay ledger, serializable retry owner, and edges;
- workspace target activation and pane-directed delivery pattern;
- pane route/render registries for the net-new `dailyDate` route;
- final Nexus quick-action/result/dispatch owners and `SwitchboardTask`;
- desktop `NavRail`, keybinding registry, `/me`, Account Settings, Dawn Write;
- `ShareCapture` and agent-tool `jot_note`.

Do not preserve completed-cutover source-grep tombstone tests. Use types,
schema/AST checks where mechanically appropriate, and behavioral proof.

## Files

| Area | Primary files |
|---|---|
| Migration/model/retry | next Alembic revision; `python/nexus/db/{models,retries}.py` |
| Backend API/domain | `api/routes/{notes,me}.py`; `schemas/{notes,user}.py`; `services/{notes,note_bodies,users}.py`; `services/resource_items/surfaces.py` |
| Daily routes/BFF | `(authenticated)/daily/{page,[localDate]/page}.tsx`; `app/api/notes/daily/**`; `lib/notes/{api,openDailyPage,dailyDraftStore}.ts` |
| Bootstrap/account | `lib/workspace/bootstrap.server.ts`; bootstrap provider/store; Account Settings |
| Page/editor | `PagePaneBody.tsx`; `ResourceSurfaceEditor.tsx`; `NoteBodyEditor.tsx`; `useResourceSurfaceSession.ts`; `dailySurfacePersistence.ts` |
| Activation | Nexus model/results/dispatch/quickActions; workspace target activation, pane runtime, alias and entry delivery owners |
| Mobile | final `SwitchboardTask.tsx`; `useMobileModalLifecycle.ts`; new focused handoff beside those owners |
| Desktop | `NavRail.tsx`, `AppNav.tsx`, styles, keybinding registry |
| Other callers | `app/share/ShareCapture.tsx`; `services/agent_tools/writes.py`; `tasks/dawn_write.py` |
| Docs/proof | architecture, predecessor supersession notes, focused tests beside each owner |

## Implementation Order

1. Land prerequisites and rebase this spec onto their final owners.
2. Migrate data/model/profile/retry constraints.
3. Add read and atomic capture domain/API proof.
4. Add required `/me` bootstrap state.
5. Generalize the resource-surface session and daily Page source.
6. Add the net-new `dailyDate` route and workspace alias/entry delivery.
7. Add mobile input handoff; prove it before deleting Today Capture.
8. Adapt desktop/mobile entry UI and non-editor callers.
9. Delete all superseded paths and update architecture/predecessor docs.
10. Run focused, real-stack, device, CI, and deployment proof separately.

No temporary adapter may survive its slice.

## Acceptance Criteria

1. Opening a valid latent date leaves counts unchanged in Pages, bindings,
   Notes, edges, versions, and replay rows.
2. From an interactive shell, desktop reaches a writable Quick Note in one
   click and mobile in Nexus plus one tap; text entered before pane hydration is
   present in the final editor.
3. A physical iOS Quick Note tap opens the keyboard without another tap and
   transfers focus, selection, paste, and IME-safe input exactly once.
4. Today creates no draft, focuses no editor, and opens no keyboard. A rejected
   Quick Note activation cannot affect a later Today activation.
5. First meaningful capture adds exactly one Page, binding, Note, end
   occurrence, required versions, and replay receipt in one commit.
6. Clearing or abandoning an empty/whitespace latent draft adds none of those
   rows.
7. Exact replay returns the same Page/Note/surface. Two concurrent first
   captures commit one bound Page and both Notes exactly once, with no orphan
   Page or versions.
8. If text B is typed after capture sends text A but before acknowledgement,
   the editor remains focused and reload returns A+B exactly once.
9. A delayed materialized read places persisted rows before the provisional
   final Note without moving its visible scroll anchor, caret, or composition.
10. Disconnecting before first save, then reloading the same account/date,
    restores the draft locally and sends nothing until explicit retry.
11. A renamed materialized Page never flashes the default latent title.
    Renaming does not change its daily date.
12. Bootstrap-zone Today differs correctly from browser-zone Today; changing
    the account zone changes future Today resolution and moves no binding.
13. Share Capture freezes one account-local date, reuses it after midnight, and
    sends no capture when its profile read fails.
14. Old Quick Capture returns 404, old daily locator payloads fail exact schema
    decoding, and `/daily/{date}` resolves the new `dailyDate` pane.
15. Desktop exposes exactly two rail actions and exactly four Nexus zero-state
    actions. Mobile retains one Nexus control, its existing Root inventory,
    Today as a Place, and 48px targets.
16. Dawn Write preserves the active-binding eligible population, excludes
    soft-deleted-only tombstones, creates no daily Page, and never enters Page
    surface content.

## Required Proof

Every proof names its risk and independent oracle. Record sensitivity:

- positive `/daily/{date}` route proof is red against the current unsupported
  route;
- immediate-input/ack proof fails with the old source-ref remount or an injected
  stale response;
- concurrent PostgreSQL proof establishes one-Page/two-Note convergence;
- deterministic binding-race retry proof fails when either binding constraint
  classification is removed;
- atomicity proof injects failure after each write phase and observes zero
  committed partial rows;
- replacement Today Capture proof is red against the old modal/workflow path
  before that proof is deleted;
- physical iOS proof records the pre-cut extra-tap/lost-keyboard behavior, then
  the passing handoff.

Proof tiers:

- real PostgreSQL: migration/backfill ordering, zero-write read behavior,
  meaningful-body rejection, replay/hash mismatch, transaction rollback, and
  concurrency;
- real Chromium: provisional input, delayed read, post-send typing, merge/scroll
  anchoring, alias re-entry, rejection cancellation, local recovery, and entry
  UI;
- physical iOS Safari: two-tap path, soft keyboard, rapid input, paste, IME,
  rotation, and failure handoff;
- focused Page, surface, Nexus, workspace, Account, Share, Dawn Write,
  migration, typecheck, lint, and build gates;
- thin real-stack journey for authenticated bootstrap → Quick Note → reload.

Report local, PostgreSQL, Chromium, device, real-stack, CI, deployment, and
production evidence separately. Unrun tiers remain unverified.

## Operational Hard Cut

Before deploying this one-user prototype, open the existing Today Capture and
save, copy, or explicitly discard any recovered `quick-note:daily` draft.
Record that precondition, then delete the key and runtime with no import path.

This is the sole accepted destructive edge of the cut. Durable server Notes are
not affected.
