# atlas star query reads an unused position timestamp

status: open · origin: 2026-10-02 atlas representation repair · area: atlas / query

`python/nexus/api/routes/atlas.py:61,68` still selects/groups `p.computed_at`.
the route no longer reads it: its tag hashes the rendered response body.
this leaves an unnecessary selected column/group key. the sql was retained
to keep this cache repair from incidentally changing unordered array output.

fix: remove the timestamp from select/grouping after qualifying actual array
and browser presentation order. no new ordering framework is needed.

acceptance: authorization, returned values and relevant array/presentation order
remain qualified; the star query no longer reads the timestamp.
