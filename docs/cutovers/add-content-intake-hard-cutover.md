# Add Content Intake — Hard Cutover

**Status:** IMPLEMENTED · 2026-07-21
**Type:** Hard cutover — no legacy path, fallback, dual behavior, feature flag, or backward compatibility.

## 0. Decision

Explicit Add becomes one source-first workbench inside the existing Launcher:

1. enter links or choose PDF/EPUB files;
2. optionally choose filing;
3. review local intent;
4. submit explicitly;
5. retain outcomes for individual or bulk filing changes.

OPML is one secondary branch, not an initial mode choice. Delete the Add lane/menu,
Content/OPML tabs, enqueue-to-submit behavior, library-first layout, and automatic
success navigation/close.

The pre-cutover implementation mostly conformed to the superseded Add policy in
`universal-launcher-hard-cutover.md`; those were product-policy limitations, not
implementation drift. This document replaces only that document's Add behavior.
Durable ingest, library ownership, Launcher overlay, and podcast domain contracts stay
normative except for the one membership-removal addition in §5.

No product question remains open.

### Verified pre-cutover baseline

- `AppNav` opens `{lane:"add"}`; Launcher renders a URL/file/OPML chooser.
- `AddPanel` orders Libraries before sources. Launcher autofocus—not picker initial
  state—opens the first combobox; the picker has no compact disclosure trigger.
- Queue effects submit staged rows; single success can navigate and close.
- Batch destinations copy only into later rows; Accepted rows lose filing controls.
- Library-pane Add drops its library context. Scoped media removal is document-only,
  while URL intake can create other media kinds.

These were verified pre-cutover contracts, mostly inherited from the superseded Launcher
policy; the removal-kind mismatch was an API capability gap.

## 1. Goals, rules, and boundary

### Goals

- Optimize one job: **get sources into Nexus, then optionally file them**.
- Source and local validation precede organization and explicit network acceptance.
- Outcomes remain actionable and truthful across reuse, partial failure, uncertainty, and
  processing failure.
- One ingest, destination, membership, overlay, and bounded-execution path owns each concern.
- Ship a small-batch workbench, not an import subsystem.

### Product and visual rules

- Progressive disclosure and visual weight follow source → queue → outcomes.
- Libraries and OPML stay subordinate; no source card grid, equal-weight bordered regions,
  nested pre-accept modal, or permanently reserved option height.
- One neutral surface, token spacing, dense rows, sticky actions, two-line source labels,
  and text-owned status. Color and icons are redundant cues only.
- One concern has one owner; presentation never starts ingest or owns transport policy.

### In scope

- Desktop/mobile Add entry, URL/PDF/EPUB intake, draft/outcome filing, OPML handoff,
  focus/dismissal, one media-membership removal command, and hard deletion of everything
  these contracts replace.

### Non-goals

- Backend work beyond §5's membership/reference concurrency consolidation, error, and BFF; no new
  table, migration, queue, ingest semantic, or server batch/exact-set API.
- Durable drafts, resumable/chunked/background-worker uploads, percentage progress, or
  per-item pause/resume.
- Cross-media transactions, client hashing/AI dedupe, automatic filing/library recency,
  arbitrary files, large-import history/virtualization, or an import framework.
- Per-feed OPML preview/mapping/hierarchy/post-import filing.
- Waiting for readiness or redesigning Share Capture, Browse, podcast detail, or bare-URL
  capture beyond required shared-contract/error-boundary migration.

### Accepted 80/20 limits

- Add state is browser-memory only and disappears after an accepted discard/Done/reload.
- `ADD_SESSION_MAX_ITEMS = 20` across all URL/file rows; OPML keeps its server limit.
- Client fan-out is bounded and partial, not durable.
- File membership editing begins only after upload/confirm settles as Accepted.
- Whole-session Stop uses `AbortSignal`; already-accepted server effects may survive.
- No client-side canonical file dedupe exists.

## 2. Capability contract

| Capability   | Final contract                                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry        | Navigation `+` opens Add content directly. Matching non-empty queries expose URL/file/OPML aliases. No Add lane/menu/query sigil exists.       |
| Intake       | Links first, compact choose/drop PDF/EPUB second, closed optional Libraries third, OPML last.                                                  |
| Staging      | Review/file selection creates local rows only. The session cap is atomic; overflow never truncates silently.                                   |
| Draft filing | My Library is implicit. One movable all-drafts control plus per-row controls remain available until submission.                                |
| Submission   | `Add N items` freezes valid row intent and runs at concurrency `2`; invalid rows are excluded.                                                 |
| Outcomes     | No automatic navigation. Settled Accepted rows retain status, Open, and authoritative individual/bulk membership editing.                      |
| OPML         | Secondary branch; OPML/XML ≤1,000,000 bytes and ≤200 RSS outlines; one destination set; aggregate result.                                      |
| Dismissal    | Reads abort/discard. Dirty or active work is guarded. Explicit Stop aborts browser requests and warns that accepted server effects can remain. |

## 3. Target behavior

### 3.1 Entry and hierarchy

