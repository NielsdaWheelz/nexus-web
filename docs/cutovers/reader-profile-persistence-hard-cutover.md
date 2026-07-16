# Reader Profile Persistence Hard Cutover

**Status:** Proposed implementation specification · 2026-07-16

**Posture:** One coordinated cutover. No legacy save path, frontend default,
compatibility branch, fallback, feature flag, or browser-side authority.

## 1. Decision

There are no blocking questions. Keep Reader Light/Dark account-global and
independent of app Study/Press/System. Make the server profile required for the
interactive shell; give all client writes one ordered coordinator; complete the
theme boundary for web, EPUB, and transcript reading surfaces.

The 80/20 boundary excludes durable offline delivery, revision conflicts, and
realtime synchronization.

## 2. Target behavior

| Situation | Final behavior |
|---|---|
| Initial authenticated load | Stream the existing skeleton; reveal the interactive shell only after a canonical profile is decoded. |
| Profile read exceeds old 500 ms seed budget | Continue awaiting the required read under the existing 30 s server-request deadline. |
| Profile load fails | Replace the skeleton with an accessible error and Retry. Never fabricate Light. |
| Discrete setting changes | Update pixels now; send now when idle or enqueue behind the one in-flight PATCH. |
| Range input changes | Update pixels now; when writer is idle, flush after 400 ms idle and within 5 s maximum. |
| A changes, then B while A saves | Render B continuously; acknowledge A, then send the latest merged B patch. |
| Save fails | Keep desired pixels; show one keyed error presentation—Settings inline while active, otherwise global. Retryable failures keep controls enabled and offer Retry; Forbidden disables profile controls. |
| Reload after a theme choice | The keepalive PATCH has already started; no test-side wait is required. |
| Clean tab resumes | Re-fetch and adopt server state only if no intervening local intent exists. |
| Multiple tabs/devices | Distinct-field partial writes compose; same-field writes are serialization-order last-write-wins. Tabs do not update live; a clean resume converges to server truth. |
| Stale in-flight save | A 35 s wall-clock watchdog converts a wedged logical attempt into retryable failure; the watchdog itself starts no replacement. |
| Reader surface | Theme the full web/EPUB/transcript reading canvas; leave PDF, player, workspace, and app chrome unchanged. PDF UI says that source colors are preserved. |

## 3. Goals and scope

### Goals

- one authoritative profile read and one serialized write owner;
- immediate optimistic UX without false save acknowledgement;
- best-effort lifecycle durability and clean-tab convergence;
- one theme derivation boundary; no silent defaults, no-ops, or duplicate style
  logic.

### In scope

- all seven profile fields and the exact GET/PATCH DTO;
- required bootstrap profile, owned bootstrap error/Retry UI, and no-store policy;
- single-flight/latest-merged writes, retry, lifecycle flush, and clean resume;
- transcript theme completion and save-state UX;
- serializable backend mutation, first-insert race handling, and correction of
  the misnamed `updated_at` storage field;
- focused pure, component, service-integration, real-stack E2E, and source-gate
  coverage; contradicted code/docs/tests are deleted in the same cutover.

### Non-goals

- app appearance/`nx-theme`, PDF appearance, or new theme values (`system`,
  `follow app`, per-device, per-media);
- localStorage/IndexedDB, service worker, Background Sync, durable outbox, or
  force-kill guarantee;
- revision/ETag/CAS, conflict UI, history, clocks, CRDT, BroadcastChannel,
  polling, SSE, WebSocket, or push;
- a generic autosave/lifecycle/synchronization framework or redesign of reader
  progress, workspace, notes, or player persistence;
- cleanup of the pre-existing `reader_profiles` non-opaque primary key, CHECK
  constraints, or cascade. Those storage-policy issues require a separate
  migration scope.

## 4. Final architecture

