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
actual utterances and editor focus were inspected. lab
`20261028-191018-5dbb16ae28cc` also lost `emulator-5620` during media navigation;
qemu pid `92289` remained alive and adb reconnected with transport id `28`.

a separate server failure occurred during reverse removal in lab
`20261028-203021-83cc2c784348`: adb 37.0.0 aborted with
`adb.cpp:525 handle_packet disallowed connect`, then cleanup reported
`ADB server didn't ACK`. the same fatal preceded exits at 19:40:35 and 20:09:13.

the lab now retains the reverse while cutting its proxy and stops the owned
package before removing routes. labs `20261028-205116-98984ad72240` and
`20261028-210023-f579dab11c66` completed the relevant offline restart and
cleanup without this fatal. the removed reverse target was not logged in the
failing run, so its exact relation to the fatal is inferred. earlier device
transport losses on `emulator-5620` remain unexplained. investigate those
separately before declaring the entire issue resolved. do not reset the shared
adb server or alter unowned devices. resolved when the cause is identified and normal isolated
native qualification and owned cleanup complete without transport loss.
