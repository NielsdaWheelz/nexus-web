# Reader Progress Continuity Hard Cutover

**Status:** Current contract

**Posture:** One coordinated hard cutover. No legacy payloads, fallback readers,
dual writes, public null-reset path, feature flag, or mixed-version support.

**Progress-reset supersession (2026-07-24):**
[`media-progress-reset-hard-cutover.md`](media-progress-reset-hard-cutover.md)
supersedes this document's cursor persistence owner, non-null locator row,
Empty-revision-zero-only assumption, separate cursor/engagement transactions,
media-teardown cursor DML, and matching file/acceptance clauses. The reader
coordinator, strict locator union, CAS, revalidation, and URL-precedence rules
remain canonical.

**Superseded by default-library-virtualization-and-transient-state-pruning-hard-cutover.md
(2026-07-17):** the `{cursor?: {locator, base_revision}, attention?}` PUT
envelope this spec introduced, its `204` attention-only response path, and its
"document engagement recency reads `reading_sessions`" claim (§"In scope" and
§5) are all gone. `PUT /media/{id}/reader-state` now takes the bare
`CursorWrite` body with no sibling block; there is no longer any request
shape that writes engagement without writing the cursor alongside it. Cursor
success — including the idempotent equal-locator case — writes the narrow
current-state `reader_engagement_states` row in the same Consumption
transaction (`services/consumption/_reader_engagement_store.py`), which is now the
recency source for document engagement everywhere `reading_sessions` used to
serve that role. This spec's cursor CAS semantics, `useReaderProgress`
client coordinator, revalidation triggers, and URL-precedence rules are
otherwise unchanged and remain canonical.

**Canonical-position completion (2026-07-31):**
[`reader-document-map-canonical-position-hard-cutover.md`](reader-document-map-canonical-position-hard-cutover.md)
supersedes this document's coarse format-capture descriptions. The persistence
schema, CAS, coordinator, and URL authority remain here. The active reader now
publishes one exact source/layout-fenced semantic viewport: text is
`(fragment_id, canonical codepoint offset)` and PDF is `(page, normalized
full-page fraction)`. That capture is shared by progress, activity, and the
Document Map rail; pixels are not a persisted coordinate or fallback.

## 1. Executive decision

There are no blocking product questions.

The lean solution is five things:

1. one canonical cursor row per user and media item;
2. one monotonically increasing server revision on that row;
3. one small client coordinator that serializes and coalesces writes;
4. event-driven revalidation when a mounted reader returns or reconnects;
5. one clear URL rule: bare routes resume canonical state; URL targets are
   navigation intent, not progress storage.

This fixes the observed reload, stale-write, and phone-to-laptop behavior without
adding realtime sync, a local cursor database, per-device rows, an event log, or a
generic synchronization framework.

## 2. Target behavior

| Situation | Final behavior |
|---|---|
| Open bare `/media/:id` | Load and apply the user's canonical cursor internally; for web, select its saved fragment before exact restore; keep the URL bare |
| Reload after ordinary reading | Restore the latest cursor that reached the server, including the synchronous lifecycle capture path |
| Phone saved newer progress; laptop pane is dormant and clean | Revalidate on return/reconnect and apply the newer cursor without remount |
| Phone saved newer progress; laptop is active or locally dirty | Do not teleport; show `Go to most recent position` / `Stay at this position` |
| Delayed stale tab tries to save | Server returns `409` with the current cursor; no silent overwrite |
| Fresh feature hash/evidence target | Navigate there once without automatically making it durable progress |
| Cold coarse `?loc`/`?fragment` plus an existing cursor | Canonical cursor wins; remove only the stale reader query fields with pane-local replace |
| Pane Back/Forward | Workspace traversal renders the stored destination; a fresh media mount applies normal cursor precedence and does not persist merely because history moved it |
| Initial cursor GET fails | Show Retry; do not treat failure as empty or write a default position |
| Media has no readable surface | Make no reader-progress request and do not gate the normal media pane |

The product deliberately does not infer “newer” from numerical progression.
Rereading an earlier chapter can be the newest valid cursor.

## 3. Goals, scope, and non-goals

### Goals