- Navigation Add opens Content: Links focused on desktop, heading on mobile. URL/file
  aliases focus that control; OPML aliases open OPML. Editable non-default library context
  seeds full `id/name/color`; general Add/My Library seed none.
- Empty order: Links + `Review links`; compact PDF/EPUB choose/drop + exact limits; closed
  `Libraries · My Library only · Change`; subdued OPML link.
- Non-empty Add is one ordered mixed-state queue. Source entry collapses behind `Add more`.
  Show one movable all-Drafts toolbar iff Drafts exist; show result summary and explicit
  `Add all to…` / `Remove all from…` iff settled Accepted rows exist.
- Sticky primary action: `Add N items`, active progress, else `Done`.
- Delete only the Add lane/menu/query sigil/legend. Keep navigation `+`, query-result id
  `"add"`, matching URL/file/OPML commands, and bare-URL one-step capture.

### 3.2 Staging and validation

- `Review links` runs `extractUrls` once and exact-dedupes that paste. No valid URL leaves
  text in place with one field error; prose never becomes an Invalid row.
- File choice stages no request. Locally reject unsupported/empty files, PDF >100 MB, and
  EPUB >50 MB as identified Invalid rows. Reject a >20-row staging action atomically;
  never truncate or clear its input.
- Raw URL text/feedback lives in the lifted session and is dirty before Review. Successful
  staging collapses entry and focuses stable queue status; Add more restores source focus;
  focused removal chooses next, previous, then Add more/source.
- Drafts own destination objects. All-Drafts overwrites current Drafts; row edit affects
  one; new Draft copies the current default. Freeze derives ordered IDs once. Invalid and
  accepted rows do not change. My Library is implicit and never enters `library_ids`.

### 3.3 Submission and outcome truth

- Submit freezes source, destinations, and existing key; concurrency is `2`; success never
  rolls back peers or auto-navigates.
- A definitive typed rejection before identity becomes Rejected, never uncertainty. It
  retains intent/feedback; only explicit `Restage` creates a Draft/new key. Rejected,
  unresolved, and AcceptedUncertain rows can be removed; removal discards local tracking
  and never claims or performs server rollback.
- An ambiguous URL/upload-init transport outcome before a decoded identity retains the
  intent and `Check status`; same-key replay yields Accepted, Rejected,
  AcceptedUncertain, or updated AcceptanceUnresolved. Missing identity in a decoded
  same-system success is a defect. A new key requires explicit `Restage as new`.
- Upload init `(mediaId, sourceAttemptId)` identity is durable acceptance. Later
  PUT/sign/confirm ambiguity retains both fields + frozen file intent as
  AcceptedUncertain, never synthetic processing failure. Same-key reconciliation must
  preserve both identity fields.
  It exposes Open and `Check status`, but no filing because confirm still carries frozen
  `library_ids`; reconciliation yields settled Accepted or updated uncertainty.
- Upload PUT/confirm maps only `TypeError`, non-Abort `DOMException`, `E_UPSTREAM`, and
  `E_UPSTREAM_TIMEOUT` to AcceptedUncertain. Same-system and every other unapproved
  post-init failure throw into the session's fail-closed path.
- Same-system/schema/unclassified failures are defects, never product feedback. Before a
  durable identity exists, the session restores the frozen Draft—including source,
  destinations, and key—and rethrows. Once an upload identity is known, the mutation stays
  fail-closed: it does not release the gate or invent a row outcome. Explicit Stop is the
  recovery boundary; it invalidates the generation and preserves that identity as
  AcceptedUncertain.
- Settled Accepted replaces `File` with summary and exposes durable media actions even on
  processing failure. Other source-bearing states may retain `File`; no acceptance Retry
  exists after identity.

| State                            | Text                                                         |
| -------------------------------- | ------------------------------------------------------------ |
| Draft                            | `Ready to add`                                               |
| Rejected                         | `Not added` + mapped reason + `Restage`                      |
| Acceptance replay/reconciliation | `Checking…`                                                  |
| URL/File active                  | `Saving…` / `Uploading…`                                     |
| Created + pending/extracting     | `Saved · processing`                                         |
| Created + ready                  | `Saved · ready`                                              |
| Created + failed                 | `Saved · processing failed`                                  |
| Reused + pending/extracting      | `Already in Nexus · processing`                              |
| Reused + ready                   | `Already in Nexus · ready`                                   |
| Reused + failed                  | `Already in Nexus · processing failed`                       |
| Accepted uncertain               | `Saved · status unknown`                                     |
| Membership active                | Separate `Updating libraries…`; never replaces ingest status |

Only decoded modeled errors become row feedback (with request ID). Add owns this
exhaustive mapping; do not copy `mediaCaptureStatus`.
`isSameSystemApiDefect` is the shared classifier for `E_INVALID_RESPONSE`, `E_UNKNOWN`,
and `E_INTERNAL`; classification is by code, independent of HTTP status. Add, upload
confirm, and `sourceUrlCapture` consume it rather than restating local status heuristics.

### 3.4 Filing after acceptance

