# Spec: Multi-Library Assignment on Ingest

Status: proposal
Owner: ingestion + libraries
Hard cutover. No legacy code, no fallbacks, no backward compatibility.

---

## 1. Problem statement

Today every ingest surface — Android share, desktop tray, browser-extension capture, podcast subscribe, OPML import — drops the resulting media into the user's default library and nothing else. A user wanting the doc to also live in "Research" or "Listening" must reopen the doc and use the `LibraryMembershipPanel` after the fact. Bulk add flows (multi-URL paste, OPML import, multi-file upload) have no per-item control at all.

The desktop tray exposes a single-select `LibraryTargetPicker` for one additional library; the Android share flow exposes nothing; the podcast subscribe flow exposes nothing. The data model (`LibraryEntry` is N:M; `library_entries` has a unique key on `(library_id, media_id)`) has always supported multi-library membership. The gap is purely UX + API surface.

## 2. Goals

- G1. At every ingest surface, the user can pick zero, one, or many libraries for the incoming doc.
- G2. The user's default library ("My Library") is always implicit — it cannot be deselected; the picker chooses *additional* libraries on top.
- G3. Bulk-add flows (tray multi-paste/upload, OPML import) support a batch-level default *and* per-item override.
- G4. The Android share flow gives the user agency: a modal post-add picker appears in the share WebView after the media row is created, before the deep-link back to the host app.
- G5. Sharing an already-existing URL again adds the newly-picked libraries to the existing media additively — existing memberships are never removed by the ingest path.
- G6. Podcast subscriptions carry a library set. All existing episodes are backfilled into those libraries on subscribe; all future episodes synced by `podcast_sync_subscription_job` inherit the set on creation.

## 3. Non-goals

- NG1. No rules engine, automation, or LLM-based classification. Assignment is always explicit.
- NG2. No tags, smart libraries, saved filters, or per-user "default library for kind X" preferences.
- NG3. No provenance tracking on `LibraryEntry` (no `source` column distinguishing manual/closure/rule). All entries are uniform.
- NG4. No backward compatibility for callers passing a single `library_id`. Every ingest endpoint and service is hard-cutover to `library_ids: list[UUID]`.
- NG5. No capability gating / plan tiering / quota. Multi-library is part of the base library feature.
- NG6. No extension UI in this repo. Backend accepts `library_ids` on `/media/capture/*`; the extension client (separate codebase) ships its own picker on its own schedule. Until then, the extension sends `library_ids: []`.
- NG7. No "remove library from subscription" UX. Editing a subscription's libraries only adds; per-episode removal goes through the existing `LibraryMembershipPanel`.
- NG8. No new "inbox" or "uncategorized" view. Empty `library_ids` means My Library only — that's already the inbox.
- NG9. No feature flag, gradual rollout, or A/B. One PR (or stack) flips the whole surface.

## 4. Final state — target behavior

### 4.1. Desktop add-content tray (`apps/web/src/components/AddContentTray.tsx`)

- Header has a **batch picker** (`LibraryMultiSelectPicker` mode="dropdown"). Label: "Also add to…" → "My Library only" (empty) / "+ Research" (one) / "+ 3 libraries" (many).
- Queue list (file rows + URL rows) gains a per-row picker rendered as a small chip. Default value: the current batch selection at enqueue time. User can tap the chip to override per-row.
- On submit, each queue item POSTs with its own resolved `library_ids: list[UUID]`. The batch picker does not retroactively change already-enqueued rows; it only sets the default for newly enqueued rows. (Items enqueued before batch picker was changed keep their original selection; new items get the new default.)
- Empty selection on a row → My Library only.

### 4.2. Android share intent (`apps/web/src/app/share/ShareCapture.tsx`)

Sequence:

1. ShareActivity loads `/share?text=<url>` in the WebView (existing `ShareActivity.kt`).
2. `ShareCapture` extracts URLs, calls `POST /media/from_url { url, library_ids: [] }`. Response includes `media_id` and processing status (queued / processed / already-exists).
3. On success, `ShareCapture` opens `LibraryMultiSelectPicker` mode="modal" inside the same WebView. The modal shows:
   - List of viewer's non-default libraries, each with a checkbox.
   - **Confirm** button (primary): calls `POST /media/{media_id}/libraries { library_ids: [...] }`, awaits 200, closes modal, deep-links `nexus-share://done`.
   - **Skip** button (secondary): closes modal, deep-links `nexus-share://done`. Doc remains in My Library only.