- reliable ordinary resume for web articles, transcripts, EPUB, and PDF;
- stale-write safety across tabs and devices;
- clean cross-device adoption with a non-disorienting active-reader handoff;
- one owner each for cursor authority, client write ordering, URL intent, and
  physical locator application;
- explicit failures and focused real-stack proof;
- minimal machinery appropriate to a one-user prototype.

### In scope

- versioned `reader_media_state` and strict GET/PUT contracts;
- single-flight, latest-only cursor persistence with idle and maximum-wait saves;
- synchronous lifecycle capture and best-effort keepalive;
- focus, visibility, `pageshow`, `online`, and pane-activation revalidation;
- later cursor application without remounting the reader or PDF;
- bare/hash/cold-query/live-history precedence;
- a small reader-local handoff and sync-error treatment;
- attention-only isolation: an attention write cannot replace or revise a cursor;
- document engagement recency reading `reading_sessions`, because attention-only
  writes will no longer incidentally touch the cursor row;
- deletion of the old hook, parser forms, clear semantics, frozen initial state,
  duplicated reader URL builders, stale tests, and stale docs.

### Non-goals

- polling, SSE, WebSocket, BroadcastChannel, or push notifications;
- IndexedDB/localStorage cursor outbox, service worker, Background Sync, or a
  same-tab revision fence;
- guaranteed delivery after browser/OS force-kill or offline destruction;
- per-device cursors, cursor history, CRDTs, “furthest wins,” or timestamp merge;
- exact-location sharing redesign;
- same-resource pane deduplication;
- source-reingestion repair;
- attention-ledger redesign, active-pane dwell changes, device-identity cleanup,
  listening-state changes, or audio/podcast recency changes;
- generic autosave/sync abstractions.

## 4. Final architecture and ownership

```text
genuine reader movement
  -> format-owned exact semantic viewport capture
  -> useReaderProgress (single-flight, latest-only, revision-aware)
  -> existing reader-state BFF
  -> services/consumption/_reader_cursor_store.py conditional mutation
  -> reader engagement in the same Consumption transaction
  -> reader_media_state (one user/media row)

return / reconnect / pane activation
  -> no-store reader-state GET
  -> clean dormant auto-apply OR active/dirty handoff
  -> format-owned addressable application
  -> programmatic movement produces no save echo
```

| Concern | Owner | Contract |
|---|---|---|
| Locator schema | existing reader types/schemas | Strict media-kind-discriminated `ReaderResumeState` |
| Canonical cursor and revision | `reader_media_state` + Consumption `_reader_cursor_store.py` | Read snapshot; conditionally replace or reset |
| Browser ordering/revalidation | `useReaderProgress` | One in-flight PUT per mounted coordinator; one queued latest locator |
| Pure decisions/decoding | `readerProgress.ts` | Strict wire parsing, equality, conflict and adoption decisions |
| Capture/application | format readers + `MediaPaneBody` | One source/layout-fenced semantic viewport; addressable apply with completion |
| Pane activity | `WorkspaceHost` -> pane runtime | Required `isActive` capability for adoption versus handoff |
| URL intent | pane router, `useReaderTarget`, `readerLocationHref.ts` | Hash/cold/live provenance; no cursor authority |

`MediaPaneBody` supplies a tagged readable capability only after media resolution:

```text
ReaderCapability =
  | { state: "Unavailable" }
  | { state: "Readable", mediaId, locatorKind }
```

`Unavailable` performs no progress I/O. The coordinator is reader-specific; do
not generalize it with note autosave.

## 5. Data and API contract

### Final row

```text
reader_media_state
  id          uuid primary key
  user_id     uuid not null references users(id)
  media_id    uuid not null references media(id)
  locator     jsonb null
  revision    bigint not null default 1
  created_at  timestamptz not null
  updated_at  timestamptz not null

  unique (user_id, media_id)
  index (media_id)                 -- existing deletion/support index
```

There is no device ID, client timestamp, URL, history, or presentation state in
this row. `updated_at` is metadata, not a conflict token. A null locator is an
internal revisioned `Empty` reset tombstone, never a public null-clear payload.
Migration 0195 makes the column nullable without backfill or a new index; the
earlier non-null migration remains historical provenance.