- Settled Accepted rows lazily read authoritative non-default memberships from
  `GET /api/media/{id}/libraries`; delete frontend default filtering.
- Bulk Add/Remove are distinct commands over unique settled media. Load candidates first;
  call only eligible absent/present rows; skipped rows are no-ops. Mixed state is never one
  boolean toggle.
- One session membership command snapshots IDs and disables all filing; later Accepted
  rows do not inherit it. Fan-out is `2`. After mutation error, re-read: desired state is
  success; otherwise Retry refreshes first. Filing never calls ingest/resource deletion.

### 3.5 OPML

- OPML is a branch, not tab/row. It copies Content defaults once; later branch edits and
  Back do not mutate Content.
- Before reading bytes, reject no/empty/unsupported/>1,000,000-byte file. Decode the
  `ArrayBuffer` with fatal UTF-8 locally; server owns XML/root validation and the
  200-RSS-outline cap.
- Copy is `Libraries for new subscriptions`. Empty is `No libraries selected`: My
  Library cannot receive podcasts. Send `default_library_ids` and
  `per_feed_library_ids: {}`; already-active subscriptions skip without refiling.
- Strictly reject counters whose classified outcomes exceed Total. Show returned
  Total/Imported/Already subscribed/Invalid; derive `Could not subscribe = total -
imported - already - invalid`. Errors are Issues, never a failed count because
  post-success issues exist.
- `Manage podcasts` navigates and closes Add. Idle Back discards OPML-local state.

### 3.6 Focus, disclosure, navigation, and dismissal

- Launcher overlay solely owns initial-focus timing; Add/OPML expose targets, not mount
  focus effects. `AddPanel` owns source-target resolution and its fallback; controller and
  shells do not inspect panel DOM. Focus key includes session/branch; dialog name equals
  visible heading.
- `LibraryDestinationDisclosure` is inline: trigger `aria-expanded` +
  `aria-controls`, no `aria-haspopup`. One owner controls disclosure visibility.
  Toggle/Escape close it and Escape restores trigger focus. Do not add document-wide
  outside-pointer dismissal. While destination creation is active, the disclosure stays
  mounted and its toggle/Escape close commands are disabled.
- Adapt one canonical picker; search/paging/create/selection/active-option/listbox logic is
  not duplicated.
- Escape order is nested mobile membership Dialog → destination disclosure → OPML branch
  → Add → Launcher. Header/footer stay stable while the body scrolls; mobile actions
  stack; DOM and focus order follow visual order.
- One polite region announces progress/failure summary; row errors are associated text,
  not alert storms.
- One session mutation gate admits submit, acceptance reconciliation, destination
  creation, OPML import, or membership mutation. While held, every competing source,
  filing, branch, and destination command disables; reads may continue. The active
  operation observes the session `AbortSignal`, and stale completion cannot mutate the
  next generation.
- Add contract defects are retained above desktop/mobile projections and rendered by an
  Add-only boundary inside the still-mounted shell/history owner. Recovery clears stale
  dismissal intent; known upload identity requires explicit Stop before the Add panel is
  restored. Non-Add defects are not mislabeled or caught by this boundary.
- Explicit Open navigates/closes; Done closes in place; rows otherwise persist. Every
  Escape/backdrop/drag/Back/Close/Done/navigation path calls `requestDismiss`; reads abort.
  Dirty work uses existing confirmation. Active mutation blocks incidental dismissal and
  visible Close offers `Keep working` or `Stop and close`.
- Controller replacement, open events, and keyboard shortcuts also request replacement
  through that dismissal gateway; none resets or replaces the active Add session directly.
- Stop aborts browser requests, invalidates stale completions, and warns: server changes
  that already committed may remain; unfinished upload bytes may not. Register
  `beforeunload` only while browser-owned mutations are active.

## 4. Final architecture

### 4.1 Ownership and composition

| Owner                                                         | Responsibility                                                                                                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Launcher model/events/controller                              | Tagged Root/Add intent, one Add session above desktop/mobile shells, branch navigation, initial-focus timing, and sole dismissal/replacement gateway.               |
| `addContentSessionModel.ts`                                   | Pure unions, reducer, selectors, cap/freeze/dirty invariants, and derived actions.                                                                                  |
| `useAddContentSession.ts`                                     | One mutation gate, transport orchestration, strict defect restoration/fail-closed handling, submit/reconcile, abort generation, and serialized membership commands. |
| `AddPanel.tsx`, `AddPanelBoundary.tsx`, `OpmlImportPanel.tsx` | Add-only projection, defect recovery, and user intent; `AddPanel` owns source-focus target/fallback resolution, but none owns workflow state or raw endpoint calls. |
| Destination picker/disclosure                                 | One destination-object selection model; inline/disclosure presentations; session-owned creation.                                                                    |
| Ingest clients                                                | Boundary validation, durable acceptance mapping, upload uncertainty, and transport.                                                                                 |
| Membership clients/panel                                      | Authoritative non-default reads and idempotent add/remove commands; single/bulk presentation.                                                                       |
| `runBoundedTasks.ts`                                          | Ordered, joined, non-fail-fast bounded execution; no domain policy.                                                                                                 |
| Podcast OPML client                                           | Existing request/result boundary used by the Add session.                                                                                                           |
| Library backend                                               | Atomic media-entry add/remove authorization and one media→library reference-mutation protocol, including library teardown.                                          |

