# owned android emulator exited during qualification

the disposable `nexus-recent-task` emulator on `emulator-5554` exited before
lab `20261028-204748-150a7f2451e8` could start its cases. adb logged the
transport read failure at 20:47:44; its server pid 60995 remained alive, while
qemu pid 53542 was gone. the previous emulator's configured avd root and exit
log were not retained, so the cause is unknown. a fresh task-owned avd has a
separate root and captured emulator log. resolve by identifying the exit cause
and completing isolated native qualification without an unexplained emulator exit.

a later occurrence on source `cd7d935b`, run
`20261103-153527-380476719d8f`, used the existing `nexus-api34` avd with
read-only, no-snapshot flags and a captured emulator log. boot and apk build
completed, then qemu pid 39594 and crash reporter pid 39599 disappeared.
`apps/web/scripts/lab/android.ts:34` failed on `adb -s emulator-5620 reverse
--list`, before transport creation, package installation or any app journey.
the driver returned 125 after its conservative uninstall attempt also found
no device. exact process, serial and forward checks found no recorded resource
remaining; canonical services were retired. this reconciles ownership, not
normal native cleanup.

the retained log ends with a netsim socket closure and crash reporter warnings;
neither identifies the cause. no common cause with the earlier occurrence,
chrome crash dialogs or adb transport resets is established. all six app
journeys remained unrun. an unchanged retry may qualify those journeys but
does not resolve this unexplained emulator exit.

on 2026-11-24, `nexus-notes-home-api34` on `emulator-5554` completed boot
and exposed webview `113.0.5672.136`, then exited 134 while the notes-home
lab waited for capacity. emulator `36.5.10.0` selected software graphics.
`qemu-system-aarch64-headless-2026-11-24-022720.ips` records pid 81548,
sigabrt and `std::__throw_bad_function_call` on a grpc completion queue.
the same stack aborted pid 17350 under host graphics in
`qemu-system-aarch64-headless-2026-11-24-024109.ips`. the app journey had yet to
start. the invalid callback's cause is open.
