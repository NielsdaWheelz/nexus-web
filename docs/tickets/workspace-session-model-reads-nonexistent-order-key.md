# workspace session model reads a nonexistent order key

status: open · origin: 2026-10-02 isolated search baseline · area: workspace / database

`python/nexus/db/models.py:2760` maps `WorkspaceSession.order_key`, but the
fresh schema migrated through 0252 has no such column. the table in
`migrations/alembic/versions/0236_baseline_schema.sql:2664` contains only
id, user_id, device_id, state, created_at and updated_at; no later migration
adds an order key.

on baseline `56b889bdc6708d2d913982e22e7566a141b024d6`, signing into the
isolated web invokes `/me/workspace-session` and the api logs
`psycopg.errors.UndefinedColumn: column workspace_sessions.order_key does not exist`.
receipt: `/tmp/nexus-search-cleanup-api.log`; fresh task database
`nexus_search` on port 55460 reports alembic `0252`.
the full orm-vs-schema column audit found this as the sole missing mapped
column; receipt: `/tmp/nexus-search-cleanup-orm-schema-audit.txt`.

prerequisite and fix: confirm whether workspace sessions own ordering; remove
the stray mapped field if no consumer needs it, otherwise add its owned schema
change. do not patch the qualification database to conceal the mismatch.

acceptance: workspace session get and save succeed against a freshly migrated
database, using the ordinary authenticated web path.