`useAddContentSession` is instantiated once in the Launcher controller, not in either
surface. Viewport changes therefore cannot discard state, duplicate effects, or lose busy
guards. Surfaces never mutate or close the session directly.

### 4.2 Client schemas

```ts
type LibraryDestinationSelection = Pick<
  LibraryDestination,
  "id" | "name" | "color"
>;
type AddSeed =
  | {
      kind: "Content";
      initialFocus: "Url" | "File";
      initialDestinations: readonly LibraryDestinationSelection[];
    }
  | {
      kind: "Opml";
      initialDestinations: readonly LibraryDestinationSelection[];
    };
type AddSource =
  | { kind: "Url"; url: string }
  | { kind: "File"; file: File; fileKind: "Pdf" | "Epub" };
type FileSummary<K extends "Pdf" | "Epub" | "Opml" | "Unsupported"> = {
  kind: "File";
  name: string;
  sizeBytes: number;
  fileKind: K;
};
type SourceSummary = { kind: "Url"; url: string } | FileSummary<"Pdf" | "Epub">;
type FrozenAcceptanceIntent = Readonly<{
  source: AddSource;
  destinations: readonly LibraryDestinationSelection[];
  idempotencyKey: string;
}>;
type AddItem =
  | {
      kind: "Invalid";
      id: string;
      source: FileSummary<"Pdf" | "Epub" | "Unsupported">;
      feedback: FeedbackContent;
    }
  | ({ kind: "Draft"; id: string } & FrozenAcceptanceIntent)
  | { kind: "Submitting"; id: string; intent: FrozenAcceptanceIntent }
  | {
      kind: "Rejected";
      id: string;
      intent: FrozenAcceptanceIntent;
      feedback: FeedbackContent;
    }
  | {
      kind: "AcceptanceUnresolved";
      id: string;
      intent: FrozenAcceptanceIntent;
      feedback: FeedbackContent;
    }
  | {
      kind: "AcceptedUncertain";
      id: string;
      intent: FrozenAcceptanceIntent & {
        source: Extract<AddSource, { kind: "File" }>;
      };
      mediaId: string;
      sourceAttemptId: string;
      feedback: FeedbackContent;
    }
  | {
      kind: "Accepted";
      id: string;
      source: SourceSummary;
      result: SourceIngestResult;
    };
type MembershipCommand =
  | { kind: "Add"; libraryId: string }
  | { kind: "Remove"; libraryId: string };
type MembershipWork = {
  libraries: readonly LibraryTargetPickerItem[];
  command: MembershipCommand;
};
type RestingMembershipState =
  | { kind: "Unloaded" }
  | { kind: "Ready"; libraries: readonly LibraryTargetPickerItem[] }
  | { kind: "LoadFailed"; feedback: FeedbackContent }
  | ({ kind: "CommandFailed"; feedback: FeedbackContent } & MembershipWork);
type MembershipState =
  | RestingMembershipState
  | { kind: "Loading"; previous: RestingMembershipState }
  | ({ kind: "Updating" } & MembershipWork)
  | ({ kind: "Reconciling" } & MembershipWork);
type MembershipMutationProgress = MembershipWork & {
  phase: "Queued" | "Started" | "Succeeded";
};
type SessionMutationOperation =
  | { kind: "Submit"; itemIds: readonly string[] }
  | { kind: "ReconcileAcceptance"; itemId: string }
  | { kind: "CreateDestination" }
  | { kind: "ImportOpml" }
  | {
      kind: "Membership";
      command: MembershipCommand;
      mediaIds: readonly string[];
    };
type SessionMutationState =
  | { kind: "Idle" }
  | { kind: "Running"; operation: SessionMutationOperation };
type OpmlImportState =
  | { kind: "Empty" }
  | {
      kind: "Invalid";
      input: { kind: "NoFile" } | { kind: "File"; file: File };
      feedback: FeedbackContent;
    }
  | { kind: "Ready"; file: File }
  | { kind: "Importing"; file: File }
  | { kind: "Failed"; file: File; feedback: FeedbackContent }
  | {
      kind: "Complete";
      file: FileSummary<"Opml">;
      result: PodcastOpmlImportResult;
    };
type AddSessionState = Readonly<{
  sessionId: string;
  branch: "Content" | "Opml";
  initialFocus: "Url" | "File" | "Opml";
  urlInput: { text: string; feedback?: FeedbackContent };
  intakeFeedback?: FeedbackContent;
  items: readonly AddItem[];
  defaultDestinations: readonly LibraryDestinationSelection[];
  opmlDestinations: readonly LibraryDestinationSelection[];
  opml: OpmlImportState;
  membershipByMediaId: ReadonlyMap<string, MembershipState>;
  mutation: SessionMutationState;
}>;
```

