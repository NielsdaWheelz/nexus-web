# dossier revision user links die on regenerate

status: open · origin: 2026-09-28 cleanup pr-08 (cleanup/dossier-latest-revision) · area: dossiers / resource graph

a head carries only its current revision: a successful regenerate gives it a
new `revision_id` and deletes the replaced revision's edges
(`python/nexus/services/dossier/engine.py` `publish`). `artifact_revision` still admits user
links (`python/nexus/services/resource_items/capabilities.py:378-381`,
`user_link_target="direct"`, `user_link_source=True`), and a user link is a bare
edge, so a link to or from a revision silently disappears at the next
regenerate.

fix: make `artifact_revision` a non-link resource (`user_link_source=False`,
`user_link_target` none) so users link the stable `artifact` head; regenerate
`resourceCapabilities.ts`.

resolved when: no user link can name an `artifact_revision`, or regenerate
re-points such links to the head.
