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

before deploy: run `nexus-web-campaign-artifacts/2026-10-18/libs2/census/residue.sql`
on the newest restored backup (mac only) and update
[lectern-rows-of-removed-media-linger](lectern-rows-of-removed-media-linger.md) and
[suggestion-feeds-of-former-admins-linger](suggestion-feeds-of-former-admins-linger.md)
with its C4 `tombstoned_rows` and C6 `without_admin`.

owner smoke after deploy:

- add two items to the lectern from two rows quickly: both land, no "lectern
  changed".
- reorder the lectern and a library (drag, menu, alt+arrow).
- Remove from Nexus an item on the lectern: it leaves the lectern.
- in a library that files a show, "suggested for this library" never lists the
  show's episodes.
- demote a co-admin: their library suggestions go.
- Refresh on the lectern with suggestions healthy: "refresh requested".
- create a library from the index header (enter opens it in that pane,
  shift-enter in a new one), from Add's destinations and from "Libraries…"; the
  extension popup's destinations; the phone lectern sheet.

delete this file once the release has run these.
