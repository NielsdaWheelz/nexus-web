# release manual author editing removal

scope: remove the author editor, public write and persisted pin. credits are
preserved; no bulk research or repair. production release remains pending.
candidate migration: `0313_remove_author_editing.py`, from `0312` to `0313`.

at implementation start, the deployed api image records source
`400e7039e07387b08c23d13d113f9c14a1646bcf` (wire 14); baseline
`2d1801b6530728a58dfe2532aca9df949962114d` already carries wire 15.
this change shares that bump. recheck release state before activation.

read-only production inventory on 2026-10-23 at schema 0312 found zero pinned
media and zero media with user-origin author credits. the private inventory is
`.nexus-local/author-removal-preflight.json` in the implementation worktree.
repeat it under stopped writers before migration; this observation is not the
final release freeze.

before release, on the actual release candidate:

- identify the actual migration head/parent and rehearse the populated migration
  using existing tooling. one migration drops only the pin column; recovery
  restores the verified backup, not an invented reconstruction of pin values.
- inventory pinned media, including empty author slices, and media with
  `source='user'` author credits, including unpinned media. retain exact ids,
  population membership, counts/overlap and current credit tuples privately for
  later repair. do not put corpus data or credentials in repository docs.
- apply the existing once-per-release `WIRE_REVISION` rule against actual
  release state. regenerate wire types and pair web/api plus native/extension
  artifacts wherever an actual bump requires it; no compatibility arm.
- use the existing deployment controller: stop writers, verify backup and
  ancestry, apply the migration, and confirm the exact expected head. freeze
  the final inventory while writers are stopped.

postflight: before restarting writers, compare inventoried attribution and
associated identity/graph/source/reader/history state with the frozen preflight
snapshot; only the pin column/schema revision changes. resume candidate writers
after preservation checks pass. the removed write answers ordinary 404 at the
current wire; actions and current responses expose no manual feature.
ordinary source/research publication can replace formerly pinned authors. keep
the private inventory for later evidence-based repair; enqueue no corpus sweep.

resolved after populated rehearsal, candidate qualification and actual release
postflight pass. record operational proof in the pr/release handoff; delete this
issue when complete. attribution defects and live research qualification retain
their separate records.