```text
authenticated layout
  -> AuthenticatedWorkspaceErrorBoundary (client, authenticated-only)
     -> Suspense(existing shell skeleton)
        -> WorkspaceBootstrapGate
           -> required no-store GET /me/reader-profile + strict decode
           -> workspace sizing/restore + ReaderProvider seed

semantic reader intent
  -> ReaderProvider
  -> readerProfileSync reducer (acknowledged + desired + pending)
  -> useReaderProfile (one PATCH in flight + one latest-merged queue)
  -> Next BFF -> FastAPI reader service
  -> retry_serializable(SELECT -> INSERT-or-UPDATE -> commit)
  -> reader_profiles

clean focus / visible / pageshow / online
  -> one coalesced no-store GET
  -> adopt only if intent generation is unchanged
```

| Concern | Owner | Contract |
|---|---|---|
| Defaults and persistence | FastAPI `READER_PROFILE_DEFAULTS` + reader service | Missing-row GET and first-row PATCH consume the same complete value; preference columns have no database defaults. |
| Initial authority | `loadWorkspaceBootstrap` | Profile uses normal 30 s request deadline and is required; other seeds stay best-effort. |
| State decisions | `readerProfileSync.ts` | Strict decode, patch merge/equality, exhaustive pure reducer. |
| Browser effects | `useReaderProfile` | Timers, fetches, single-flight ordering, lifecycle, revalidation. |
| Public capability | `ReaderProvider` | Optimistic profile, structured status, semantic setters, Retry. |
| Theme composition | `MediaPaneBody` + `buildReaderSurfaceStyle` | Derive once; pass class/style into each reflowable reader. |

`useReaderContext` outside its provider throws. A same-segment `error.tsx` cannot
catch its own layout, so the authenticated layout wraps its existing
`Suspense`/`WorkspaceBootstrapGate` subtree in a client class boundary adapted
from the existing pane pattern. Because the gate resolves to the shell, this is
the boundary for the whole authenticated workspace, with workspace-generic copy;
it does not affect `/login`, `/terms`, `/share`, or other public routes. Retry is
exactly:

```ts
startTransition(() => {
  router.refresh();
  reset();
});
```

Here `reset()` clears the class boundary; `router.refresh()` is required to make
a new Server Component request. Resetting the boundary alone is not recovery.

## 5. Capability and state contract

No generic public `save(Partial<ReaderProfile>)`:

```ts
type ReaderProfileRetryableFailure =
  | { kind: "TransientApi"; error: ApiError } // 408, 429, or 5xx
  | { kind: "Transport"; error: TypeError | DOMException }
  | { kind: "AttemptDeadlineExceeded" };

type ReaderProfileForbiddenFailure = { kind: "Forbidden"; error: ApiError };
type ReaderProfileSaveFailure =
  | ReaderProfileRetryableFailure
  | ReaderProfileForbiddenFailure;

type ReaderProfilePersistence =
  | { state: "Clean" }
  | { state: "Pending" }
  | { state: "SaveFailed"; failure: ReaderProfileRetryableFailure }
  | { state: "Forbidden"; failure: ReaderProfileForbiddenFailure };

interface ReaderProfileCapability {
  profile: ReaderProfile; // optimistic desired projection
  persistence: ReaderProfilePersistence;
  setTheme(value: ReaderTheme): void;
  setFontFamily(value: ReaderFontFamily): void;
  setFocusMode(value: ReaderFocusMode): void;
  setHyphenation(value: ReaderHyphenation): void;
  setFontSize(value: number): void;
  setLineHeight(value: number): void;
  setColumnWidth(value: number): void;
  retrySave(): void;
}
```

```text
acknowledged: ReaderProfile
desired:      ReaderProfile
local: Clean
     | Deferred(work)
     | Saving(attemptId, sentPatch, queuedLatestWork?, startedAt, expiresAt)
     | SaveFailed(latestPatch, failure)
     | Forbidden(failure)
```

`work` is `{ patch, schedule }`, where `schedule` is `Immediate` or
`Range(idleAt, deadlineAt)`. A range input moves `idleAt` to now + 400 ms but
preserves the first input's 5 s `deadlineAt`. Any discrete intent upgrades the
merged work to `Immediate`.

Rules:

- `desired` drives pixels; `acknowledged` is confirmed server truth;
- merge patches per field, newest value wins; never let an older response revert
  queued intent;
- a decoded success replaces `acknowledged`; queued work overlays that response
  into `desired`, then sends if due or resumes its remaining timer. Without
  queued work, `desired` converges to the response and becomes `Clean`;
