# release: libraries + suggestions + ordering re-slice

status: unreleased; steps owed by the release that ships it
origin: 2026-10-19 libraries + suggestions + ordering re-slice (branch
`cleanup/libraries-ordering-reslice`)
area: release / libraries, lectern, suggestions

no migration, no env change, no job payload change, no `X-Nexus-Wire` bump: the
removed response keys (`LibraryOut.system_key/created_at/updated_at`, suggestion
targets' `image_url`, publications' `as_of/input_revision`) are read by no web,
apk or extension client (main is at wire 13). web and api deploy together. the
apk is unaffected (`GET /lectern` unchanged). the extension keeps working; its
next signed build carries the chooser's name-rule copy.

before deploy: on the newest restored backup (read-only), count the residue the
fix leaves and record it in
[lectern-rows-of-removed-media-linger](lectern-rows-of-removed-media-linger.md)
(C4 `tombstoned_rows`: lectern rows of media their viewer removed) and
[suggestion-feeds-of-former-admins-linger](suggestion-feeds-of-former-admins-linger.md)
(C6 `without_admin`: library feeds whose user no longer admins the library):

```sql
SELECT count(*) AS tombstoned_rows FROM consumption_queue_items q
JOIN user_media_deletions umd ON umd.user_id = q.user_id AND umd.media_id = q.media_id;

SELECT count(*) AS without_admin FROM suggestion_feeds f
LEFT JOIN memberships m ON m.library_id = f.library_id AND m.user_id = f.user_id
WHERE f.library_id IS NOT NULL AND m.role IS DISTINCT FROM 'admin';
```

owner smoke after deploy:

- add two items to the lectern from two rows quickly: both land, no "lectern
  changed".
- reorder the lectern and a mutable library by dragging title, metadata and
  padding; reload confirms the order. no grips, movement menus or alt-arrow
  movement remain. existing opening targets and independent controls still work.
- on physical android, quick row swipes scroll and pull to refresh; a 250ms hold
  drags. once activated, cancellation or a second finger prevents writes,
  opening and refresh until a fresh gesture. track outstanding device qualification in
  [index-row-drag-physical-android-unverified](index-row-drag-physical-android-unverified.md).
- delay or interrupt a move: "order not confirmed" offers "check order";
  recovery preserves the original command and newer focus.
- Remove from Nexus an item on the lectern: it leaves the lectern.
- in a library that files a show, "suggested for this library" never lists the
  show's episodes.
- demote a co-admin: their library suggestions go.
- Refresh on the lectern with suggestions healthy: "refresh requested".
- create a library from the index header (enter opens it in that pane,
  shift-enter in a new one), from Add's destinations and from "Libraries…"; the
  extension popup's destinations; the phone lectern sheet.

delete this file once the release has run these.