4. If `POST /media/from_url` fails, no modal is shown — existing error path.
5. If the shared text contains no URLs, falls back to existing daily-note quick-capture (no library picker).
6. If the shared text contains multiple URLs, each URL creates its own media row sequentially; the modal opens once **after the last** media row is created and applies the same library set to all of them.

The modal is **best-effort**: dismissing it does not undo the ingest. The default-library membership is already written by step 2.

### 4.3. Browser extension capture (`POST /media/capture/*`)

Backend accepts `library_ids` on all three endpoints. The extension's own UI is out of scope; it sends `library_ids: []` until the extension repo ships its own picker. No backend-side stub — empty list is a valid request body.

### 4.4. Podcast subscribe (`apps/web/src/app/(authenticated)/podcasts/...`)

- Subscribe form gains the multi-select picker.
- On submit, `POST /podcasts/subscriptions { feed_url, library_ids: [...] }`:
  1. Subscription row is created (existing behavior).
  2. Rows in `podcast_subscription_libraries` are inserted (one per `library_id`).
  3. `podcast_sync_subscription_job` is enqueued (existing behavior).
- During sync, for each episode media row created or refreshed in this run, the job calls `libraries.add_media_to_libraries(...subscription.library_ids)`. Idempotent via `(library_id, media_id)` unique constraint.
- **Initial subscribe backfill**: the sync job, on its first run for a new subscription, iterates the feed's existing episodes (the standard behavior). Each episode media row created during that first run gets the library set applied. There is no separate backfill job — the existing sync run is the backfill.
- **Re-subscribe / editing library set** (future UI; not in v1 scope, but the data model supports it): `POST /podcasts/subscriptions/{id}/libraries { library_ids: [...] }` replaces the set in `podcast_subscription_libraries`. On the next sync, newly-added libraries apply to all existing episodes (additive). Libraries removed from the subscription set are **not** removed from individual episode memberships — episode memberships are independent rows after creation.

### 4.5. OPML import (`POST /podcasts/import/opml`)

- Import form has a **batch picker** ("Apply to all imported podcasts") plus a preview table of parsed feeds. Each row in the preview has a per-feed override picker, defaulting to the batch.
- Request body:
  ```json
  {
    "opml": "<xml>",
    "default_library_ids": ["<uuid>", ...],
    "per_feed_library_ids": { "<feed_url>": ["<uuid>", ...] }
  }
  ```
- For each parsed feed: resolved library set = `per_feed_library_ids[feed_url] ?? default_library_ids`.
- Each subscription is created with its resolved set; episodes propagate per §4.4.

### 4.6. Re-share / duplicate

When `enqueue_media_from_url` finds an existing media row (URL already ingested by this user — current dedup behavior):

- Returns the existing `media_id`.
- Applies `library_ids` from the new request **additively** — calls `libraries.add_media_to_libraries(viewer_id, media_id, library_ids)`. Existing memberships (default + any prior additional libraries) are preserved. New memberships are added. Duplicates are no-ops via unique constraint.
- The Android post-add modal then runs against the (possibly already-existing) media row, same as for fresh ingests.

## 5. Architecture

### 5.1. Single resolver, called once per media

The current `_ensure_in_default_library(db, viewer_id, media_id)` call at the end of every create-media path is replaced by:

```python
# python/nexus/services/libraries.py
def assign_libraries_for_media(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    library_ids: list[UUID],
) -> None:
    """Attach `media_id` to viewer's default library + each id in `library_ids`.
    Additive — never removes existing memberships. Idempotent."""
    _ensure_in_default_library(db, viewer_id, media_id)
    if not library_ids:
        return
    accessible = _filter_accessible_libraries(db, viewer_id, library_ids)
    if accessible != set(library_ids):
        raise ForbiddenError(ApiErrorCode.E_LIBRARY_FORBIDDEN, "library not accessible")
    add_media_to_libraries(db, viewer_id, media_id, list(accessible))
```

