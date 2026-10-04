# saved epub contributor repair awaits production preview

status: open; production preview/apply NOT_RUN
origin: 2026-10-04 utc, pr #482 closure
area: epub source contributors

tracking: [github #486](https://github.com/NielsdaWheelz/nexus-web/issues/486)

problem: saved epubs may retain historical misclassified or split contributor
observations. the parser and guarded repair are implemented and locally qualified;
production repair remains unperformed. [verification](../metadata-enrichment-verification.md)
records historical unchanged owner checks for epub2/3 roles, identity,
manual/mixed-source protection, refusal and guarded preview/apply. no new
implementation is required by this ticket.

prerequisites: separately authorized [aligned release](production-release-pending-since-7dc68929b.md)
and verified backup; identify the creator/viewer and target saved items; retain
bounded, checksum-verifiable originals. review the production preview before apply.

fix: follow [the source repair contract](../modules/epub.md#contributor-observations-and-saved-repair).
`python/scripts/repair_epub_contributors.py --viewer-id <uuid> [--media-id <uuid>]`
previews. add `--apply` only after the reviewed preview and separate authorization.
use the existing source/credit fences and contributor owner; no research job or
reader reingestion.

acceptance: correct only uniquely matched historical `epub_opf` observations.
explicitly skip ambiguous matches, changed sources/credits and previously split names.
preserve unrelated/manual credits, person identity, reader publications,
fragments, navigation, progress, index generations and `metadata_enriched_at`.
retain the production report with media ids, moved/added credits, skip reasons
and before/after counts.
