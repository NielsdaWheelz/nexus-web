# Document Deletion Hard Cutover

## Goal

Give a user one clear action that removes a document from their world.

The final product contract is:

- `Delete document` removes the document from the viewer's default library.
- `Delete document` removes the document from every non-default library the
  viewer controls.
- If the document is still referenced by libraries the viewer does not control,
  the document becomes hidden from that viewer.
- If no remaining references exist after the viewer removal, the media row and
  all derived rows, chunks, embeddings, and storage objects are physically
  deleted.

This is a hard cutover. The final state has no legacy delete meaning, no
default-library-only delete path behind the main delete action, no compatibility
mode, no fallback visibility path, and no UI that implies an item can be
"deselected" from the default library while closure provenance keeps it visible.

## Problem

The current behavior has two different mental models:

- The backend treats the default library as a provenance-backed materialized view
  over direct default-library saves and non-default library closure edges.
- The UI presents document deletion and library membership as if the default
  library were a normal library membership the user can remove from.

That makes `Delete document` ambiguous. Removing an intrinsic default-library
save can still leave a closure-backed default row, and removing from one library
can still leave the document visible through another library.

The product should not expose those internals as surprising behavior.

## Target Behavior

### Delete Document

`DELETE /media/{media_id}` means delete the document from the authenticated
viewer's world.

For a readable document media item, the operation:

1. Removes direct default-library provenance for the viewer.
2. Removes closure provenance and materialized default-library rows for the
   viewer.
3. Removes the media entry from every non-default library where the viewer has
   admin authority.
4. Creates a viewer deletion tombstone if the media remains referenced by any
   library the viewer cannot mutate.
5. Removes viewer-owned per-media state.
6. Physically deletes the media and all derived data only when no global media
   ownership references remain.

The operation is not a best-effort sweep. Each branch is explicit, authorized,
and observable in the response.

### Remove From This Library

`DELETE /media/{media_id}?library_id={library_id}` remains the narrow operation:
remove the document from one specified library.

This path is not a backward-compatibility fallback. It is the final per-library
mutation for row actions such as `Remove from this library`.

For default libraries, the narrow operation removes only the viewer's direct
default-library intrinsic. It does not pretend to delete the document if
non-default closure or other references still exist. The UI must not present
this as `Delete document`.

### Hidden From Me

If a document remains in a shared library where the viewer is only a member, the
viewer cannot mutate that source library. The hard-delete operation therefore
creates a user-level deletion tombstone.

A tombstoned media item:

- does not appear in the viewer's library pages,
- does not appear in the viewer's search or browse-over-owned-corpus results,
- cannot be opened by the viewer through `/media/{media_id}`,
- cannot be used as a chat, quote, retrieval, or citation source for the viewer,
- does not materialize into the viewer's default library,
- can be restored only by a new explicit add/save action by the same viewer.

### Physical Delete

The media row is physically deleted only when no ownership references remain:

- no `library_entries` media rows,
- no `default_library_intrinsics` rows,
- no `default_library_closure_edges` rows.

Deletion then removes all media-derived data in the same explicit cleanup graph:

- media-scoped conversations and media message contexts,
- conversation media references,
- retrieval media links,
- highlights, annotations, and highlight anchors,
- fragments and fragment blocks,
- content chunks and embedding vectors,
- EPUB package/navigation/resource rows,
- PDF text span rows,
- transcript state/version/segment/job/audit rows,
- playback and reader state rows,
- media authors,
- media file rows,
- storage objects for original files and generated EPUB resources,
- the `media` row.

External storage deletion happens after the database transaction commits.

## Scope

This cutover applies to document media kinds:

- `pdf`
- `epub`
- `web_article`

Transcript media and podcast subscription semantics are separate product areas.
They are not changed by this cutover except where generic shared helpers need to
avoid assuming that every `media_id` is deletable as a document.

## Final State

### Product

- A document has one primary destructive action: `Delete document`.
- A library row can still expose `Remove from this library` when the viewer can
  administer that library.
- The add-content picker says `My Library` or `My Library only`, not `No
  library`, because new documents are always saved to the viewer's default
  library unless explicitly targeted elsewhere as an additional destination.
- The non-default library membership panel only edits non-default libraries.
  Default-library membership is handled by document deletion and direct save
  state, not by a checkbox that can be contradicted by closure provenance.