- one logical browser PATCH is in flight; failure re-merges sent and queued work
  for idempotent retry;
- new intent from `SaveFailed` merges into that work, clears stale feedback, and
  follows the new field's cadence;
- explicit `retrySave()` sends the latest retryable failed patch immediately and
  defects if invoked in any other state;
- controls stay interactive in `Pending` and `SaveFailed`. `Forbidden` disables
  persistence controls/quick-switches, restores `desired` to `acknowledged`, and
  has no Retry until a fresh bootstrap;
- 401 goes to the existing auth boundary. Only `403/E_FORBIDDEN` becomes terminal
  `Forbidden`; `403/E_INTERNAL_ONLY` and unknown 403 codes are defects.
  408/429/5xx and `TypeError`/`DOMException` are retryable. Other 4xx, invalid
  response, decoder mismatch, and unknown throws are defects;
- the pure module imports no Feedback UI. An exhaustive
  `toReaderProfileSaveErrorMessage` helper maps every failure variant to product
  copy at the UI boundary.

## 6. Storage and API

### Final storage

```text
reader_profiles
  user_id          primary key / account owner
  theme            light | dark
  font_family      serif | sans
  font_size_px     12..28
  line_height      1.2..2.2
  column_width_ch  40..120
  focus_mode       off | distraction_free | paragraph | sentence
  hyphenation      auto | off
  created_at       database-clock creation metadata; never in the DTO
```

Migration `0181` renames `reader_profiles.updated_at` to `created_at` and drops
the seven preference-column server defaults. It keeps `NOT NULL`, CHECKs, and
the database-clock `created_at` default. A migration characterization first
changes a profile field under `0180` and proves a sentinel `updated_at` does not
advance; after upgrade, the same instant is `created_at` and `updated_at` is
absent. This preserves truthful creation metadata without implying a conflict
clock.

### HTTP contract

`GET /me/reader-profile` and `GET /api/me/reader-profile` return exactly:

```json
{
  "data": {
    "theme": "light",
    "font_family": "serif",
    "font_size_px": 16,
    "line_height": 1.5,
    "column_width_ch": 65,
    "focus_mode": "off",
    "hyphenation": "auto"
  }
}
```

One immutable, schema-validated, exact seven-field `READER_PROFILE_DEFAULTS`
value in the FastAPI reader service is the only preference-default authority.
Absent GETs return it without inserting; first PATCH explicitly initializes all
seven fields from it before applying the patch. PATCH accepts any non-empty
subset of the seven fields, including all seven: retain existing `400` rejection
for explicit null, unknown fields, and invalid values; newly reject `{}`. Success
returns the exact complete seven-field profile. `ReaderProfilePatch` uses strict
Pydantic input typing (`ConfigDict(strict=True, extra="forbid")`): numeric strings
and non-integer numeric forms for integer fields are also `400`, never coerced.

The entire PATCH attempt runs inside `retry_serializable`:

1. SELECT by user;
2. INSERT defaults if absent, else use the selected row;
3. apply supplied fields;
4. commit, refresh, return.

Rename `AUTHOR_RETRYABLE_UNIQUE_CONSTRAINTS` to the owner-neutral
`RETRYABLE_UNIQUE_CONSTRAINTS` and add exact `reader_profiles_pkey`. A concurrent
first insert retries the whole attempt, observes the winner, and applies its
patch. No upsert, explicit lock, operation row, or custom retry schedule.

Same-field cross-device writes are serialization-order last-write-wins;
distinct-field partial patches compose after retry. No revision protocol.

FastAPI and BFF success/error responses carry `Cache-Control: private,
no-store`. Rename and widen the outermost path contract in `python/nexus/app.py`
to `READER_PRIVATE_NO_STORE_PATH_RE`, exactly matching
`/media/{id}/reader-state` or `/me/reader-profile`; the existing middleware,
renamed `private_reader_no_store`, not route handlers, stamps
200/400/401/403 responses. For a matched path it also catches a raw exception,
delegates once to the canonical `unhandled_exception_handler`, and stamps that
500 response; non-matching exceptions keep the normal Starlette path. Extract
the local reader-state BFF wrapper into `privateNoStoreResponse.server.ts` and
use it for both routes; client GETs also request `cache: "no-store"`.

