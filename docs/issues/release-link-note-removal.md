# removing link notes requires a production data cutover

migration `0308_link_note_removal.py` converts validated recorded attachments to
ordinary user links. it preserves edge ids, endpoints, creation times, ranks and
note content and authored identity bindings; it retires relationship-specific meaning without reconstructing a
former parent. invalid/invisible attachments, unordered collisions and conversation
endpoints refuse atomically. downgrade requires the verified backup.

source endpoints, schemas, editors, motif readers/cleanup and annotation guards
are removed. populated disposable rehearsal preserves authored content and existing
highlight annotations, checks endpoint/suggestions revisions, and confirms atomic
refusal. this is not a restored production-backup rehearsal or live conversion.

before release:

- inventory exact `origin='link_note'` rows and migration refusals against current
  production data. repair each refusal explicitly; no automatic merge/remint.
- resolve conversation attachments deliberately: changing origin can change future
  context admission/order (`services/resource_graph/context.py`).
- rehearse against current production data before release. stop writers, verify
  the release backup, migrate after authored identities at 0307, and check retained prose,
  exact edges/ranks, endpoint versions and absence of the old origin afterward.
- deploy paired readers/writers; leave pending/running historical indexing jobs
  unchanged. use backup restore for rollback.

resolved when actual production inventory, rehearsal, backup, migration and
postflight are complete. production data population remains uninspected here.