The unions are the state machines. Presentation is exhaustive and derived; there are no
parallel `phase/success/uploading/autoOpen` flags. Accepted media identity keys
membership state, so reuse and bulk work deduplicate naturally.

The session is dirty when URL input contains non-whitespace text, a selected/invalid OPML
file exists, or any non-settled row exists. Accepted rows alone are retained results, not
discard-risk intent. The hook owns the Running mutation's `AbortController`; the signal
is not presentation state.
`Loading.previous` restores a concurrent membership read when Stop invalidates its
generation. Membership Stop projects queued, started, and succeeded request-boundary
truth from the frozen `MembershipMutationProgress`; it never guesses from presentation.

### 4.3 Launcher and picker contracts

```ts
type OpenLauncherDetail =
  | { kind: "Root"; lane?: LauncherLane; query?: string }
  | { kind: "Add"; seed: AddSeed };

type LibraryDestinationPickerProps = {
  selected: readonly LibraryDestinationSelection[];
  onChange(next: readonly LibraryDestinationSelection[]): void;
  presentation:
    | { kind: "Inline" }
    | { kind: "DisclosureContent"; onRequestClose(): void };
  label: string;
  interaction:
    | { kind: "Enabled" }
    | { kind: "Disabled" }
    | { kind: "Creating" };
  onCreateDestination(name: string): Promise<LibraryDestinationSelection>;
};

type UploadIngestResult =
  | { kind: "Accepted"; result: SourceIngestResult }
  | {
      kind: "AcceptedUncertain";
      mediaId: string;
      sourceAttemptId: string;
      feedback: FeedbackContent;
    };
```

`uploadIngestFile` returns `UploadIngestResult`. A missing signed URL projects the
actual init attempt/processing status; it is never hard-coded to failed. After init
identity exists, an ambiguous PUT/confirm transport interruption returns AcceptedUncertain.
Explicit Abort propagates to the session stop path instead of becoming product failure.

Notes attachments and Connections are mandatory exhaustive consumers of this hard-cut
union. Notes freezes the insertion target, prevents edits while acceptance is active, and
creates the embed at the durable init-identity callback. Connections keeps its composer
mounted through disclosure collapse, retains pending identity, and starts the edge at the
same boundary; edge failure retries only the edge. Both surface warnings only after a
reference exists; neither treats accepted identity as an unattached failure or retries it
under a new key. No adapter or old top-level `SourceIngestResult` return survives.

The Connections composer owns pending accepted identity above a child defect projection.
Its local boundary logs the defect and requires explicit Continue, which remounts only that
projection; a joined ingest defect and edge rejection therefore retains the original
identity and exposes the same edge-only retry.

Delete the Add `LauncherLane` variant and old event shape. `dispatchOpenLauncher()`
defaults to `{kind: "Root"}`; that is the current typed contract, not an adapter. The
`"add"` result section remains. Legacy `?lane=add` is unknown input and never maps to
Add.

The picker owns selected destination objects, not an ID cache. Callers derive IDs at
their API boundary. Delete `destinationById`, `cachedLibraryDestinations`, the
`"Selected library"` fallback, and dead default-library filtering.

Destination creation is requested through the session callback. That callback acquires
the sole mutation gate and passes its signal to the library client; the picker neither
creates an independent abort lifecycle nor merely reports busy state after the fact.

### 4.4 Bounded execution contract

```ts
type TaskOutcome<T> =
  | { kind: "Fulfilled"; value: T }
  | { kind: "Rejected"; error: unknown };

function runBoundedTasks<TInput, TOutput>(input: {
  items: readonly TInput[];
  concurrency: number;
  run(item: TInput, index: number): Promise<TOutput>;
}): Promise<readonly TaskOutcome<TOutput>[]>;
```

- Reject non-positive/non-integer concurrency before starting work; empty input returns
  `[]`.
- Start in input order, never exceed the bound, preserve result order, collect every
  outcome, and join all work before resolving. Never fail fast or retry automatically.
- Callers exhaustively map decoded modeled failures; after joining all work, any
  unclassified error remains a defect rather than product feedback.
- Feature call sites pass `2`; the generic utility owns no domain constant.
- On whole-session abort, task callbacks observe the shared signal before side effects;
  started requests abort and queued callbacks perform no request.

## 5. API design

### Existing intake and filing

| Operation                 | Contract                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------- |
| URL acceptance            | `POST /api/media/from-url` + `Idempotency-Key` + `{url, library_ids}`               |
| File acceptance           | `POST /api/media/upload/init` + key; signed PUT; `POST /api/media/{id}/ingest`      |
| Destination search/create | `GET /api/libraries/writable-destinations`; `POST /api/libraries`                   |
| Membership read/add       | `GET/POST /api/media/{id}/libraries`; POST is additive/idempotent and returns `204` |
| OPML                      | `POST /api/podcasts/import/opml` with one default set and empty per-feed map        |

The upload idempotency key applies to init only. PUT and confirm have no independent
idempotency key. Clients must preserve init identity across uncertain confirmation. An
init replay may sign only the canonical staging path for that media/kind. Once confirm
has promoted the file to its media-owned final path, replay returns current durable
attempt/media truth with no upload URL; it never signs a PUT over the final object.

