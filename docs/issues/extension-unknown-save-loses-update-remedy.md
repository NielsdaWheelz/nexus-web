# an unknown capture hides the extension update remedy

at feedback integration `e47819e34`, an earlier unknown create or confirmation
keeps recovery `Check` through a later 426 (`apps/web/src/extension/background.ts:1057`).
`CaptureFailureFact` handles `Check` before inspecting the new failure
(`apps/web/src/extension/popup.tsx:497-500`): it presents the original uncertainty
with retry/forget, omitting the update instruction. the independently packaged
extension cannot recover by reloading the old page or retrying the same wire.
this is source evidence; a live extension reproduction remains unrun.

retain the original uncertain command and fact, but present the actual extension
update remedy without resend or secondary actions while that remedy applies.
first-attempt 426 must also offer only its useful remedy. resolved when both
paths show the instruction already owned by `extension/nexusClient.ts`, and
prior uncertainty is retained rather than called a refused first save.