Locator validity and positive persisted revision are enforced by
schemas/services and defect on invalid trusted rows, per `docs/rules/database.md`.
Empty revision `0` means no row; every persisted Positioned or Empty row has a
positive revision.

### GET

`GET /media/{media_id}/reader-state` returns exactly:

```text
ReaderCursorSnapshot =
  | { state: "Empty", revision: integer >= 0 }
  | { state: "Positioned", revision: integer >= 1, locator: ReaderResumeState }
```

No raw `null`. A visible future media kind without a reader capability returns
`400 E_INVALID_REQUEST`; this is a forward-defensive contract because every
current `MediaKind` is classified, so tests do not invent an unreachable present
kind. Missing/inaccessible media returns masked `404 E_MEDIA_NOT_FOUND`.

### PUT

The one strict browser/server body is:

```text
CursorWrite = { locator: ReaderResumeState, base_revision: integer >= 0 }
```

Extra fields, wrapped/old bare locators, top-level null, missing base revision,
and public clear are rejected with `400`.

Quote context is bounded consistently in backend schemas and the frontend strict
decoder: `quote` is at most 256 Unicode code points; `quote_prefix` and
`quote_suffix` are at most 128 each. Existing capture uses substantially smaller
windows. Oversized values are rejected, not truncated at the persistence boundary.

Responses:

- cursor accepted or already equal: `200` with the resulting snapshot;
- stale different cursor: `409 E_READER_STATE_CONFLICT` with
  `error.details.current` containing the exact current snapshot;
- unsupported kind or locator mismatch: `400`;
- missing/inaccessible media: masked `404`.

All reader-state responses are `Cache-Control: private, no-store`. This is new,
explicit plumbing: an exact-path FastAPI middleware in `app.py` adds the header
after every `/media/{id}/reader-state` response, including exception-handler and
validation output, and the Next reader-state BFF applies the same header to both
proxied and locally generated responses. No claim depends on a nonexistent global
error-header facility.

### Mutation semantics

| Current | Request | Result |
|---|---|---|
| Empty `0` | base `0`, locator A | create A at revision `1` |
| Empty `N` tombstone | base `N`, locator A | replace with A at `N+1` |
| Positioned `N`, A | base `N`, locator B | replace with B at `N+1` |
| Positioned `N`, A | any base, locator A | idempotent success at `N` |
| Positioned `N`, A | stale base, locator B | `409` with current snapshot |

Consumption's `_reader_cursor_store.py` is the sole cursor writer. The public
service uses the repository serializable retry primitive and existing viewer
serialization lock. Cursor CAS, reader engagement, and any completion
transition commit in one transaction. `ResetProgress` uses the same owner to
write a higher-revision Empty tombstone and clear engagement atomically.
Normalize only the named user/media uniqueness race from concurrent first
inserts into a fresh idempotent success or conflict; every other integrity
error is a defect.

Removing the media-row `FOR UPDATE` exposes one additional expected race: media
deletion can win immediately before a first cursor INSERT. Normalize only the
live, discovered reader-state `media_id` FK violation by rolling back and doing a
fresh authorized media read; absence returns masked `404 E_MEDIA_NOT_FOUND`, while
a still-visible media row makes the violation a defect. Do not turn unrelated FK
violations into 404s. Runtime matching uses the explicit final constraint name,
not an assumed legacy/generated name.

Document `last_engaged_at` reads `reader_engagement_states`, never
`reader_media_state.updated_at`. Podcast recency remains heartbeat-owned.

Never log locator JSON, quote context, URL targets, or validation `input` values.
The existing validation/error owner must redact them on both untrusted-request
and invalid-stored-row paths.

## 6. Frontend behavior

Delete `useReaderResumeState` and replace it with `useReaderProgress`.

The coordinator has three orthogonal facts:

```text
authority: Loading | Ready(snapshot) | LoadFailed(error)
local:     Clean | Dirty(locator) | Saving(sent, queuedLatest?) | SaveFailed(locator)
remote:    None | Candidate(snapshot)
```

Rules:

- Loading/LoadFailed cannot save; Retry must first establish authority.
- Genuine user movement replaces the pending locator.
- Save after `500 ms` idle, with a `5 s` maximum wait during continuous movement.
- Only one PUT is in flight per coordinator. A/B/C while A is saving becomes A
  then C; C uses A's acknowledged revision.
