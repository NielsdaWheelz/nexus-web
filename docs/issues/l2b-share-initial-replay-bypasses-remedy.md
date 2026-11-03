# sharing initial controls bypass held recovery

problem: an unresolved same-key create or revoke remains enabled in the initial
sharing controls. controller.start calls send(existing), so this initial entry
replays the frozen command while its Hold projects Update/sign-in/offline recovery.

impact: the visible action and actual resend policy disagree. Update must offer
its actual remedy alone; sign-in and unsent gates belong to the shared recovery
projection. api refusal or a guarded reload does not repair this entry mismatch.
this is not the fixed retired-control identity defect and does not lose bytes.

evidence: integration67a861c9d6e44ae73b9463373a90fe0d629719bc;
ShareOverlay.tsx:321-341,486-490 leaves pending same-key idle controls enabled;
lib/sharing/controller.tsx:141-145 sends existing; Feedback.tsx:239-251 instead
projects Update alone, actual sign-in, or gated resend. source-only adjudication.

resolve: disable initial create/revoke controls whenever their command is pending;
initial start returns without sending when one is unresolved. keep the exact
held-request retry path and current shared remedies. no stage/lifecycle change.

proof: initial controls and stale initial callbacks send nothing during unknown,
including Update/sign-in/offline; the actual Hold remedy works, and its deliberate
retry resumes the same id/body when admitted. original new commands still work.