Every ingest service calls this exactly once after the media row exists. There is one ingest pipeline; there is one library-assignment call.

`add_media_to_libraries` is the bulk version of the existing `add_media_to_library` in `libraries.py:439`; it iterates, idempotent per-row, in one transaction.

### 5.2. Podcast-side parallel

```python
# python/nexus/services/podcasts/subscriptions.py
def set_subscription_libraries(
    db: Session,
    subscription_id: UUID,
    library_ids: list[UUID],
) -> None:
    """Replace rows in podcast_subscription_libraries. Does NOT touch episode memberships."""
```

Called from:
- `subscribe_to_podcast` (initial set).
- A future "edit subscription libraries" route (post-v1).

The sync job (`podcast_sync_subscription.py`) reads `subscription.library_ids` once at job start and passes them to `assign_libraries_for_media` for every episode media row it creates or touches in that run.

### 5.3. Composition with other systems

| Subsystem | Interaction |
|---|---|
| **`_ensure_in_default_library`** | Kept; called by `assign_libraries_for_media`. The "doc always lands in My Library" guarantee is unchanged. |
| **Default library closure** (`services/default_library_closure.py`) | Multi-library ingest writes to `library_entries`; closure machinery already triggers off those writes for shared non-default libraries. No changes required — auto-multi-assign is just more `library_entries` insertions, which the closure system already handles. |
| **Library intelligence** (`LibrarySourceSetVersion`, `library_intelligence_build_job`) | Membership changes invalidate library overviews. Multi-library ingest will invalidate N overviews per doc instead of 1. Existing invalidation logic handles this — no changes. |
| **Capabilities** (`services/capabilities.py`) | No changes. No new capability flags. |
| **Billing / entitlements** | No changes. |
| **Per-stage retry / refresh** (`docs/ingest-retry-metadata.md`) | Orthogonal. Retry/refresh re-runs ingest jobs but does not re-run library assignment — library memberships are preserved across retries by virtue of being separate rows. |
| **Share-to-Nexus** (`docs/share-to-nexus.md`) | Section 4.2 above is the concrete update to that flow. |
| **`LibraryMembershipPanel`** | Unchanged. It remains the post-hoc full membership editor (add and remove) from the doc-view action menu. Different surface, different concern (post-ingest reorganization vs ingest-time selection). |
| **`LibraryTargetPicker`** | **Deleted.** Replaced by `LibraryMultiSelectPicker`. |

## 6. Data model

### 6.1. New table

`podcast_subscriptions` uses a composite PK of `(user_id, podcast_id)` — no surrogate `id` column — so the join table mirrors that key.

```sql
CREATE TABLE podcast_subscription_libraries (
    podcast_subscription_user_id    UUID NOT NULL,
    podcast_subscription_podcast_id UUID NOT NULL,
    library_id                      UUID NOT NULL
        REFERENCES libraries(id) ON DELETE CASCADE,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (
        podcast_subscription_user_id,
        podcast_subscription_podcast_id,
        library_id
    ),
    FOREIGN KEY (podcast_subscription_user_id, podcast_subscription_podcast_id)
        REFERENCES podcast_subscriptions (user_id, podcast_id) ON DELETE CASCADE
);

CREATE INDEX ix_podcast_subscription_libraries_library_id
    ON podcast_subscription_libraries (library_id);
```

Rationale for join table over JSONB column: matches every other N:M relation in the schema; cleanly supports "which subscriptions feed this library?" queries; `ON DELETE CASCADE` handles both subscription deletion and library deletion automatically.

### 6.2. Existing tables — no schema changes

- `library_entries` (models.py:1372) — already N:M for both media and podcast.
- `media` (models.py:743) — no new columns.
- `podcast_subscriptions` — no new columns.
- `libraries` (models.py:663) — no new columns.

### 6.3. Migration

`migrations/alembic/versions/0113_podcast_subscription_libraries.py`:

