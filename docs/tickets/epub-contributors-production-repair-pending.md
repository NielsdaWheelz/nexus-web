# saved epub contributor preview is a guarded owner-scope no-op

status: bounded audit planned; historical owner preview complete, no changes
origin: 2026-10-04 pr #482 closure; 2026-10-14 release r4 disposition
area: epub source contributors

tracking: [github #486](https://github.com/NielsdaWheelz/nexus-web/issues/486)

the actual source-only preview covered the release owner's 244 visible saved
epubs: five unchanged, 239 guarded `unmatched_creator` skips, zero proposals.
no apply was needed or submitted for this guarded no-op. current credits and
metadata were not rewritten. a skip is not evidence that the source credits
are globally correct; this result closes only the inspected viewer scope.
remaining book contributor repairs were explicitly deferred from the usable release.

evidence: `release/attempts/58c7ecae6/r4-full-row-census-v1/stdout.jsonl`, sha256
`68a47fd964498313da48d2b24e5eb6e67b849572a665275b993f1485e0c97841`;
`scope-reconciliation.out`, sha256
`35c7640e04f01fff7e47eefbde27b6f1ceab412b1ceb7c782c501e2b5a6b5d66`.
one legacy source author belongs to another viewer's visible epub; its
[source preview is owner-deferred](legacy-epub-credit-outside-owner-scope.md).
this is not global all-saved-credit repair closure.

the parser and guarded repair were already implemented and locally qualified
by pr #482. follow [the source repair contract](../modules/epub.md#contributor-observations-and-saved-repair)
through `python/nexus/services/epub_contributor_repair.py` and
`python/scripts/repair_epub_contributors.py --viewer-id <uuid> [--media-id <uuid>]`.
no new implementation or broadened source guard is justified by the no-op.

2026-10-14 decision: audit the original 244 ids and only the other-viewer
frankenstein under the [book-repair plan](../book-repair-plan.md). the owner
accepts source-proved unchanged or evidenced unresolved dispositions; proving
every displayed credit correct is outside scope. no new apply has run.

next: verify original sources and actual credit rows; reconcile all requested
ids even when the cli omits invisible/missing items. if a correction exists,
first implement the [reviewed-preview fence](epub-contributor-apply-does-not-bind-preview.md).
rehearse it on a restored copy. do not file another viewer's media into the
owner's library or guess a person identity to create eligibility.

acceptance: a source-proved disposition for the explicitly selected scope.
correct only uniquely matched historical `epub_opf` observations; skip ambiguity,
changed sources/credits and previously split names. preserve manual/unrelated
credits, person identities, reader publications/fragments/navigation, progress,
index generations and `metadata_enriched_at`. retain exact changed-row and
protected-state evidence for any future apply.
