# library chooser plan references retired owners

status: open · origin: 2026-10-16 principal-actions specification · area: documentation / library chooser

problem: the chooser spec cannot be implemented literally against current source.
`docs/library-chooser-plan.md:115` requires reusing `resource_mutation_replay.py`
and `resource_mutations` without a migration; migration
`migrations/alembic/versions/0286_drop_resource_mutations.py` removes that table.
its file map at `:164` and copy owner at `:53` also name retired library/action
modules. current owners include `lib/libraries/{api,errors}.ts`,
`lib/actions/{project.tsx,ResourceActionsProvider.tsx}` and
`python/nexus/services/libraries.py`.

prerequisite: refresh the chooser's source audit before implementation. reconcile
its receipt/storage design explicitly with the current command contract; do not
silently recreate a removed ledger or compatibility paths. this principal-action
cutover does not own destination placement recovery.

acceptance: the chooser plan names extant or explicitly new owners, states any
required migration, and has no claimed reuse of removed infrastructure.
