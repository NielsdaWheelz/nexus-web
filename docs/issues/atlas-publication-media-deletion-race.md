# atlas publication during media deletion is unqualified

`python/nexus/services/atlas.py:82–119` loads media vectors, computes the frame,
then upserts the original media ids. an api deletion can remove one of those ids
during computation. the sole background worker serializes sweeps, not api writes.
the position's foreign key rejects a missing media id
(`migrations/alembic/versions/0306_baseline_schema.sql:5292`). this could fail the
whole refresh; the previous serializable implementation's behavior is unverified.

reproduce a real deletion between source selection and publication, then verify
the refresh completes coherently without stale foreign keys or losing its exact
job claim. decide whether publication should omit removed ids or recompute after
a narrowly owned retry. no failure has yet been observed for this interleaving.