## 7. Scheduling and reconciliation

- Discrete fields (`theme`, `font_family`, `focus_mode`, `hyphenation`) send
  immediately when idle; a discrete change also folds in deferred range work.
- Continuous fields use `READER_PROFILE_IDLE_MS = 400` and
  `READER_PROFILE_MAX_WAIT_MS = 5_000`, measured from first unflushed input
  regardless of writer state. Range-only work queued behind a PATCH keeps those
  clocks; on acknowledgement it sends if due, otherwise resumes the timer.
- Every PATCH is awaited and uses `keepalive: true`.
- Hidden `visibilitychange`, `pagehide`, and provider teardown flush deferred
  or `SaveFailed` work only if logically idle. Never promote `Forbidden`, start a
  second logical attempt, or use `beforeunload`/`unload`.
- `Saving` carries an attempt ID and 35 s wall-clock watchdog deadline (the BFF's
  30 s deadline plus margin); `useReaderProfile` owns the `AbortController` keyed
  to that ID. Timer, `pageshow`, visible, and focus call one expiry check. Expiry
  invalidates then aborts the attempt, merges sent and queued work into
  `SaveFailed(AttemptDeadlineExceeded)`, and ignores late settlement. Restore
  never auto-starts a replacement PATCH.
- Resume events coalesce to one GET only from `Clean`. Capture
  `intentGeneration`; on completion adopt only if state is still `Clean` and the
  generation is unchanged.
- Auth failures redirect. Only classified transport, 408, 429, and 5xx
  revalidation failures may retain current state until the next event, with a
  `justify-ignore-error` comment. Malformed owned responses defect.

Residual: “single-flight” means one active logical browser attempt. Abort cannot
prove that an expired server transaction stopped or did not commit; a subsequent
explicit, new-intent, or lifecycle retry can overlap it, and an older same-field
write can serialize last. OS force-kill can also lose a request or queued
successor. Eliminating these tails requires the excluded
idempotency/revision/durable-outbox work.

## 8. Surface and UX contract

- Reader theme owns reading canvas only, not workspace/header/player chrome.
- `MediaPaneBody` computes the existing `readerSurfaceClassName` and
  `readerSurfaceStyle` once and passes both to `TranscriptContentPanel`.
- `TranscriptContentPanel` replaces its Fragment with one themed root covering
  warning/empty state, timeline, segment cards, dividers, and active prose. It
  deletes its context read and nested theme derivation; `.readerContentInner`
  remains prose-only. `TranscriptPlaybackPanel` stays outside and app-themed.
- `apps/web/src/app/(authenticated)/media/[id]/page.module.css` receives net-new
  transcript mappings from app tokens to scoped `--reader-*` background, text,
  border, and accent tokens. Web/EPUB retain `.readerContentRoot`.
- Reader roots set resolved CSS `color-scheme`; the Light/Dark palette is
  unchanged.
- Success is silent; Settings may show quiet `Saving…`. `SaveFailed` creates one
  persistent global notice with Retry; `Forbidden` has no action. The Feedback
  owner adds `dismissByDedupeKey(key)` for permanent success cleanup and
  `suppressDedupeKey(key): () => void` for a scoped presentation lease. While
  `usePaneRuntime().isActive` Settings holds `reader-profile-save`, the retained
  toast is hidden and inline feedback is shown; release restores it if failure
  remains. Inactive Settings renders no inline live notice. There is exactly one
  visible live presentation at a time; repeated shows dedupe within a surface,
  while moving an unresolved error to a newly active surface may announce it
  once there. Request ID is included when present.
- The bootstrap error region has `role="alert"`, a labelled heading,
  `tabIndex={-1}`, and receives focus on mount; Retry exposes pending/disabled
  state. Saving is polite `role="status"`; the one active save-failure
  presentation is assertive.
- Theme transitions use duration tokens and resolve to 0 ms under
  `prefers-reduced-motion`. A PDF resource-menu status row says “PDF pages keep
  their source colors”; the Reader quick switch remains absent for PDFs.

## 9. Reuse and deletion