- If A returns `409` while C is queued, discard superseded A, retain C as the
  latest local desired locator, retain the conflict snapshot as the remote
  candidate, and show the handoff. Do not send C automatically because no
  acknowledged base exists; either user action resolves it against the conflict
  revision.
- Network ambiguity retains the latest locator. Recovery revalidates before
  retrying because the failed request may have committed.
- A malformed same-system response is a contract error, not Empty.
- Late responses are ignored by media ID, request ID, and generation.
- Duplicate panes keep independent coordinators; backend CAS preserves safety.

`generation` is a monotonic number owned by the mounted progress coordinator. It
increments before a readable media ID or locator-kind change, before transition
to Unavailable, and before teardown invalidates pending work. Every load, save,
revalidation, and apply command captures it; a completion whose generation no
longer equals the current one is ignored.

### Capture and lifecycle

The format boundary is:

```text
captureCurrentLocator() -> Captured(locator) | Unavailable
applyCursor({ requestId, generation, source, locator })
  -> Applied | CancelledByUser | Failed
```

Routine capture may be animation-frame throttled. The active format publishes
both exact visible endpoints: text over ordered unique canonical fragments and
PDF in normalized full-page space. The persistence locator remains the existing
`ReaderResumeState`; projection owns no second cursor schema. On hidden,
`pagehide`, pane deactivation, and reader teardown, synchronously attempt
capture before a best-effort keepalive flush. Lifecycle is not user intent:
only a position already made dirty by genuine reader input may be promoted.

Initial and remote application use the same format restore path. Programmatic
application suppresses save echo, but genuine wheel/touch/key/scrollbar input
cancels a delayed restore and prevents snap-back. PDF receives later addressable
requests; delete its current page-derived remount key.

`Restore`, Find `Preview`, and Find `Return` may publish the visible band but
cannot write cursor progress or Consumption activity. An unavailable exact
capture remains absent; it never becomes a zero, midpoint, or scrollbar value.

The force-kill/in-flight tail is accepted: if a lifecycle request cannot be sent,
or a newer locator is queued behind an older request when the page dies, the last
movement can be lost. A browser outbox/fence is the explicit next 20%, not hidden
inside this cutover.

### Revalidation and handoff

Coalesce one GET per coordinator on pane activation, visible, focus, `pageshow`,
and `online`. There is no timer.

Each GET captures media generation, whether it started dormant, and the local
input sequence; automatic adoption is allowed only if all three are unchanged
when the response arrives.

- Greater revision + reader started dormant, remains clean, and had no new input:
  apply automatically and politely announce “Resumed from your most recent
  position.”
- Greater revision + reader active, dirty, saving, or failed: keep the viewport
  fixed and retain a remote candidate.
- Equal locator: reconcile without a prompt.
- Background revalidation failure preserves the current Ready reader and pending
  work; it does not become Empty.

Handoff copy:

> More recent reading position available
>
> Go to most recent position · Stay at this position

It is reader-local, non-modal, token-based, keyboard operable, and politely
announced. Put announcement text in the live region and buttons outside it.
`Go to most recent position` accepts/applies remote state without write echo.
`Stay at this position` captures the current locator and writes it against the
remote revision, intentionally making this viewport canonical for the user and
therefore overwriting the other device's cursor. If that write conflicts again,
replace the candidate with the returned snapshot and present the handoff again.
If capture is unavailable, retain the candidate and show Retry. After either
button disappears, focus moves to the stable reader viewport; automatic adoption
never steals focus.

Failed physical application retains its target and shows Retry; genuine-input
cancellation keeps the user-controlled viewport and cannot snap back later.

Routine successful saves are silent. The first unresolved cursor save failure
shows `Progress not synced · Retry` without blocking reading.

## 7. URL and history contract

The stable entry is `/media/:id`; it never redirects to progress parameters.

Cold mount precedence:

1. fresh feature-owned hash/evidence/highlight/apparatus target;
2. Positioned canonical cursor (select the saved web `target.fragment_id`
   before exact restore);
3. coarse cold `?loc`/`?fragment` only when the cursor is Empty;
4. default readable source.

