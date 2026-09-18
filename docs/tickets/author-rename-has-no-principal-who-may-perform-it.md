# author rename has no principal who may perform it

status: open (decision needed) · origin: 2026-09-18 owner decisions (D145 review)
· area: contributors

renaming an author was gated on the viewer holding the `admin` JWT role. that
role was never issued and its plumbing is now deleted (oi-145), so the rename
feature is dead end to end while still present end to end: `PATCH
/contributors/{handle}` (`python/nexus/api/routes/contributors.py`) can only
404-or-403 and parses a body it then ignores; `canRename` in
`ContributorDetailOut` is a constant false; the `RenameContributor` capability
in `services/resource_items/action_snapshots.py` is permanently
PermissionDenied; and the web dialog, its client (`lib/contributors/api.ts`),
the BFF proxy (`app/api/contributors/[handle]/route.ts`) and the action-catalog
entries all remain, unreachable because the intent is gated on `canRename`.

decision: delete the rename feature end to end, or grant it to a real
principal (afaict the only candidate on a single-user box is "any
authenticated viewer"; under multi-user it would want a library-membership
role, which is a different authority than the one it was written against).

fix: if delete — remove the route, the request schema, `canRename`, the
capability arm, `ensure_contributor_display_name`, the dialog, the client, the
proxy and the catalog entries in one change. if grant — replace the constant
false with the chosen predicate and leave the rest.

acceptance: no capability is emitted that no principal can ever hold.
