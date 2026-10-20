# action menus physical handset qualification

problem: the primary physical android handset is disconnected for the night.
browser and isolated emulator checks cannot establish physical swipe/native back
or spoken screen-reader behavior for the action-menu cutover.

evidence: owner confirmation, 2026-10-20: phone disconnected for the night.
`adb devices -l` lists only `emulator-5580` and `emulator-5584` at task start.
those devices belong to other tasks; qualification must use an isolated device.

qualification: after connecting the primary handset, check complete menu opening,
title/close announcements, keyboard focus, long-list scrolling, close/scrim/back,
header swipe/cancel, reduced motion and guarded nested sheet/dialog handoffs.
record served source/artifact, device/webview and screen reader, actual outcomes
and remaining platform limits in the implementation pr.

resolved when these checks pass on the primary supported physical handset and
configured screen reader. emulator results must remain separately identified.
