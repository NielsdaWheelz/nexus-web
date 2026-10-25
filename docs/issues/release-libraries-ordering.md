# release: libraries + suggestions + ordering re-slice

status: #693 already shipped in production `dc12792e0` (schema 0312, wire 14);
the two residue counts below remain unrecorded
origin: 2026-10-19 libraries + suggestions + ordering re-slice (branch
`cleanup/libraries-ordering-reslice`)
area: release / libraries, lectern, suggestions

#693 needed no migration, env change, job payload change or `X-Nexus-Wire` bump: the
removed response keys (`LibraryOut.system_key/created_at/updated_at`, suggestion
targets' `image_url`, publications' `as_of/input_revision`) are read by no web,
apk or extension client. web and api shipped together. the re-slice left
`GET /lectern` and the apk unchanged; its extension payload includes the chooser's
name-rule copy.

remaining census: on a current restored backup (read-only), count the residue the
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

delete this file once both counts are recorded.
