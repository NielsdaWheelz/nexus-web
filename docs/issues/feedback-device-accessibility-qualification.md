# qualify feedback on a physical phone

physical-phone soft-keyboard/safe-area behavior at enlarged text remains unrun.
browser viewport checks and an android emulator cannot prove physical-device
input and protection geometry. no physical-device defect is established.

the installed app on webview 155 passed real emulator ime suppression, keyboard
dismissal, retained undo and activity bounds at `d42cf6dd6`. physical hardware
and enlarged-text safe-area behavior still need their own observation.

owners: `components/feedback/{Slips,Feedback}.tsx`,
`lib/mobileShell/viewport.tsx`, `components/ui/SurfaceHeader.tsx`.

on a supported physical phone, exercise unresolved held rows and plain slips
with hidden reader chrome, enlarged text and the real keyboard. check safe-area
clearance, tucked recovery and withdrawal focus in workspace, shelf and capture.
include backdrop placement and the constrained-modal content exception; fixed
action controls must stay clear.
feedback must not move the player/reader or reveal controls.
spoken qualification is tracked in `workspace-feedback-repeat-announcement.md`.

resolved when the current build passes those interactions, recording exact
build/platform and any observed defect in its own issue. do not replace this
with a simulated-browser pass.
