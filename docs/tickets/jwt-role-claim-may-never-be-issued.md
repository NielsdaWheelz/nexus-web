# the jwt role claim the viewer reads may never be issued

status: open (decision needed) · origin: 2026-09-17 slop sweep (claude session)
· area: auth middleware · oi-145

`python/nexus/auth/middleware.py:84-115` reads five claim locations
(`nexus_roles`, `roles`, `role`, `app_metadata.roles`, `app_metadata.role`) and
`_normalize_role_values` recursively accepts str, comma-separated str, list,
tuple, set and frozenset. the deployment pins one supabase project by issuer and
audience, so at most one shape can ever arrive.

nothing in `python/`, `migrations/`, `scripts/` or `deploy/` sets `nexus_roles`
or grants an admin JWT role. every `'admin'` literal in the tree is a
library-membership role (`db/models.py:147,157`, `auth/permissions.py:12`,
`library_governance.py`) — a different concept. supabase's default access token
carries `role: "authenticated"`, which would make `'admin' in viewer.roles`
already always false and the admin branches at `api/routes/imports.py:38,54` and
`services/contributors.py:837,1040` dead with it.

decision: does the deployed supabase project issue a custom role claim? likely
not.

prerequisite: inspect one live access token, or the project's auth hook
configuration. the repo cannot answer this and hard-coding the wrong claim is
worse than the present branching.

fix: if no claim is issued, delete `_normalize_role_values`,
`_extract_viewer_roles`, `Viewer.roles`, the `is_admin` parameters at
`api/routes/imports.py:36-54` and `services/contributors.py:283,837,1040`, and
`can_rename_contributor` — about 60 lines. if a claim exists, collapse to that
one lookup and normalise inline.

acceptance: the viewer's role set has one source that the deployed issuer
demonstrably produces, and no admin branch is unreachable.
