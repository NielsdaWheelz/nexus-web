# index and outline release qualification

source now separates index and outline rows, canonical metadata, versioned editing
and relationship actions. contracts live in [resource references](../modules/resource-references.md)
and [notes](../modules/notes.md). production activation is outside this change.

remaining release work:

- qualify physical android soft-keyboard up/down, caret/selection retention,
  modal/pane ownership and player/nexus clearance. qualify supported ios geometry
  separately. chromium touch and enlarged-text emulation is not handset proof;
  no attached handset or native input was observed in this task.
- verify the actual deployed wire revision before pairing api/web and other
  clients. source retains revision 13 under the existing unreleased-break records
  (`release-reader-connections.md`, `release-collection-loading.md`). those records
  conflict with `release-records-deployed-baseline.md`, whose 2026-10-21 host
  inspection found wire 11 at `8a67e218a`; this task made no host inspection.
  if 13 has since shipped, apply the once-between-releases rule before release.
- finish the production inventory, explicit repairs, stopped-writer backup and
  migration/postflight in [link-note removal](release-link-note-removal.md).

resolved when device qualification and the paired production cutover are observed.
record refusals and unavailable devices explicitly; they are not passes.