- After `Delete document` succeeds, the document is gone from the viewer's
  workspace. If shared references remain, they are hidden from that viewer.

### API

`DELETE /media/{media_id}` returns a typed response:

```json
{
  "status": "deleted",
  "hard_deleted": true,
  "removed_from_library_ids": ["..."],
  "hidden_for_viewer": false,
  "remaining_reference_count": 0
}
```

Allowed `status` values:

- `deleted`: the media row was physically deleted.
- `removed`: all viewer-owned/control-scope references were removed and no
  viewer tombstone was needed.
- `hidden`: the viewer's mutable references were removed, but other references
  remain, so a viewer tombstone was created.

The response does not expose hidden library names the viewer cannot administer.
It may include counts.

`DELETE /media/{media_id}?library_id={library_id}` returns the same response
shape with `scope: "library"` if a scope field is useful, but it does not perform
the all-viewer delete behavior.

### Database

Add a user deletion tombstone table:

```sql
CREATE TABLE user_media_deletions (
  user_id uuid NOT NULL REFERENCES users(id),
  media_id uuid NOT NULL REFERENCES media(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, media_id)
);
```

The table is not a soft-delete flag on `media`. It is a viewer-specific
visibility tombstone for media that cannot be physically deleted because another
library still references it.

### Authorization And Visibility

Every canonical visibility predicate excludes tombstoned media:

- `can_read_media`
- `can_read_media_bulk`
- `visible_media_ids_cte_sql`
- any source-set or retrieval query that bypasses the canonical CTE today

The cutover removes any raw default-library-entry visibility behavior. A default
library row without direct intrinsic or active closure provenance remains
unauthorized, and tombstoned media remains unauthorized for that viewer even if
shared-library membership would otherwise grant access.

### Add/Save

An explicit user add/save clears that user's tombstone for the media.

This applies to:

- upload duplicate resolution,
- from-url create-or-reuse,
- add media to default library,
- add media to non-default library,
- any future save-to-library entrypoint.

Passive events do not clear tombstones:

- accepting an invite,
- being added to a shared library,
- default-library closure backfill,
- library intelligence refresh,
- search/retrieval reads.

## Architecture

### Service Ownership

Create a document deletion service:

- `python/nexus/services/media_deletion.py`

The service owns:

- delete-plan discovery,
- viewer-world document deletion,
- per-library document removal orchestration,
- viewer tombstone creation/removal,
- hard-delete eligibility,
- explicit derived-data cleanup,
- storage path collection.

Routes stay transport-only. Next.js BFF routes continue to proxy only.

### Service API

Core service functions:

```python
def delete_document_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    *,
    storage_client: StorageClientBase | None = None,
) -> DeleteDocumentResult:
    ...

def remove_document_from_library(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    library_id: UUID,
    *,
    storage_client: StorageClientBase | None = None,
) -> DeleteDocumentResult:
    ...

def clear_user_media_deletion(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
) -> None:
    ...
```

The existing library membership service may keep lower-level helpers for
non-default closure maintenance, but the top-level document delete orchestration
belongs in the document deletion service.

### Deletion Flow

`delete_document_for_viewer`:

1. Locks the media row.
2. Verifies the media exists, is a document kind, and is readable by the viewer.
3. Locks the viewer's default library row.
4. Finds every non-default library containing the media where the viewer is an
   admin.
5. Deletes viewer default intrinsic rows.
6. Deletes viewer default closure edges for the media and GCs the default row.
7. Removes the media from each controlled non-default library through the closure
   helper, so affected members' default materialization is updated.
8. Deletes viewer-owned per-media state.
9. Counts remaining ownership references.
10. Inserts `user_media_deletions` if references remain.
11. Hard-deletes the media if references do not remain.
12. Commits.
13. Deletes collected storage objects.

`remove_document_from_library`:

1. Locks the target library.
2. Verifies admin authority for non-default libraries.
3. Verifies default-library ownership for default libraries.
4. Removes only that library's direct relationship/provenance.
5. Runs closure/default-row GC for affected default libraries.
6. Hard-deletes only if no global references remain.

### Viewer-Owned State Cleanup

When the media remains globally referenced, delete only viewer-owned state:

- reader state for `(viewer_id, media_id)`,
- playback queue items for `(viewer_id, media_id)`,
- viewer-authored highlights and annotations on the media,
- viewer-owned media-scoped conversations,
- message contexts in viewer-owned conversations that point to the media or the
  viewer-owned highlights/annotations being deleted.