- `upgrade()`: create table + index.
- `downgrade()`: drop index, drop table.
- No data migration. New subscriptions get rows from the API; existing subscriptions start with an empty set (i.e., episodes from existing subscriptions land in My Library only, same as today).

## 7. API contract (final)

All ingest endpoints accept `library_ids: list[UUID]`. **No optional/single-id alias.** Empty list is valid.

### 7.1. Media ingest endpoints

| Endpoint | Request body |
|---|---|
| `POST /api/media/from_url` | `{ "url": str, "library_ids": [UUID] }` |
| `POST /api/media/upload/init` | `{ "filename": str, "kind": str, "content_type": str, "size_bytes": int, "library_ids": [UUID] }` |
| `POST /api/media/{id}/ingest` | `{ "library_ids": [UUID] }` |
| `POST /api/media/capture/article` | `{ "html": str, "url": str, "title": str?, "byline": str?, ..., "library_ids": [UUID] }` |
| `POST /api/media/capture/file` | Body: file bytes. Headers: `x-nexus-filename`, `content-type`, `x-nexus-source-url?`, **`x-nexus-library-ids`** (comma-joined UUIDs; empty header = empty list) |
| `POST /api/media/capture/url` | `{ "url": str, "library_ids": [UUID] }` |

### 7.2. New endpoint

`POST /api/media/{id}/libraries`

- Body: `{ "library_ids": [UUID] }`
- Behavior: additive bulk-add. Calls `libraries.add_media_to_libraries(viewer_id, id, library_ids)`. Idempotent.
- Used by: Android post-add modal; future bulk-add flows.
- Preconditions: viewer can see the media; viewer has admin or member role on every library in the list.
- Response 200: `{ "media_id": UUID, "library_ids_added": [UUID] }` where the response array is the set actually inserted (excludes already-present and default-library dedupes).
- Errors:
  - 422 if body missing or `library_ids` invalid type.
  - 403 `E_LIBRARY_FORBIDDEN` if any id is inaccessible.
  - 404 if media not visible to viewer.

This is intentionally additive-only, not a replace. Replacement semantics (remove + add) belong to `LibraryMembershipPanel`'s flow, which uses the existing per-library endpoints.

### 7.3. Podcast endpoints

| Endpoint | Request body |
|---|---|
| `POST /api/podcasts/subscriptions` | `{ "feed_url": str, "library_ids": [UUID] }` |
| `POST /api/podcasts/import/opml` | `{ "opml": str, "default_library_ids": [UUID], "per_feed_library_ids": { feed_url: [UUID] } }` |

`per_feed_library_ids` keys not present in the OPML are ignored. Feeds in the OPML but absent from `per_feed_library_ids` fall back to `default_library_ids`.

### 7.4. Validation rules (uniform across all endpoints)

- `library_ids` is **required** (may be `[]`).
- Each id must reference a library where the viewer is admin or member. Mixed permissions → `E_LIBRARY_FORBIDDEN`, no partial application, no fallback to default-only.
- The viewer's default library id, if present in `library_ids`, is silently deduplicated. It is not an error.
- Duplicates within the array are deduplicated.
- Unknown id (no such library, or library belongs to another owner with no membership) → `E_LIBRARY_FORBIDDEN`. We do not leak the distinction between "doesn't exist" and "you can't see it."

### 7.5. Error codes (in `python/nexus/errors.py`)

New: `E_LIBRARY_FORBIDDEN` (403). All other error codes unchanged.

## 8. Service contract (final)

