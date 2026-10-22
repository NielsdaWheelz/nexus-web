# index and outline release

source separates index and outline rows, canonical metadata, versioned editing
and relationship actions. contracts live in [resource references](../modules/resource-references.md)
and [notes](../modules/notes.md). production activation is outside this change.

- pair current api/web and other clients at wire 14, already advanced by
  [durable writing](release-writing.md) after the october 22 wire-13 release.
  old writers must stop with api/workers; do not translate old requests.
- apply `0308_link_note_removal` after `0307_authored_identities` using the normal
  stopped-writer/verified-backup release controller. finish the exact inventory,
  explicit repairs and postflight in [link-note removal](release-link-note-removal.md).
- qualify physical soft-keyboard up/down, caret/selection retention, modal/pane
  ownership and player/nexus clearance for the new accessory. chromium touch and
  enlarged-text emulation is not handset proof; this task observed no native input.

resolved when the paired source and data cutover ship and the new accessory's
physical input limits are observed or explicitly dispositioned by the owner.
