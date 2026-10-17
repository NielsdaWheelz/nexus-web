# chat viewer conditional-write cutover

status: pending release-owner rollout
origin: 2026-10-16 approved chat viewer specification
area: release / chat

the existing-chat revision contract changes request requirements. controls
merged as `46f000a6b` with wire 4 and migration head 0288. the viewer requires
wire 5 and migration 0289 (`chat_branch_revision`); no controls migration was
added. merge alone does not deploy this breaking client/server contract.

release prerequisites and steps:

- settle in-flight old commands before replacing writers. preserve unsent
  drafts. never upgrade an unresolved old request by adding today's revision
  or a new run id. diagnose unresolved old browser commands under the separate
  creation/recovery contract before replaying them.
- use the normal deployment owner's backup and stopped-writer migration
  procedure. 0289 initializes branch revisions and materializes effective
  leaves while retaining messages, runs and selections. it raises on invalid
  graphs and has no downgrade; restore the verified backup if needed.
- pair api, web, extension and apk under wire 5, verify schema head 0289, then
  reload old browser clients. missing preconditions fail; there is no old-client
  compatibility path.

this work is excluded from the book-repair release pinned to
`f4026846f857fd137e9c9e170faba05f07c5e282`. the release coordinator retains
canonical rollout and book production writes. no merge hold, protection change,
resize, reboot or browser configuration change belongs to this work.

acceptance: the independently qualified viewer candidate serves the matching
wire/schema; old requests fail explicitly; migration preserves effective paths;
no viewer change enters the book-repair release by incidental main merge.