| Function | File | Final signature |
|---|---|---|
| `enqueue_media_from_url` | `services/media.py` | `(db, viewer_id, url, library_ids: list[UUID]) -> MediaOut` |
| `init_upload` | `services/upload.py` | `(db, viewer_id, filename, kind, content_type, size_bytes, library_ids: list[UUID]) -> UploadInitOut` |
| `confirm_ingest_for_viewer` | `services/epub_lifecycle.py` (and pdf equivalent) | `(db, viewer_id, media_id, library_ids: list[UUID]) -> MediaOut` |
| `create_captured_web_article` | `services/media.py` | `(db, viewer_id, html, url, meta, library_ids: list[UUID]) -> MediaOut` |
| `create_captured_file` | `services/media.py` | `(db, viewer_id, file_bytes, filename, content_type, source_url, library_ids: list[UUID]) -> MediaOut` |
| `subscribe_to_podcast` | `services/podcasts/subscriptions.py` | `(db, viewer_id, feed_url, library_ids: list[UUID]) -> SubscriptionOut` |
| `import_subscriptions_from_opml` | `services/podcasts/subscriptions.py` | `(db, viewer_id, opml_xml, default_library_ids: list[UUID], per_feed_library_ids: dict[str, list[UUID]]) -> ImportResultOut` |
| `assign_libraries_for_media` *(new)* | `services/libraries.py` | `(db, viewer_id, media_id, library_ids: list[UUID]) -> None` |
| `add_media_to_libraries` *(new)* | `services/libraries.py` | `(db, viewer_id, media_id, library_ids: list[UUID]) -> list[UUID]` (returns ids actually inserted) |
| `set_subscription_libraries` *(new)* | `services/podcasts/subscriptions.py` | `(db, subscription_id, library_ids: list[UUID]) -> None` |

All callers are migrated in one PR. The single-id functions and their call sites are deleted, not aliased.

## 9. Frontend architecture (final)

### 9.1. New component

`apps/web/src/components/LibraryMultiSelectPicker.tsx`

Props:
```ts
type Props = {
  mode: 'dropdown' | 'modal';
  selectedLibraryIds: string[];
  onChange: (next: string[]) => void;
  libraries: LibrarySummary[];   // viewer's non-default libraries; default library excluded
  className?: string;
  // modal-only
  open?: boolean;
  onConfirm?: (ids: string[]) => Promise<void>;
  onSkip?: () => void;
};
```

- The default library is **never** in `libraries[]` and **never** selectable. The widget's "My Library only" label is rendered when `selectedLibraryIds.length === 0`.
- Empty state: same widget with no libraries to pick from → renders a disabled chip "My Library only" with a tooltip "Create a library to file shared docs into multiple places."
- Search input above the list when `libraries.length > 6`.
- Mode `dropdown`: popover with checkboxes; chip-style trigger.
- Mode `modal`: full-screen sheet (mobile-friendly) with Confirm + Skip buttons. Used in Android share.

### 9.2. New hook

`apps/web/src/lib/media/useMediaLibraryAddition.ts`

```ts
function useAddMediaToLibraries(): {
  add: (mediaId: string, libraryIds: string[]) => Promise<void>;
  isAdding: boolean;
};
```

Wraps `POST /api/media/{id}/libraries`. Toast on success ("Added to 3 libraries"), feedback toast on failure.

### 9.3. Files touched

| File | Change |
|---|---|
| `apps/web/src/components/AddContentTray.tsx` | Replace `LibraryTargetPicker` with `LibraryMultiSelectPicker` (batch). Add per-row picker column. Each `QueueItem` stores `selectedLibraryIds: string[]`. Submit calls pass per-row ids. |
| `apps/web/src/app/share/ShareCapture.tsx` | After `addMediaFromUrl` resolves, open `LibraryMultiSelectPicker` mode="modal". On Confirm → `useAddMediaToLibraries().add(media_id, ids)` → deep-link `nexus-share://done`. On Skip → deep-link immediately. |
| `apps/web/src/app/(authenticated)/podcasts/SubscribePodcastForm.tsx` (or current location) | Add multi-select picker. Submit `library_ids` with subscribe POST. |
| `apps/web/src/app/(authenticated)/podcasts/OPMLImport*.tsx` | Add batch picker + per-feed override row in preview table. Submit shaped per §7.3. |
| `apps/web/src/lib/media/mediaLibraries.ts` | Adjust types: `library_ids: string[]` on create/capture wrappers. |
| `apps/web/src/lib/actions/resourceActions.ts` | Server-action wrappers updated to pass `library_ids`. |
| `apps/web/src/lib/androidShell.*.tsx` | No behavior change; deep-link contract unchanged. Update tests for new ShareCapture flow. |
| `apps/web/src/components/LibraryTargetPicker.tsx` | **Delete.** |