Reuse/adapt:

- single-flight/latest-only and clean-revalidation invariants from
  `readerProgress.ts` / `useReaderProgress.ts`—not their identity/revision model;
- `apiFetch` with PATCH + `keepalive`, `buildReaderSurfaceStyle`, existing reader
  tokens/roots, `FeedbackNotice`, and the reader-state no-store wrapper;
- the existing class error-boundary pattern, but not a generic boundary
  abstraction: pane and bootstrap reset/recovery contracts differ;
- add narrow keyed dismissal and scoped keyed suppression to the existing global
  Feedback owner; suppressed records remain owned there until release/dismissal.

Delete:

- frontend `DEFAULT_READER_PROFILE`, context `NOOP`, generic `save`, parallel
  update wrappers, and bootstrap catch/default/500 ms profile timeout;
- test-only debounce/fetch seams, lossy unmount cleanup, Settings save-time
  disabling/mount workaround, and tests/comments that bless those behaviors;
- `TranscriptContentPanel`'s context read and duplicate font/theme derivation;
- public/schema `updated_at` plus its tests; rename the database/model field to
  truthful `created_at` metadata;
- stale docs claiming every bootstrap read is optional.

Do not generalize with reader progress, workspace session, note autosave, or a
new generic sync hook. Do not add React 19 `useOptimistic`: it cannot own
single-flight transport, latest-queued merge, timers, lifecycle promotion, or
generation-guarded revalidation, and would duplicate `desired`.

## 10. Files

### Create

- `apps/web/src/lib/reader/readerProfileSync.ts` and `.test.ts`;
- `apps/web/src/lib/api/privateNoStoreResponse.server.ts` and `.test.ts`;
- `apps/web/src/lib/reader/ReaderContext.test.tsx`;
- `apps/web/src/app/(authenticated)/AuthenticatedWorkspaceErrorBoundary.tsx`,
  `.test.tsx`, and `.module.css`;
- `apps/web/src/app/(authenticated)/media/[id]/TranscriptContentPanel.test.tsx`;
- `apps/web/src/app/(authenticated)/settings/reader/SettingsReaderPaneBody.test.tsx`;
- `e2e/reader-profile-upstream-proxy.ts` and
  `e2e/tests/reader-profile-recovery.spec.ts`;
- `migrations/alembic/versions/0181_reader_profile_created_at.py`;
- this specification.

### Modify

- bootstrap: `(authenticated)/layout.tsx`, `WorkspaceBootstrapGate.tsx`,
  `lib/workspace/bootstrap.server.ts` + tests, `resourceTransport.ts` comments;
- reader owner: `lib/reader/{types,useReaderProfile,ReaderContext,
  readerSurfaceStyle}*`;
- UX: `SettingsReaderPaneBody*`, `MediaPaneBody*`, `TranscriptContentPanel*`,
  `app/(authenticated)/media/[id]/page.module.css`,
  `components/feedback/Feedback.tsx`, and existing
  `__tests__/components/Feedback.test.tsx`;
- BFF: reader-profile and reader-state routes;
- backend: `python/nexus/{app.py,db/retries.py,db/models.py,
  schemas/reader.py,services/reader.py}`, `python/tests/{test_db_retries,
  test_reader_integration,test_migrations}.py`;
- `e2e/tests/{reader-settings,youtube-transcript,pdf-reader}.spec.ts` and narrow
  source gates;
- recovery-project wiring in `Makefile`, `scripts/with_test_services.sh`, and
  `e2e/playwright.config.ts`; the proxy is test-process-only;
- docs: `docs/modules/reader-{implementation,design-rationale}.md`,
  `docs/architecture.md`, and
  `docs/cutovers/first-paint-speed-streaming-and-restore-hard-cutover.md`.

### Delete whole files

- `apps/web/src/lib/reader/useReaderProfile.test.tsx`; its injected-fetch hook
  tests are replaced by pure coordinator contracts plus real-stack E2E.

## 11. Delivery plan

All slices land together; mixed behavior is invalid.

1. Add failing pure state/decoder, backend concurrency/schema, scoped-boundary,
   transcript, and real-stack reload/no-store tests.
