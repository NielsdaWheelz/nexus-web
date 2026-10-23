# compact actions: device qualification

the compact-actions cutover requires a supported physical handset check. browser
emulation does not establish native file-picker, touch focus or spoken feedback.

on 2026-10-22, `adb devices -l` showed only `emulator-5586` and `emulator-5596`
(`sdk_gphone64_arm64`). the owner will connect a handset. no device acceptance is
claimed yet.

resolve after checking compact media/import overflow, one activation per tap,
upload file selection/cancellation, chooser return after width changes and
reachable controls on a supported handset. record browser, handset and spoken
accessibility separately; remove this issue only when the required device proof
exists.
