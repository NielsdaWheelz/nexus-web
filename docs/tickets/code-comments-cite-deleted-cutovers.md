# code comments cite deleted cutover docs

status: open · origin: 2026-09-28 pr-06 library placement reauthoring (cleanup/library-placement, claude session); narrowed 2026-10-09 web dead-code sweep · area: python comments and the capabilities generator

`docs/cutovers/` does not exist. the hand-written web citations were rewritten
on 2026-10-09 (cleanup/web-dead-code). these remain, by path or by name:

- `python/scripts/generate_resource_capabilities.py:93` emits
  `// docs/cutovers/resource-inspector-and-universal-dossiers-hard-cutover.md`
  into the generated `apps/web/src/lib/resources/resourceCapabilities.ts:35`,
  so it can only be fixed in the generator.
- `python/nexus/schemas/presence.py:1` (python twin of `apps/web/src/lib/presence.ts`,
  whose citation was already removed).
- `python/nexus/db/models.py:784,1373,1412,1743`.
- `python/nexus/db/retries.py:21-24`.
- `python/nexus/services/passage_anchors.py:4`.
- `python/nexus/services/resource_mutation_replay.py:2`.

impact: a reader following the comment finds nothing; the rule it points to
lives only in the code.

fix: state the rule in the comment (or drop the citation); regenerate after the
generator change.

resolved when: `git grep -n -E 'cutovers/|cutover(\.md| §|\))|hard-cutover' -- apps python android`
is empty.
