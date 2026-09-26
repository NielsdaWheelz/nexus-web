# chat operator-defect copy invites a new command

status: local fix; authenticated browser proof pending · origin: 2026-09-25 chat reliability review · area: chat recovery copy

at `cfa27d6ce615bb4775e7784954f19dcdd8c8ebb1`,
`apps/web/src/lib/llm/failure.ts:30-35,70-71` tells the user to try again in a
new message for an operator defect or missing representable failure.
`apps/web/src/lib/conversations/chatFailureContract.ts:38-45` correctly
requires rerun to be unavailable for the operator-defect variant.

a new message is a new command. additive tool effects may already exist;
inviting a fresh command bypasses the intended recovery guidance. this is a
source-confirmed copy defect, not a demonstrated cause of the reported pane
crash.

fix the existing failure-copy owner to explain that the response requires
repair/recovery, retain its support occurrence, and avoid promising that a new
send is safe. no new retry mechanism is needed.

acceptance: the operator-defect and generic-defect cards neither offer nor
instruct a fresh send; normal eligible rerun and reconnect remain distinct.
