# Imports standalone media branch excludes only the viewer's own published uploads

**Status:** open (contract wording to settle; behavior pinned by proof)
**Origin:** 2026-09-09, imports workspace hard cutover, Track C2 (reviewer finding)
**Area:** `python/nexus/services/imports.py` (`import_refs` CTE),
`docs/cutovers/imports-workspace-hard-cutover.md`, the implementation contract §4

## What is unsettled

The spec says "Exclude those media from the standalone Media branch" and
"Preserve existing visibility/owner authorization on every query and action".
The contract §4 restates the exclusion as "is not any session's
`published_media_id`". The query excludes a media from the standalone branch
only when one of **this viewer's** upload sessions published it
(`services/imports.py`, `import_refs`: `NOT EXISTS (... FROM upload_sessions s
...)` over the viewer-scoped `upload_sessions` CTE).

The two readings differ for a sharee: a viewer who can read a media another
user uploaded (a library sharee) has no upload session for it. Under the
implementation the sharee sees `media:<id>` — the same row every URL-sourced
media gives a sharee, with `unavailable_reason: NotOwner`. Under the contract
wording the sharee sees nothing for that media, so an upload-origin media a
sharee can read would be the one kind of import invisible to them.

The implementation's reading is pinned by
`python/tests/service/test_imports.py::test_a_sharee_sees_a_published_upload_as_the_media_it_can_read`
(creator sees `upload:<handle>` only; sharee sees `media:<id>` only; no viewer
counts it twice).

## Proposed resolution

Amend the contract §4 sentence to "is not the `published_media_id` of any of
the viewer's own sessions", which is the spec's visibility rule applied to the
union. If the other reading is wanted, change the `NOT EXISTS` to range over
every session and invert the sharee assertions in the named case above.

## Acceptance

The contract and the named case agree, and the deviation entry in the Track C2
report is closed.