After mount, fresh feature targets navigate the reader but do not become
durable progress until later genuine reading input. Direct reader
TOC/next/previous commands count as genuine input after resolution. Pane
Back/Forward is workspace traversal, not reader-local navigation; a fresh
media mount it produces applies the cold-mount precedence above.

When canonical state supersedes a cold coarse query, pane-local replace removes
only `loc` and `fragment`; preserve `apparatus`, unrelated query state, and hash.
Ordinary scrolling never writes the URL. The generic copied pane URL is an entry
link, not an exact progress permalink. Reader Copy pane link uses the same repair
helper: strip only coarse `loc`/`fragment`, while preserving feature-owned
`apparatus`, unrelated query intent, and hash. A fully bare copy would silently
discard explicit feature intent; exact progress sharing remains a non-goal.

Centralize reader href/repair construction in `readerLocationHref.ts`; keep EPUB
relative-document resolution format-local.

## 8. Hard-cutover cleanup and file plan

Delete completely:

- bare/null/flat reader PUT parsing and public clear/delete SQL;
- `ReaderStateWithAttention` and `parse_reader_state_with_attention`;
- `useReaderResumeState.ts` and its tests/compatibility export;
- frozen `initialReaderResumeState` and page-derived PDF remounting;
- rail-only scrollbar capture, `documentSpan`, and duplicate first-visible
  position scans;
- attention-only locator substitution;
- duplicated media-reader query/hash builders;
- tests and docs that say GET/PUT is `ReaderResumeState | null` or that cold
  `?loc` beats saved progress.

Create:

- `migrations/alembic/versions/NNNN_reader_progress_continuity.py`;
- `apps/web/src/lib/reader/readerProgress.ts` and tests;
- `apps/web/src/lib/reader/useReaderProgress.ts`;
- `apps/web/src/lib/reader/readerLocationHref.ts` and tests;
- `ReaderProgressHandoff.tsx` beside `MediaPaneBody`, styled with the existing
  media `page.module.css`;
- `e2e/tests/reader-progress-continuity.spec.ts`.

Modify only the owning seams:

- backend: `db/models.py`, `schemas/reader.py`,
  `services/consumption/{service,_reader_cursor_store,_reader_engagement_store}.py`, reader
  route, exact-path no-store middleware and validation redaction in `app.py`,
  document recency reads in `services/media.py`, and the one direct-document term in
  `services/library_entries.py`;
- frontend: API error details, pane runtime/`WorkspaceHost` activity capability,
  no-store wrapping in
  `apps/web/src/app/api/media/[id]/reader-state/route.ts`, `PaneShell` copy-target
  composition, `MediaPaneBody`, `epubRestore.ts`, `epubHelpers.ts`,
  `PdfReader.tsx`;
- tests: reader/migration/media/library integration, pure coordinator/URL logic,
  browser interaction/application UI, and existing reader/EPUB/PDF/Document Map
  E2E fixtures that currently clear with JSON null or PUT a bare locator (including
  `pdf-reader.spec.ts` and `epub.spec.ts`);
- docs: reader implementation/rationale, workspace history, architecture, and
  the attention spec's now-stale cursor-touch claim.

Do not rewrite `MediaPaneBody` broadly. Extract only these owner seams. Do not
touch listening/device identity, active-pane attention tracking, or audio recency.

## 9. Acceptance criteria

1. GET returns exact Empty/Positioned tagged snapshots and never raw null; every
   reader-state success and error path carries private/no-store through the named
   FastAPI and BFF mechanisms.
2. Current-base writes increment once; equal desired-state retries do not.
3. Stale different writes return `409` with current state and mutate nothing.
4. Concurrent first inserts and updates yield one accepted result and one
   conflict/idempotent acknowledgement, never a uniqueness 500 or silent loss;
   delete racing first save normalizes the exact media FK violation to masked 404.
5. Old payloads, null clear, extra fields, locator kind mismatch, and oversized
   quote context fail strictly; inaccessible media remains masked 404. The
   unsupported-present-kind branch remains forward-defensive rather than an
   invented current fixture.
6. Cursor CAS, reader engagement, and any completion-transition fact commit
   together. Reset writes a higher-revision Empty tombstone and clears current
   engagement in that same owner transaction.