When the media is physically deleted, remove all media-derived state globally.

### Intelligence And Retrieval

Removing a document from a library changes that library's source set.

The cutover must mark or rebuild affected library intelligence state through the
same source-set invalidation path used by other library membership changes. The
delete operation must not leave active artifacts claiming coverage for a removed
source.

Retrieval must use canonical visibility. Tombstoned media cannot be selected,
included in prompt context, cited, or used as scoped evidence for that viewer.

### Concurrency

Deletion uses one serialization point per media row.

Rules:

- Lock the media row before deleting references.
- Lock affected library rows before mutating their entries.
- Do not run storage deletion inside the database transaction.
- Return storage paths from the transaction and delete objects only after commit.
- If storage deletion fails after commit, log and surface a non-fatal cleanup
  warning path; do not roll back the database deletion.
- Ingest, transcript, embedding, and enrichment jobs must treat missing media as
  a terminal no-op.

## Rules

- `DELETE /media/{media_id}` never means "remove from default only".
- UI text must not say `No library` for a path that saves to the default library.
- Default library rows are implementation detail. User-visible behavior is
  direct save, inherited source membership, hidden, or deleted.
- Tombstones are checked in every media visibility path.
- Tombstones are cleared only by explicit viewer save/add actions.
- Shared libraries the viewer cannot administer are not mutated by viewer delete.
- Shared libraries the viewer administers are mutable and are included in
  `Delete document`.
- Physical media deletion requires zero ownership references.
- Derived data cleanup is explicit in application code.
- New tests assert API-observable behavior first. Raw SQL assertions are used
  only for internal cleanup guarantees.
- No compatibility shims preserve the old `DELETE /media/{id}` default-only
  behavior.

## Non-Goals

- Do not redesign library sharing roles.
- Do not add restore/undo UI in this cutover.
- Do not preserve deleted media in a soft-deleted `media` state.
- Do not change podcast subscription or podcast episode unsubscribe semantics.
- Do not change video identity or transcript-media lifecycle semantics.
- Do not add user-selectable arbitrary source sets.
- Do not keep legacy tests that assert default-library-only delete behavior.
- Do not add a second visibility stack separate from the canonical media
  permission predicates.

## Files

### Documentation

- `docs/document-deletion-hard-cutover.md`

### Database And Models

- `migrations/alembic/versions/<next>_user_media_deletions.py`
  - Add `user_media_deletions`.
  - Add indexes only if query plans require them beyond the primary key.

- `python/nexus/db/models.py`
  - Add `UserMediaDeletion`.
  - Keep FK definitions aligned with migrations.

### Backend Schemas

- `python/nexus/schemas/media.py`
  - Add `DeleteDocumentStatus`.
  - Add `DeleteDocumentResponse`.

### Backend Services

- `python/nexus/services/media_deletion.py`
  - New owner for viewer-world delete and hard-delete orchestration.

- `python/nexus/services/libraries.py`
  - Remove top-level document delete orchestration.
  - Keep or expose focused library-entry/closure helpers.

- `python/nexus/services/default_library_closure.py`
  - Add helper to remove all closure edges for one default library/media pair.
  - Ensure GC handles tombstoned media deterministically.

- `python/nexus/services/media.py`
  - Move or share hard-delete derived-data cleanup with `media_deletion.py`.
  - Generalize hard delete to `pdf`, `epub`, and `web_article`.

- `python/nexus/auth/permissions.py`
  - Exclude `user_media_deletions` from single, bulk, and CTE visibility.

- Add/save services:
  - `python/nexus/services/upload.py`
  - `python/nexus/services/media.py`
  - `python/nexus/services/libraries.py`
  - Clear tombstones on explicit viewer save/add.

### Backend Routes

- `python/nexus/api/routes/media.py`
  - Route `DELETE /media/{media_id}` to `media_deletion.delete_document_for_viewer`.
  - Route `DELETE /media/{media_id}?library_id=...` to
    `media_deletion.remove_document_from_library`.

### Frontend

- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`
  - `Delete document` calls the all-viewer delete path.
  - Show result toast based on `deleted`, `removed`, or `hidden`.
  - Navigate away after success.

- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx`
  - Row action text distinguishes `Remove from this library` from
    `Delete document`.
  - Default-library rows do not imply checkbox-style default deselection.

