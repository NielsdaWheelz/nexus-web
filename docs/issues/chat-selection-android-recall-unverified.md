# android chat selection recall

account memory uses the shared web composer, but android process restart and
recall still need native qualification. chromium profiles do not establish that.

2026-10-28: the sdk's adb can reach `emulator-5584` (`nexus-api35`), but no matching
owned disposable apk/package was available for the isolated lab origin and ca.
the installed debug and qa packages belong to other sessions and were untouched.

resolve with `openLabAndroid` and an explicitly owned matching package: admit
astra/max, restart without clearing app data, open a fresh chat and verify the
recalled tuple and next saved run. follow the paired release steps in
`release-chat-generation-controls.md`.
