# activity upload clientMutationId is a wire no-op

status: open · origin: 2026-09-17 slop sweep (claude session), svc-consumption CONS-3 · area:
consumption activity · oi-170

the activity-capture replay memo in `resource_mutations` is gone, so
`ActivityRecordIn.client_mutation_id` (`POST /api/consumption/activity`) is
read by nothing. it cannot be dropped from the schema yet: `_IN_CONFIG` is
`extra="forbid"` and the shipped android client
(`NativeActivityOutbox.kt`) posts `clientMutationId` in the body, so
removing the field would 422 every activity upload from an installed app.
the web client keeps sending it for the same reason.

impact: one dead wire field and one dead `mutationId()` mint per upload on
web and android; no user-visible defect.

resolved when: an android release stops sending `clientMutationId`, after
which the schema field, the web mint, and this ticket go.
