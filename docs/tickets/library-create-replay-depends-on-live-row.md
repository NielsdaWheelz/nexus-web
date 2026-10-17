# library creation replay depends on a mutable live row

status: open · origin: 2026-10-14 library chooser specification; refreshed 2026-10-16 · area: api / library creation replay

problem: replaying an accepted create can recreate a library after deletion. the original command has no independent receipt. rename now returns the current row and is not the earlier reported name-conflict case.

evidence: `python/nexus/services/libraries.py:159-191` inserts when the id is absent, or returns the current ordinary library for that id/owner. `migrations/alembic/versions/0286_drop_resource_mutations.py` removed the previously proposed replay ledger. source-derived hazard; no live mutation performed.

prerequisites: preserve the existing create endpoint, normalized name rules and owner-admin transaction. coordinate the shared command boundary with `docs/libraries-creation-plan.md`; its dialog work does not own backend replay.

fix: specify creation replay lifetime at its domain owner. if historical replay is required after deletion, add an explicit durable identity/receipt contract committed with creation; do not claim reuse of the removed ledger. reconcile the chooser plan before implementation. this work is separate from principal-action presentation and the creation dialog.

acceptance: exact replay after rename/deletion returns the original receipt without writing, never restores the deleted library, and different payload with the same id conflicts. concurrent original/retry deliveries create once. current inventory remains the authority for present existence/name.