7. A/B/C client observations serialize as A then C with the acknowledged base;
   if A conflicts, queued C remains local and waits for the handoff choice.
8. Load and ambiguous save failures retain truth and recover without requiring a
   new scroll; save recovery GETs before retry.
9. Lifecycle capture uses the newest synchronously available user-dirty locator,
   not a stale animation-frame snapshot.
10. Initial/remote/hash/history application produces no cursor write echo;
    genuine input cancels delayed EPUB restore.
10a. One exact semantic viewport drives progress, activity, and the rail;
    Preview, Return, and restore produce no progress/activity write.
11. Bare web, transcript, EPUB, and PDF routes apply canonical state internally
    without flashing default content or changing the URL.
12. Clean dormant re-entry auto-applies a greater revision without stealing
    focus; active/dirty re-entry shows the accessible handoff.
13. `Stay at this position` explicitly makes the local viewport canonical using
    the remote revision; a second conflict replaces the candidate and presents
    the handoff again.
14. Cold stale reader query loses to saved state and repair preserves unrelated
    target fields; pane Back/Forward is workspace traversal, not reader-local
    navigation.
15. Non-readable media produces no progress request or reader loading state.
16. PDF later application changes page/progression/zoom without remount.
16a. Web saved-fragment resume opens that fragment before exact restore; EPUB
    repeated navigation targets do not duplicate fragment length.
17. Document engagement recency comes only from
    `reader_engagement_states`; podcast recency remains heartbeat-owned.
18. No locator/quote content appears in URL, browser storage, or logs.
19. No polling, realtime transport, local cursor outbox, per-device model, or
    generic sync abstraction is added.
20. All deleted contracts are absent from source, tests, and docs.

## 10. Test and implementation plan

Test at the owning layer:

- backend integration: exact shapes, CAS/idempotence/conflict, real concurrent
  first insert/update and delete-vs-first-save, combined partial success,
  attention isolation, quote bounds, authorization, no-store, redaction;
- pure frontend: decoder, A/B/C reducer, failure retention, arbitration, stale
  generations, URL precedence/repair;
- Chromium component: handoff/focus/live-region behavior, genuine versus
  programmatic input, PDF addressable application;
- real-stack E2E: reload resume for each format, cold query versus cursor,
  reader-location churn staying out of pane history, non-readable gating, and
  two contexts (mobile phone + desktop laptop) for auto-adopt and handoff.

Do not prove transport with internal mocks. Remove/migrate the touched
`MediaPaneBody` tests that mock reader/API/router owners rather than renaming the
mock. Seed/reset E2E state through isolated fixtures or GET-current-revision plus
a conditional enveloped write; no private clear seam. Replace both JSON-null
clears and bare-locator PUT helpers, including the EPUB and PDF helpers named
above.

Implementation order:

1. red migration/API/CAS tests;
2. schema, service, migration, strict endpoint, and deletion of old parser/clear;
3. pure coordinator plus pane activity capability;
4. format application, lifecycle capture, URL rules, and handoff UI;
5. document recency correction, fixture migration, stale-code/doc deletion;
6. wire the focused Playwright continuity spec with two authenticated contexts—
   one mobile viewport and one desktop viewport—then run `make check`, backend
   integration, frontend unit/browser, focused real-stack E2E, migration tests,
   and `git diff --check`.

The cutover ships backend/migration and matching web bundle together; the sole
user reloads open clients. Old clients are intentionally rejected rather than
supported through a compatibility lane.

## 11. Key decisions and honest residuals

- Revision is authority; progression and client clocks are not.
- Bare route resumes internally; progress is not projected into URL state.
- Event-driven revalidation is enough for one user; continuously focused devices
  will not update until an event or conflicting write.
- Clean dormant auto-adoption is convenient; active-reader teleportation is not.
- Same-resource panes remain independent; alternating activity or local edits in
  two views can produce dueling handoffs. That UX is accepted for the one-user
  prototype; server CAS remains the safety boundary and prevents data loss.
- Keepalive is best effort. An immediate force-kill, offline close, or a newest
  locator queued behind an in-flight write can still lose the last movement.
- The next durability increment is a small same-tab fence or durable browser
  outbox. It is intentionally not part of this 80/20 feature.