2. Cut over DB/API/bootstrap and remove default/timestamp contracts.
3. Replace the client capability/coordinator and feedback contract.
4. Complete transcript theme composition; delete superseded paths/docs/tests.
5. Run focused static, unit, component, integration, real-stack E2E, migration,
   and negative source gates.

AC-1 uses a dedicated E2E-project, test-tier-owned network fault injector in
front of real FastAPI: it fails exactly the first profile GET, delegates all
other traffic, records both server-to-server GETs, and is never compiled into
production. No internal module/router mock, browser route interception, or
mock-only acceptance proof is allowed.

## 12. Acceptance criteria

- **AC-1:** a valid profile arriving after 500 ms still seeds the shell; timeout
  or failure never yields ready Light. From the scoped bootstrap fallback, Retry
  causes a second uncached `GET /me/reader-profile`; its success reveals the
  shell. A boundary re-render alone does not pass.
- **AC-2:** discrete-field changes from desktop Settings and the 390x844 touch
  quick switch survive immediate reload without polling for persistence first.
- **AC-3:** discrete idle/enqueue and idle-writer 400 ms/5 s range cadence are
  observable; hidden/`pagehide` flushes deferred and retryable failed work only
  when no logical PATCH is in flight; stale `Saving` expires and ignores late
  settlement.
- **AC-4:** for non-expired attempts, A then B during A preserves B visually and
  durably; retryable failed work plus new intent remains editable and retries as
  one latest patch. `Forbidden` disables persistence controls and has no Retry.
- **AC-5:** clean resume adopts remote state only when captured generation is
  unchanged; non-clean state and stale GETs cannot overwrite local intent.
- **AC-6:** transcript warning/empty/timeline/segments/dividers/content follow
  Reader Theme; playback, PDF, app appearance, and workspace chrome do not. PDF
  exclusion is visible and reduced-motion theme changes have no transition.
- **AC-7:** concurrent first PATCHes produce one row and a valid serial result;
  GET/PATCH accept/return only the seven-field contract.
- **AC-8:** the widened outer FastAPI reader-private middleware and shared BFF
  helper stamp real 200/400/401/403 responses `private, no-store`; an injected raw
  `RuntimeError` proves the middleware-owned 500 path is stamped too.
- **AC-9:** exactly one client write owner exists; provider absence defects; no
  frontend default, no-op, raw save, public `updated_at`, alternate endpoint,
  storage mirror, revision, feature flag, or generic sync abstraction remains.

Required proof:

- pure: strict decode, merge/reducer ordering, stale acknowledgement/attempt,
  watchdog expiry, failure/new-intent/retry, no-store response helper;
- component: scoped error focus/presentation, missing provider, keyed Feedback
  suppression with no simultaneous alert regions, interactive failed controls,
  transcript theme composition, and PDF affordance—using real owned components,
  not internal mocks;
- service integration: exact/default/invalid DTOs, serializable first-insert
  race, missing-row GET versus first-partial-PATCH untouched-default equality,
  strict rejection of coercible numeric strings/non-integer numeric forms,
  FastAPI no-store for 200/400/401/403/raw-500, and migration pre-rename
  timestamp characterization/final shape plus `column_default IS NULL` for all
  seven preference columns;
- real-stack E2E: desktop/mobile-web immediate reload, lifecycle cadence, BFF
  headers, rendered theme, transcript boundary, and reduced motion. Recovery E2E
  uses the counted test-process upstream: fail first profile GET, show workspace
  fallback, Retry, observe second GET, then reveal the shell;
- negative source gates: no profile `PREFETCH_OPTS`/catch/default, no context
  fallback/raw save, reader-profile `updated_at` assignment, preference-column
  server defaults, or transcript context derivation; all profile PATCHes set
  `keepalive`.

## 13. Key decisions

- Required SSR profile is the honest minimum because profile width participates
  in workspace restoration; the skeleton preserves streaming first paint.
- Backend service defaults are domain values. Database preference defaults
  duplicate them; frontend defaults mask errors.
- Optimistic pixels and persistence acknowledgement are separate states.
- Serializable last-write-wins is sufficient for this one-user prototype;
  durable delivery and revision conflicts are the next 20%.