## 10. Capability contract

No new capabilities. No changes to `CapabilitiesOut`. Library accessibility is checked at request time via existing membership rules (admin or member of the library). The multi-library feature is universal to all users with any library.

## 11. Idempotency & validation summary

- `library_entries` `(library_id, media_id)` unique constraint → idempotent media-library inserts. Service catches `IntegrityError` and treats as no-op.
- `podcast_subscription_libraries` `(podcast_subscription_id, library_id)` PK → idempotent subscription-library inserts.
- Default library membership is always ensured by `_ensure_in_default_library`, regardless of payload.
- Re-share of a known URL: existing media is reused; new `library_ids` are added; existing memberships preserved.
- Re-running the same `POST /media/{id}/libraries` call: no error, response shows empty `library_ids_added` if all were already present.

## 12. Acceptance criteria

- A1. Desktop tray batch picker is a multi-select. Selecting "Research" + "Books" before enqueueing items makes both apply to all subsequently enqueued items.
- A2. Each row in the tray queue has its own picker chip that overrides the batch selection without affecting other rows or the batch.
- A3. Submitting the tray ingests each item with its own `library_ids`; in the DB, the media row has `library_entries` for My Library + each selected library.
- A4. Android `/share` opens the post-add modal in the WebView immediately after `POST /media/from_url` returns 2xx.
- A5. Tapping **Skip** on the Android modal deep-links back to the host app; the media is in My Library only.
- A6. Tapping **Confirm** on the Android modal with N libraries selected calls `POST /media/{id}/libraries`, returns 200, deep-links back, and `library_entries` shows My Library + N rows.
- A7. Sharing a URL whose media already exists: existing media row is reused; new `library_ids` are inserted additively; existing memberships are preserved.
- A8. Subscribing to a podcast with `library_ids = [L1, L2]`: subscription row created; two rows in `podcast_subscription_libraries`; existing episodes (from initial sync) end up in My Library + L1 + L2.
- A9. After initial subscribe, new episodes synced by `podcast_sync_subscription_job` are written into `library_entries` for L1 + L2 (and My Library via the default mechanism).
- A10. OPML import with `default_library_ids = [L1]` and `per_feed_library_ids = { feedA: [L2] }`: feedA's subscription gets L2 only (no L1); other feeds get L1.
- A11. Any endpoint rejects requests where the viewer lacks admin/member on any id in `library_ids` with HTTP 403 `E_LIBRARY_FORBIDDEN`. Atomically — no partial application.
- A12. Empty `library_ids: []` succeeds on every endpoint and produces a doc in My Library only.
- A13. Including the viewer's default library id in `library_ids` is silently deduped — no error, no double row, no warning.
- A14. `POST /media/capture/article|file|url` accept `library_ids` (body or `x-nexus-library-ids` header) and apply identically to `from_url`.
- A15. `LibraryTargetPicker.tsx` is deleted from the codebase. Grep returns zero references.
- A16. All ingest service functions accept `library_ids: list[UUID]` (required). No single-`library_id` signature exists in `services/`. Grep `library_id\s*[:=]` outside of `LibraryEntry.library_id` and similar legitimate references returns zero matches in service files.

## 13. Tests

### 13.1. Backend (`python/tests/`)

- `test_media.py`:
  - `test_from_url_with_library_ids` — parametrize `[]`, `[one]`, `[many]`; assert correct `library_entries`.
  - `test_from_url_rejects_inaccessible_library` — 403 + `E_LIBRARY_FORBIDDEN`, no media created or no partial assignment.
  - `test_from_url_default_library_in_list_dedupes` — passing default id is no-op.
  - `test_reshare_adds_libraries_to_existing_media` — re-shares a URL with new ids; assert additive.
  - `test_capture_article_library_ids`, `test_capture_file_header_library_ids`, `test_capture_url_library_ids`.
  - `test_upload_init_with_library_ids` (+ pdf + epub paths through `confirm_ingest_for_viewer`).
- New: `test_media_libraries_endpoint.py`:
  - `test_post_media_libraries_adds_set`.
  - `test_post_media_libraries_idempotent`.
  - `test_post_media_libraries_forbids_inaccessible`.