- `apps/web/src/components/AddContentTray.tsx`
  - Replace `No library` copy with `My Library` or `My Library only`.

- `apps/web/src/components/LibraryMembershipPanel.tsx`
  - Keep as non-default membership editor.
  - Do not special-case default library as a disabled checkbox.

- `apps/web/src/components/LibraryTargetPicker.tsx`
  - Keep selection semantics, but callers must pass accurate labels.

### Tests

- `python/tests/test_media_deletion.py`
  - New API-level deletion contract suite.

- `python/tests/test_permissions.py`
  - Tombstoned media is unreadable through intrinsic, closure, and non-default
    membership paths.

- `python/tests/test_libraries.py`
  - Remove old default-only delete expectations.
  - Add per-library removal coverage if not moved to `test_media_deletion.py`.

- `python/tests/test_upload.py`
  - Duplicate upload clears tombstone on explicit save.

- `python/tests/test_from_url.py`
  - Create-or-reuse clears tombstone on explicit save.

- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx`
  - Delete document calls the all-viewer delete path and handles all statuses.

- `apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.test.tsx`
  - Row actions use accurate delete/remove language.

- `apps/web/src/__tests__/components/AddContentTray.test.tsx`
  - The default target is labeled as My Library, not No library.

- `e2e/tests/libraries.spec.ts`
  - User can delete a document and no longer sees it in default or controlled
    libraries.

## Acceptance Criteria

### Product

- A user can delete a document from the media pane and it disappears from their
  workspace.
- A user can delete a document that is present in their default library and one
  or more non-default libraries.
- A user can delete a document that is visible only through a shared library they
  cannot administer; after delete, it is hidden from that user.
- If the user later explicitly saves the same existing media, the tombstone is
  cleared and the media is visible again.
- UI copy never says `No library` for a target that saves to the default library.
- UI copy distinguishes `Delete document` from `Remove from this library`.

### Backend

- `DELETE /media/{media_id}` no longer executes default-only removal.
- `DELETE /media/{media_id}` removes entries from all viewer-administered
  libraries containing that media.
- Default-library intrinsic and closure provenance for the viewer is removed.
- Tombstoned media fails `can_read_media` and `can_read_media_bulk`.
- Tombstoned media is absent from `visible_media_ids_cte_sql` consumers.
- Physical delete happens when ownership reference count reaches zero.
- Physical delete removes fragments, chunks, embeddings, EPUB/PDF artifacts,
  transcript artifacts, highlights, annotations, media files, and the media row.
- Storage object deletion runs after DB commit.
- In-flight jobs no-op cleanly when media has been deleted.

### Testing

- Targeted backend tests pass for deletion, visibility, tombstone clearing, and
  hard-delete cleanup.
- Targeted frontend tests pass for media delete UI and add-content label changes.
- Existing library, media, upload, from-url, permission, search, and conversation
  tests are updated to the final semantics.
- E2E covers delete from default plus non-default libraries.

## Key Decisions

1. `DELETE /media/{id}` is redefined as viewer-world document deletion.
2. A user deletion tombstone is required to satisfy "remove it from my stuff"
   when shared references remain.
3. Tombstones are visibility-level authorization inputs, not UI filters.
4. Physical media deletion is reference-counted by ownership/provenance rows.
5. Default-library closure is no longer exposed as a user-editable checkbox.
6. Explicit save/add clears a tombstone; passive membership/backfill does not.
7. Hard delete is generalized from PDF/EPUB to document media:
   `pdf`, `epub`, and `web_article`.
8. The implementation removes old semantics instead of preserving compatibility.

## Implementation Plan

1. Add `user_media_deletions` migration and ORM model.
2. Add deletion response schema.
3. Add canonical tombstone exclusion to media permission predicates and visible
   media CTE.
4. Extract hard-delete cleanup into `media_deletion.py` and generalize document
   hard deletion.
5. Implement `delete_document_for_viewer`.
6. Implement scoped `remove_document_from_library` in the same service.
7. Update media route wiring.
8. Clear tombstones in every explicit add/save path.
9. Update frontend delete/remove language and add-content target copy.
10. Add backend contract tests.
11. Add frontend behavior tests.
12. Add E2E coverage.
13. Remove obsolete tests and code paths that asserted default-only delete.
14. Run targeted suites, then full verification.
