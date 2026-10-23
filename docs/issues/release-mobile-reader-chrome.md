# deployed mobile reader chrome qualification

production source `400e7039e` is deployed at schema `0312`, wire `14`, paired with
signed android `0.3.6` (code `26`). physical-device smoke verified retained login
and reader state, the compact menu, tap-only chrome and return from downloads.
this was a same-package installation without clearing storage. existing copies
need no redownload for layout changes.

remaining activated-phone journeys are `NOT_RUN`: text/pdf tap and endpoint
boundaries, selection, find/keyboard, player clearance and persistent feedback.
report physical/emulator and gesture/three-button evidence separately; the smoke
check does not qualify those boundaries. app-link selection is tracked
[separately](android-app-link-default-selection.md).

resolve after these journeys pass or receive an explicit owner disposition;
record proof in the release pr. [reader](../modules/reader-implementation.md) and
[player](../modules/player.md) own the permanent contracts.