### New canonical membership removal

```text
DELETE /api/media/{mediaId}/libraries/{libraryId}
-> 204 No Content
```

FastAPI owns the same path without the `/api` BFF prefix.

Canonical membership POST and DELETE are command-shaped, bodyless `204 No Content`
responses. The shared API client validates exact status `204` (not `205`) before either
command converges. Authoritative state comes from `GET /media/{id}/libraries`; no
`library_ids_added` response schema or client inference survives.

`library_entries.ensure_media_absent_from_library_for_viewer`:

- supports every media kind. First authorize the target as a viewer-administered,
  non-default, non-system library without exposing media existence;
- if its target entry is absent, return `204` for every media ID, including unknown or
  otherwise inaccessible IDs. This is both the no-oracle and lost-response replay path;
- if present, that entry establishes restorable reachability. Acquire the media row when
  it exists, then lock/revalidate library authorization and recheck the entry; concurrent
  absence—including whole-resource deletion—is `204`. Preserve media→library order. For
  a still-present entry, missing media is a defect; check teardown, count lifetime
  references while holding the media lock, refuse the last one, delete exactly one entry,
  normalize positions, and return `204`;
- refuses the last lifetime reference with `409 E_MEDIA_LAST_REFERENCE`;
- never hides/deletes media or writes ingest state.

This cutover also closes the existing inverse lock order in whole-library teardown.
Every media-reference add/remove and every library deletion follows one global order:
media UUID ascending, then library UUID ascending. A library-delete attempt:

1. non-lockingly authorizes the library and snapshots its sorted distinct media IDs;
2. locks every snapshotted media row in UUID order;
3. locks and reauthorizes the library, then rereads its media IDs;
4. if the set changed, rolls back and restarts the whole bounded attempt—never acquiring a
   newly discovered media lock while holding the library lock; otherwise
5. deletes the entries/library and runs each zero-reference document cleanup while its
   media lock remains held. It returns storage paths from the successful attempt and
   performs object-store deletion only after commit.

The shared `nexus.db.retries` owner provides the bounded transaction-restart policy for
lock-set mismatch and retryable database transaction conflicts. Each attempt opens a
fresh transaction and reloads all state; retry exhaustion defects. No service-local retry
schedule or retryable database error crosses the API. `delete_document_media_if_unreferenced`
locks the media row at entry and holds it across reference count and delete; a caller that
also touches a library must already have acquired that media lock in global order. This
removes media→library/library→media deadlock for every kind and the two-library document
cleanup write-skew; it adds no table, queue, or public API. The new per-membership DELETE
refuses the last reference for every kind. Whole-library teardown retains the existing
lifecycle boundary: it cleans up zero-reference document media, while video and podcast-
episode physical lifecycle remains unchanged and outside this cutover.

Add-created media retain My Library, so last-reference refusal is not a normal Add
outcome. `DELETE /media/{id}` stays document resource deletion.

Convergent clients use one-object inputs:

```ts
ensureMediaInLibraries({ mediaId, libraryIds });
ensureMediaAbsentFromLibrary({ mediaId, libraryId });
```

Migrate singular frontend add callers, delete the client/BFF `addMediaToLibrary` path,
and route every filing removal through the new member endpoint. Hard-delete backend
`POST /libraries/{library_id}/media`, scoped `DELETE /media/{id}?library_id=...`,
`AddMediaRequest`, and `remove_document_from_library`; `DELETE /media/{id}` becomes
whole-resource-only. Its FastAPI route rejects any query string before mutation with
`400 E_INVALID_REQUEST`; undeclared parameters must never be ignored into destructive
fallback behavior. The BFF preserves that response. Rename the touched convergent backend
commands to `ensure_media_in_library` / `ensure_media_in_libraries_for_viewer`; agent
tooling migrates directly. No old-name adapter or batch/exact-set route is added.

## 6. Reuse and hard gates

Reuse existing URL/file validators and clients, feedback/ID/acceptance types, destination
search/create/paging, `LibraryMembershipPanel`, anchored/modal/overlay primitives,
confirmation Dialog, OPML backend, and `apiFetch` cancellation. Adapt one picker to
destination objects + controlled disclosure; generalize the URL worker pool into §4.4.

The hard-cut residue gate is:

- no Add lane/chip/sigil/menu/deep link, `AddSeed.mode`, `AddView`, tabs, or chooser; the
  legitimate `"add"` result section remains;
- no staging ingest, `autoOpen`, enqueue effect/scheduler, implicit submit, success close,
  or accepted filing through ingest/resource deletion;
- no destination cache/placeholder/duplicate fetch/open state or dead default filtering;
- no settled Accepted `File`, synthetic upload failure, competing mutation, child-owned
  create lifecycle, or closable create-busy disclosure;
- no production or superseded normative-doc legacy media-add/scoped-delete HTTP, schema,
  service, or client residue. Only this negative gate and one backend old-query fixture
  name the old HTTP shape to prove its absence and `400`/no mutation;
