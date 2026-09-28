# code comments cite deleted cutover docs

status: open · origin: 2026-09-28 pr-06 library placement reauthoring (cleanup/library-placement, claude session) · area: web / python comments

`docs/cutovers/` does not exist, but 25 code comments still name a
`docs/cutovers/*.md` file as the owner of a rule, e.g.
`apps/web/src/components/libraries/LibraryChooserSurface.tsx:38`
(`library-chooser-interaction-hard-cutover.md §6`) and
`apps/web/src/lib/libraries/placementRevision.ts`. `grep -rn docs/cutovers
apps/web/src python` lists them (23 web files, `python/nexus/db/models.py`,
`python/scripts/generate_resource_capabilities.py`). the two
`*-docs-reference-deleted-cutovers` tickets cover docs only.

impact: a reader following the comment finds nothing; the rule it points to
lives only in the code.

fix: when each file is reauthored, state the rule in the comment (or drop the
citation) instead of pointing at a deleted file.

resolved when: `grep -rn docs/cutovers apps/web/src python android` is empty.
