# unconfirmed lab maintenance leftovers remain retained

problem: the capacity window authorized the desktop resize/restart, not removal
of old services or data. unconfirmed candidates remain intact; their cleanup is
conditional and does not block the 8 gib/8 cpu lab budget.

operator inventory at 2026-10-22T17:45:40Z found seven containers (five running)
in the exact old supabase projects `nexus-simplify-04` and
`nexus-search-cleanup-20261002`, plus these nine candidate volumes:

- `supabase_db_nexus-simplify-04`
- `supabase_db_nexus-search-cleanup-20261002`
- `nexus-test-21d4302262991123_minio-test-data`
- `nexus-test-21d4302262991123_postgres-test-data`
- `nexus-test-81b7d2e67326829d_minio-test-data`
- `nexus-test-81b7d2e67326829d_postgres-test-data`
- `nexus-pr203-runner-cache`
- `nexus-pr203-runner-go`
- `nexus-pr203-runner-playwright`

the old test projects also have eight stopped supabase siblings beyond the
volume-reference subset. runner cache/playwright volumes are also referenced by
the preserved `nexus-chat-verify-96e50bdb`, not only `nexus-pr203-runner`.
private inventory and review are retained in `.nexus-local/slice6/maintenance-d6-*`.

impact: old services and data continue to consume host resources. no candidate
is safe to retire solely because it is stopped or appears in this inventory.

resolved when: the owner explicitly disposes of the exact candidates, with all
container references and identities revalidated before scoped nonforced removal,
or chooses their continued retention. preserve all unconfirmed resources;
`c3rh-pg` and its data remain retained release-rehearsal state. no global prune.