- no parallel OPML flags, per-feed editor, invented failed count, migration/table/batch
  API, adapter, fallback, or flag; and
- delete obsolete tests/comments/selectors/styles; rename the generic Launcher guard test.

## 7. Implementation files

This is the implemented footprint, not a prospective file plan.

### Added

- `apps/web/src/app/api/media/[id]/libraries/[libraryId]/route.ts`
- `apps/web/src/components/LibraryDestinationDisclosure.tsx`, its CSS module, and its
  browser test.
- `apps/web/src/components/launcher/{addContentSessionModel.ts,addContentSessionModel.test.ts,useAddContentSession.ts,useAddContentSession.test.tsx}`
- `apps/web/src/components/launcher/AddPanelBoundary.tsx`
- `apps/web/src/lib/async/{runBoundedTasks.ts,runBoundedTasks.test.ts}`;
  `apps/web/src/lib/launcher/architectureInvariants.test.ts`;
  `apps/web/src/lib/libraries/client.contract.test.ts`;
  `apps/web/src/lib/podcasts/{opmlImport.ts,opmlImport.test.ts}`; and
  `apps/web/src/lib/media/sourceUrlCapture.test.ts`.
- `python/tests/test_media_library_concurrency.py`
- This document.

### Modified

- Authenticated/share surfaces:
  `apps/web/src/app/(authenticated)/libraries/[id]/{LibraryPaneBody.tsx,LibraryPaneBody.ac4.test.tsx,LibraryPaneBody.readingSlate.test.tsx}`,
  `notes/[blockId]/NotePaneBody.tsx`,
  `pages/[pageId]/{PagePaneBody.tsx,PagePaneBody.test.tsx}`,
  `podcasts/PodcastsPaneBody.tsx`,
  `podcasts/[podcastId]/PodcastDetailPaneBody.tsx`, and
  `apps/web/src/app/share/{ShareCapture.tsx,ShareCapture.test.tsx}`.
- Shared components:
  `LibraryDestinationPicker.tsx`, `LibraryDestinationPicker.test.tsx`,
  `LibraryMembershipPanel.tsx`, `LibraryMembershipPanel.module.css`,
  `LibraryMembershipPanel.test.tsx`, `OpmlImportPanel.tsx`,
  `OpmlImportPanel.module.css`, `appnav/{AppNav.tsx,AppNav.test.tsx}`,
  `connections/{ConnectionsSurface.tsx,ConnectionsSurface.module.css,ConnectionsSurface.test.tsx}`,
  `notes/{HighlightNoteEditor.tsx,ProseMirrorOutlineEditor.tsx,ProseMirrorOutlineEditor.test.tsx}`,
  and launcher
  `{AddPanel.tsx,AddPanel.module.css,AddPanel.test.tsx,CreatePanel.tsx,Launcher.tsx,Launcher.test.tsx,LauncherInput.tsx,LauncherSheet.tsx,LauncherSurface.tsx,launcher.module.css,useLauncherController.ts}`.
- Frontend contracts:
  `apps/web/src/lib/api/{client.ts,client.test.ts}`,
  `apps/web/src/lib/launcher/{launcherEvents.ts,model.ts,parseLauncherInput.test.ts,providers.ts,providers.test.ts,ranking.ts,ranking.test.ts}`,
  `apps/web/src/lib/libraries/client.ts`, and
  `apps/web/src/lib/media/{ingestionClient.ts,ingestionClient.test.ts,mediaLibraries.ts,mediaLibraries.test.ts,sourceUrlCapture.ts,useLibraryMembership.ts}`.
- Backend owners:
  `python/nexus/api/routes/{libraries.py,media.py}`,
  `db/{errors.py,retries.py,session.py}`, `errors.py`,
  `schemas/{library.py,media.py}`, and
  `services/{library_entries.py,library_governance.py,media_deletion.py,media_source_ingest.py,oracle_corpus.py,web_article_ingest.py,agent_tools/writes.py}`.
- Backend tests:
  `python/tests/{factories.py,test_author_deduplication_cutover.py,test_consumption_projection.py,test_cutover_negative_gates.py,test_db_retries.py,test_highlights.py,test_libraries.py,test_library_target_picker.py,test_listening_heartbeat.py,test_media_deletion.py,test_media_libraries_endpoint.py,test_pdf_highlights_integration.py,test_podcasts.py,test_reader_apparatus_service.py,test_reader_integration.py,test_search.py,test_upload.py,test_web_article_highlight_e2e.py}`
  and `python/tests/{test_media_related.py,real_media/test_reingest_delete_permissions.py}`.
- E2E:
  `e2e/tests/{add-content.ts,epub.spec.ts,launcher.spec.ts,pdf-reader.spec.ts,resonance-reading-slate.spec.ts,web-articles.spec.ts}`
  and `e2e/tests/real-media/real-media-seed.ts`.