- `test_podcasts.py`:
  - `test_subscribe_with_library_ids_populates_join_table`.
  - `test_subscribe_backfills_existing_episodes_to_libraries`.
  - `test_sync_new_episodes_inherit_subscription_libraries`.
  - `test_opml_import_per_feed_override_wins_over_default`.
- `test_migrations.py`:
  - Migration `0113` upgrade + downgrade reversibility.
  - Constraint and index assertions.

### 13.2. Frontend (`apps/web/src/...`)

- `LibraryMultiSelectPicker.test.tsx`:
  - Dropdown mode: select/deselect; chip label updates ("My Library only" → "+ Research" → "+ 2 libraries").
  - Modal mode: Confirm calls `onConfirm` with ids; Skip calls `onSkip` and does not call `onConfirm`.
  - Empty libraries: disabled chip with tooltip.
- `AddContentTray.test.tsx`:
  - Batch picker affects new rows but not already-enqueued rows.
  - Per-row override sticks across batch changes.
  - Submit sends correct `library_ids` per item.
- `ShareCapture.test.tsx`:
  - Modal appears after successful `from_url`.
  - Confirm triggers `POST /media/{id}/libraries` with selected ids, then deep-links.
  - Skip deep-links without API call.
  - Multi-URL share: modal appears once after the last URL, applies to all.
- `SubscribePodcastForm.test.tsx`:
  - Picker selection submitted as `library_ids`.
- `androidShell.transcriptStatePanel.test.tsx` & sibling shell tests: no regression in deep-link contract.

## 14. Cutover plan

One PR (or one stack), merged together. Order of changes within the PR:

1. Migration `0113_podcast_subscription_libraries.py`.
2. Schemas updated (`python/nexus/schemas/media.py`, `schemas/podcasts.py`, `schemas/libraries.py` as relevant): `library_ids: list[UUID]` everywhere.
3. Service layer: signatures changed, `assign_libraries_for_media` + `add_media_to_libraries` + `set_subscription_libraries` added.
4. Route layer: request models updated, new `POST /media/{id}/libraries` route, `E_LIBRARY_FORBIDDEN` wired in.
5. Frontend: `LibraryMultiSelectPicker` added, `useAddMediaToLibraries` hook added.
6. Frontend wiring: tray, ShareCapture, podcast subscribe, OPML import.
7. `LibraryTargetPicker.tsx` deleted.
8. Tests added/updated.

Pre-merge checklist:

- [ ] Extension repo notified — extension must send `library_ids: []` (or any valid list) on its next deploy. Until the extension repo's deploy lands, extension captures will 422 on the new shape. **Accepted breakage window**, per the hard-cutover rule.
- [ ] Mobile (Android) only requires the WebView-side `/share` route change, which is part of this PR. No Android app code change needed (the `ShareActivity` deep-link contract is unchanged).
- [ ] All migrations applied in staging; verify `podcast_subscription_libraries` shape.

## 15. Open risks

- **R1. Extension breakage window.** Extension client must ship its `library_ids: []` request shape on or before this PR merges. If extension lags, captures 422 until extension deploys. Hard-cutover policy accepts this; communication is the mitigation.
- **R2. Tray queue UX clutter.** Per-row pickers next to every queue row may feel busy for OPML imports of 50+ feeds. Mitigation: render per-row picker as a small chip (matching badge); hide behind a "Customize" toggle for OPML import preview rows.
- **R3. Podcast library set drift.** An episode shared standalone *before* the user subscribes to the parent podcast won't be retroactively added to the subscription's library set. This is intentional — episode memberships are independent rows. Flag in docs only.
- **R4. Modal dismissal on flaky network.** If the Android modal's Confirm request fails, the user has already shared the doc successfully (it's in My Library). UX: show inline error, keep modal open, allow retry; "Skip" remains available to dismiss without library additions.
- **R5. Test surface area.** Multi-library matrix × 5 ingest surfaces × {empty, one, many} = many test combinations. Mitigation: parametrize aggressively; share fixtures across endpoints since the underlying `assign_libraries_for_media` is the same code path.
