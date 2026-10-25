# android lab transport resets during native qualification

problem: the task android 35 emulator intermittently loses its adb transport
while playwright navigates chrome, closing page/cdp connections and dropping
the task's reverse mapping before the product assertions run. native qualification
becomes unreliable; cleanup errors can obscure the original navigation error.
the icon change's required checks ultimately passed; this transport cause remains
an independent tooling follow-up.

evidence: private lab `20261025-092007-bfc482c4658a`, `artifacts/native-final`
and `artifacts/native-talkback-4`; target/page closed on media navigation, then
adb offline. host adb pid stayed `19086`; task emulator `emulator-5580` uptime
continued and transport id changed from 5 to 6. the installed app passed alone
in `artifacts/native-app` (21 seconds). standard emulator tcp debugging then
qualified talkback in `artifacts/native-talkback-9` and `native-talkback-11`;
actual utterances and editor focus were inspected. cause remains unproven; no
product selection failure follows from these transport errors.

investigate guest/browser/transport logs and ensure each temporary case retires
its own chrome tabs and driver state. do not reset the shared adb server or
alter unowned devices. resolved when the cause is identified and normal isolated
native qualification and owned cleanup complete without transport loss.