- Docs: `docs/architecture.md`, `docs/dreams.md`,
  `docs/cutovers/{android-share-library-destinations-hard-cutover.md,browse-surface-deletion-hard-cutover.md,durable-source-ingest-hard-cutover.md,lectern-player-lifecycle-hard-cutover.md,library-reading-time-hard-cutover.md,universal-launcher-hard-cutover.md}`,
  and `docs/modules/{app-navigation.md,library.md,overlays.md,podcast.md,storage.md}`.

### Deleted

- `apps/web/src/app/api/libraries/[id]/media/route.ts`
- `apps/web/src/app/api/media/[id]/libraries/route.test.ts`
- `apps/web/src/lib/libraries/client.test.ts`
- `apps/web/src/lib/launcher/launcherCutover.guards.test.ts` (replaced by the current
  architecture invariant test).

### Database/migration

- None.

## 8. Acceptance criteria

1. `+` opens source-first Add directly on mobile/desktop; no lane, resting chooser, query
   sigil, tabs, library-first layout, cache placeholder, or legacy deep link survives.
2. Review/selection is local and atomic at 20 rows. Raw URL/file intent survives viewport
   changes; one mixed queue exposes exactly the controls relevant to Draft and settled
   Accepted rows.
3. Submit freezes each source/destination/key, runs at concurrency `2`, distinguishes
   Rejected from ambiguous acceptance, retains partial outcomes, and never auto-navigates.
4. Settled Accepted rows support Open plus authoritative row/bulk filing; uncertain files
   retain identity and same-key reconciliation without filing. Notes and Connections
   exhaustively consume the same upload union without duplicating accepted media.
5. Canonical removal covers every media kind; authorized absent/unknown targets return
   replay-stable `204`; present removal returns `409 E_MEDIA_LAST_REFERENCE` rather than
   orphaning and never hides/deletes media. All reference mutations and library teardown
   linearize media→library without deadlock; library teardown never leaves a live
   zero-reference document media row. Whole-resource DELETE rejects every query string
   with `400` before mutation; legacy paths have no production or superseded normative-doc
   residue.
6. OPML validates local file shape/size and reports server counters, residual, and Issues
   exactly; no per-feed UI or invented failed count exists.
7. One lifted session, focus owner, accessible dialog name, controlled disclosure, polite
   status region, nested Escape order, and deterministic focus recovery survive viewport
   changes.
8. Every close/navigation path uses one dirty/busy dismissal gateway. One mutation gate
   disables competing commands; Stop aborts its signal and truthfully preserves committed
   effects.
9. No database artifact, server batch/exact-set API, compatibility path, fallback, feature
   flag, or forbidden residue is added.

## 9. Focused verification

Completed on 2026-07-21 with exact changed-contract selections only:

- The 12-file changed-contract unit selection covering the API client, bounded execution,
  launcher parsing/providers/ranking/invariants, destination decoding, ingestion,
  membership, URL capture, OPML, and the Add session model passed **174/174**. After adding
  the final signed-PUT HTTP-classification regression, the exact affected ingestion file
  passed **17/17**.
- The 11-file directly affected browser selection passed **147/147**. After adding the
  final joined-failure lifecycle regression, the exact affected Connections file passed
  **14/14**. Coverage includes viewport continuity, Stop/abort/stale-completion behavior,
  destination defects, durable upload identity, OPML/membership restoration, Notes and
  Connections insertion/retry, Share partial outcomes, and malformed-response defect
  restoration. Targeted ESLint passed for every changed frontend TypeScript file and the
  final modified subsets.
- Backend: **36** focused upload/membership/real-Postgres-concurrency/negative-gate tests
  passed, plus **5** directly affected integration tests. Targeted Ruff passed for the 12
  changed backend modules. The real-media case was deselected by its normal marker; it was
  not reported as executed.
- After merging current `main`, exact integration selections passed: launcher architecture
  invariants **16/16**; Notes **19/19**; Connections **17/17**; Reading Slate **5/5**;
  Library AC4/default **13/13**; and Page **19/19**. The correctly migrated backend
  selection initially passed **41/42**; after replacing one stale deleted-provider guard,
  its exact affected file passed **3/3**, leaving every selected backend case passing.
  Targeted ESLint and Ruff passed for all conflict-resolved and integration-adjusted files.
  The production-start gate exposed and closed three strict typing gaps; the exact Share
  browser owner passed **16/16**, API/ingest/capture/session-model owners **57/57**, and the
  session controller owner **13/13**.
- Real-stack Playwright, isolated services: auth setup plus only
  `web articles › accepted rows support convergent row and bulk filing` — **2 passed**;
  the named case completed in 2.8 s. It proves retained partial outcomes and authoritative
  row/bulk add/remove across the Next/FastAPI boundary.
- Real-stack Playwright after merging `main`, isolated services: auth setup plus only
  `Reading Slate acceptance preserves survivors, excludes the accepted target, and
  reconciles on library reactivation` — **2 passed**; the named case completed in 6.5 s.
  It proves explicit post-upload Open, canonical Link creation/deletion, canonical
  membership acceptance, bounded Slate refill, and reactivation reconciliation.
- Targeted static residue checks and document-scoped `git diff --check` passed.

No broad Makefile verification, CI, or full verification target was run for this cutover.
