# unresolved admission recovery expires with its hud

status: open
origin: 2026-10-16 feedback design audit; source at `69c00182c832`
area: web / source refresh and metadata admission

problem: an unknown command outcome keeps its exact confirmation request only
in an expiring notification action. dismissing or expiring the notification
removes that recovery without establishing whether the command was accepted.

evidence: `apps/web/src/lib/imports/api.ts:205-229` captures
`expectedAttemptId` in a `Hud` confirmation callback;
`apps/web/src/lib/media/mediaMetadataOperations.ts:150-174` does the same with
`expectedJobId`. `apps/web/src/components/feedback/Feedback.tsx:141-145`
expires actionable huds after ten seconds; `:155-161` can evict one when a
fourth arrives. metadata observation can reveal a landed operation, but it does
not retain the original confirmation command. this is source analysis, not a
live duplicate-operation reproduction.

prerequisites: preserve the existing expected-attempt/job replay contracts.
fix: follow the feedback plan (#650): persist the frozen
account-scoped intent before sending, retain it across reload/restart, and
render recovery from the operation owner. this guarantee covers these two
admissions only. hiding a presentation must not discard the unresolved command;
settle it only from authoritative evidence. no abandonment command is included.

acceptance: lose an admission response, wait beyond ten seconds, publish a
receipt burst, close the originating pane, reload, and restart the same browser
profile. the same confirmation command remains available until settlement;
confirming cannot admit fresh work by using a newly observed attempt/job
identity. startup sends nothing; concurrent tabs and account switching retain
the plan's operation/account isolation.
